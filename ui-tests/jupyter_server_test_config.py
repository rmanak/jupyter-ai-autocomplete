"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"

# galata binds to 0.0.0.0 with auth disabled; never expose that beyond localhost.
c.ServerApp.ip = "127.0.0.1"

# Keep clear of a personal JupyterLab on the default 8888.
c.ServerApp.port = 8898
c.ServerApp.port_retries = 0
