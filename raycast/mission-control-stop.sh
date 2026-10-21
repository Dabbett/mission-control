#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Stop Mission Control
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🛑
# @raycast.packageName Mission control
# @raycast.description Stop the mission control background server.

exec "$HOME/.local/bin/mc" stop
