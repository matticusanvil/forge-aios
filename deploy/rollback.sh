#!/bin/sh
# Goes back to the image before the last deploy (forge-aios:previous). Data and sessions are untouched.
set -e
docker image inspect forge-aios:previous >/dev/null 2>&1 || { echo "No previous image to roll back to."; exit 1; }
docker tag forge-aios:previous forge-aios:current
exec "$(dirname "$0")/start.sh" forge-aios:current
