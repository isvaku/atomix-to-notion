#!/bin/sh
# Starts a virtual display for Chromium (Cloudflare blocks headless mode), then runs the app.
set -e

DISPLAY_NUMBER="${DISPLAY#:}"
mkdir -p /tmp/.X11-unix
rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp >/dev/null 2>&1 &

i=0
while [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUMBER}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "Xvfb did not start" >&2
    exit 1
  fi
  sleep 0.2
done

exec "$@"
