#!/bin/sh
set -eu
SOURCE_PATH=$0
while [ -L "$SOURCE_PATH" ]; do
  LINK_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE_PATH")" && pwd)
  LINK_TARGET=$(readlink "$SOURCE_PATH")
  case "$LINK_TARGET" in
    /*) SOURCE_PATH=$LINK_TARGET ;;
    *) SOURCE_PATH=$LINK_DIR/$LINK_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE_PATH")" && pwd)
exec "${UFO_BROWSER_NODE:-${X_BROWSER_NODE:-node}}" "$SCRIPT_DIR/../agent/ufo-browser.js" "$@"
