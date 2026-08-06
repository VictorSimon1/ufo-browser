#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${UFO_BROWSER_NODE:-${X_BROWSER_NODE:-node}}" "$SCRIPT_DIR/../agent/ufo-browser.js" "$@"
