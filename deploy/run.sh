#!/bin/sh
# Builds and (re)starts Forge AIOS in server mode. Run from the repo root on the server.
# Settings (FORGE_PROJECT, FORGE_API_TOKEN, NTFY_*, FORGE_PUBLIC_URL, GIT_*_EMAIL) live in ~/.config/forge-aios/env, outside the repo.
# Host networking: the CLI reaches the hook endpoint on 127.0.0.1, and the server reaches a local ntfy, if you run one.
# The server's gh login is mounted read only, for cloning projects and wikis (and git commands you approve).
#
# Each build is tagged with its commit; the one it replaces stays as forge-aios:previous, so deploy/rollback.sh can go back.
set -e
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
docker build -t "forge-aios:$sha" .
if docker image inspect forge-aios:current >/dev/null 2>&1; then docker tag forge-aios:current forge-aios:previous; fi
docker tag "forge-aios:$sha" forge-aios:current
exec "$(dirname "$0")/start.sh" forge-aios:current
