"""Fill-in-the-middle prompt templates for raw ``/v1/completions`` endpoints.

The formats and stop tokens follow Continue's
core/autocomplete/templating/AutocompleteTemplate.ts (Apache-2.0,
https://github.com/continuedev/continue), with the model-name routing simplified.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_PLACEHOLDER = re.compile(r"\{prefix\}|\{suffix\}")


@dataclass(frozen=True)
class FimTemplate:
    name: str
    fmt: str  # uses {prefix} and {suffix}
    stop: tuple[str, ...]

    def render(self, prefix: str, suffix: str) -> str:
        # Single-pass substitution, not str.format: code is full of braces and may
        # even contain the literal text "{suffix}".
        values = {"{prefix}": prefix, "{suffix}": suffix}
        return _PLACEHOLDER.sub(lambda m: values[m.group(0)], self.fmt)


TEMPLATES: dict[str, FimTemplate] = {t.name: t for t in [
    # Qwen2.5-Coder / Qwen3-Coder (same special tokens)
    FimTemplate("qwen", "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>",
                ("<|endoftext|>", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>",
                 "<|fim_pad|>", "<|repo_name|>", "<|file_sep|>", "<|im_start|>", "<|im_end|>")),
    # StarCoder / StarCoder2 / StableCode / CodeQwen1.5
    FimTemplate("starcoder", "<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>",
                ("<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>", "<|endoftext|>")),
    FimTemplate("deepseek", "<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>",
                ("<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>")),
    FimTemplate("codestral", "[SUFFIX]{suffix}[PREFIX]{prefix}", ("[PREFIX]", "[SUFFIX]")),
    FimTemplate("codellama", "<PRE> {prefix} <SUF>{suffix} <MID>",
                ("<PRE>", "<SUF>", "<MID>", "<EOT>")),
    FimTemplate("codegemma", "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>",
                ("<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|file_separator|>",
                 "<end_of_turn>", "<eos>")),
    FimTemplate("granite", "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>",
                ("<|end_of_text|>", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>",
                 "<|fim_pad|>")),
]}


def template_for_model(model: str) -> FimTemplate:
    """Pick a template from the model name (first match wins; order matters)."""
    m = model.lower()
    if "codestral" in m:
        return TEMPLATES["codestral"]
    if "codegemma" in m:
        return TEMPLATES["codegemma"]
    if "codellama" in m or "code-llama" in m:
        return TEMPLATES["codellama"]
    if "deepseek" in m:
        return TEMPLATES["deepseek"]
    if "granite" in m:
        return TEMPLATES["granite"]
    if "codeqwen" in m or "starcoder" in m or "star-coder" in m or "stable" in m:
        return TEMPLATES["starcoder"]
    if "qwen" in m:
        return TEMPLATES["qwen"]
    # Continue's fallback is the StarCoder format; Qwen-coder is the more common
    # local FIM model today, so we default to it instead.
    return TEMPLATES["qwen"]


def resolve_template(name: str, model: str) -> FimTemplate:
    if name and name != "auto":
        try:
            return TEMPLATES[name]
        except KeyError:
            raise ValueError(f"Unknown template {name!r}; available: auto, {', '.join(TEMPLATES)}")
    return template_for_model(model)


# Prompt for chat-only models (e.g. instruct models, hosted APIs). This is a short,
# original take on the "hole filler" idea Continue uses for GPT/Claude models.
CHAT_SYSTEM = (
    "You are a code completion engine inside a Jupyter notebook. The user sends a Python "
    "notebook (cells separated by `# %%`, markdown cells as `#` comments) containing exactly "
    "one {{FILL_HERE}} marker at the cursor. Reply with ONLY the text that should replace the "
    "marker, wrapped in <COMPLETION></COMPLETION> tags. Do not repeat code before or after the "
    "marker. Keep the indentation correct for the cursor position. If the line is mid-way, "
    "complete just that line. No explanations, no markdown fences."
)


def chat_user_message(prefix: str, suffix: str, multiline: bool) -> str:
    hint = "" if multiline else "\n\n(Complete only the current line.)"
    return f"<QUERY>\n{prefix}{{{{FILL_HERE}}}}{suffix}\n</QUERY>{hint}"


def extract_completion(text: str) -> str:
    """Return the text inside <COMPLETION> tags, tolerating a missing closing tag."""
    start = text.find("<COMPLETION>")
    if start < 0:
        return text
    body = text[start + len("<COMPLETION>"):]
    end = body.find("</COMPLETION>")
    return body if end < 0 else body[:end]
