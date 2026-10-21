#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Mission Control
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🛰️
# @raycast.packageName Mission control
# @raycast.description Start the mission control dashboard if needed and open it in the browser.

# Raycast runs this without a shell profile; mc finds node through fnm on its own.
exec "$HOME/.local/bin/mc" open
