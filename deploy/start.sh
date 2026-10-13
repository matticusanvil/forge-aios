#!/bin/sh
# (Re)starts the forge-aios container from an image: deploy/start.sh forge-aios:current
set -e
image="${1:-forge-aios:current}"
docker rm -f forge-aios >/dev/null 2>&1 || true
# KVM, for hardware-accelerated emulators (the Android emulator): pass the device through, with the host's kvm group.
kvm=""
if [ -e /dev/kvm ]; then kvm="--device /dev/kvm --group-add $(stat -c %g /dev/kvm)"; fi
# The server's Android SDK (emulator, platform-tools, system image), read only: android-emulator runs Forge's own AVD on it.
sdk=""
if [ -d "$HOME/android-sdk" ]; then sdk="-v $HOME/android-sdk:/opt/android-sdk:ro"; fi
# shellcheck disable=SC2086
docker run -d --name forge-aios --restart unless-stopped --network host \
  --env-file "$HOME/.config/forge-aios/env" \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v forge-aios-home:/home/node \
  -v "$HOME/.config/gh:/home/node/.config/gh:ro" \
  -v /srv/repos:/srv/repos \
  -v forge-aios-data:/data \
  $kvm $sdk \
  "$image"
