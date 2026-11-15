"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"

# Keep clear of a personal JupyterLab on the default 8888.
c.ServerApp.port = 8898
c.ServerApp.port_retries = 0
