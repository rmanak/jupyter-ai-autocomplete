/**
 * Completion cache plus a "type-through" check.
 *
 * - LRU keyed on (prefix, suffix-head), like Continue's AutocompleteLruCache.
 * - Type-through, a cheap version of Continue's GeneratorReuseManager: if the
 *   user types characters that match the completion currently shown, return
 *   the rest of that completion without asking the LLM again.
 */

export class CompletionCache {
  private _map = new Map<string, string>();
  private _last: {
    prefix: string;
    suffixHead: string;
    completion: string;
  } | null = null;

  constructor(private _capacity = 200) {}

  private static _key(prefix: string, suffix: string): string {
    // The prefix tail and suffix head are what matter; this keeps keys small.
    return prefix.slice(-2000) + '\u0000' + suffix.slice(0, 500);
  }

  get(prefix: string, suffix: string): string | undefined {
    const k = CompletionCache._key(prefix, suffix);
    const v = this._map.get(k);
    if (v !== undefined) {
      this._map.delete(k);
      this._map.set(k, v);
      return v;
    }
    return this._typeThrough(prefix, suffix);
  }

  put(prefix: string, suffix: string, completion: string): void {
    const k = CompletionCache._key(prefix, suffix);
    this._map.delete(k);
    this._map.set(k, completion);
    if (this._map.size > this._capacity) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) {
        this._map.delete(oldest);
      }
    }
    this._last = { prefix, suffixHead: suffix.slice(0, 500), completion };
  }

  private _typeThrough(prefix: string, suffix: string): string | undefined {
    const last = this._last;
    if (!last || suffix.slice(0, 500) !== last.suffixHead) {
      return undefined;
    }
    if (!prefix.startsWith(last.prefix)) {
      return undefined;
    }
    const typed = prefix.slice(last.prefix.length);
    if (!typed || !last.completion.startsWith(typed)) {
      return undefined;
    }
    const rest = last.completion.slice(typed.length);
    return rest.trim() ? rest : undefined;
  }
}
