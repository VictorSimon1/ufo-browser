#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${X_BROWSER_NODE:-node}" "$SCRIPT_DIR/../agent/x-browser.js" "$@"
