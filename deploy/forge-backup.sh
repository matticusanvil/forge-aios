#!/bin/sh
# Nightly backup of Forge AIOS's data (project databases, rules defaults, sign-in file). Run by forge-backup.timer as root.
# Repos and wikis are git repos with GitHub remotes, and the Claude login can be redone, so they're not copied here.
#
# Writes one dated folder per run to $DEST; keeps $KEEP_DAYS days. Set OFFSITE to an rclone remote to copy it off-site too.
# Restore: stop the container, copy the folder's files into the forge-aios-data volume, start it again.
set -eu

DEST="${FORGE_BACKUP_DIR:-/var/backups/forge-aios}"
OFFSITE="${FORGE_BACKUP_OFFSITE:-}"
KEEP_DAYS=30
CONTAINER=forge-aios

stamp=$(date +%Y-%m-%d_%H%M%S)
log() { echo "$(date '+%F %T') $*"; }
fail() { log "FAILED: $*"; exit 1; }

# Backing up to a separate disk? Set FORGE_BACKUP_MOUNT so a missing disk fails loudly instead of filling the system disk.
if [ -n "${FORGE_BACKUP_MOUNT:-}" ]; then mountpoint -q "$FORGE_BACKUP_MOUNT" || fail "$FORGE_BACKUP_MOUNT is not mounted"; fi
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || fail "container $CONTAINER is not running"
mkdir -p "$DEST"

docker exec "$CONTAINER" node server/backup.ts "/data/.backup-$stamp" || fail "snapshot"
docker cp "$CONTAINER:/data/.backup-$stamp" "$DEST/$stamp" || fail "copy out"
docker exec "$CONTAINER" rm -rf "/data/.backup-$stamp"
log "Saved $DEST/$stamp ($(ls "$DEST/$stamp" | wc -l) files)"

if [ -n "$OFFSITE" ]; then
  rclone copy "$DEST/$stamp" "$OFFSITE/$stamp" || fail "off-site copy"
  log "Copied off-site to $OFFSITE/$stamp"
fi

find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
