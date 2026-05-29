#!/bin/bash
set -e

WORKDIR="${WORKDIR:-/home/sandbox/project}"
TEMPLATE_DIR="/opt/template"

# If the project directory is empty, copy template files into it
if [ -d "$TEMPLATE_DIR" ] && [ "$(ls -A $TEMPLATE_DIR 2>/dev/null)" ]; then
  if [ ! "$(ls -A $WORKDIR 2>/dev/null)" ]; then
    echo "[entrypoint] Copying template to $WORKDIR"
    cp -a "$TEMPLATE_DIR/." "$WORKDIR/"
  fi
fi

echo "[entrypoint] Starting sidecar agent"
exec env NODE_ENV=production node /opt/agent/dist/server.js
