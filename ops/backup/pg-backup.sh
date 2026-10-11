#!/usr/bin/env bash
# Nightly PostgreSQL backup with off-box copy and verified restore path.
# Cron: 0 2 * * *  /opt/bismillah/ops/backup/pg-backup.sh
set -euo pipefail

DB="${PGDATABASE:-bismillah}"
DEST="/var/backups/bismillah"
STAMP="$(TZ=Asia/Karachi date +%Y%m%d-%H%M)"
FILE="$DEST/${DB}-${STAMP}.dump"
RETAIN_DAYS=30

mkdir -p "$DEST"

# Custom format: compressed, and restorable table-by-table with pg_restore.
pg_dump --format=custom --compress=9 --file="$FILE" "$DB"

# A backup that has never been read is not a backup. Verify the archive's
# table of contents before trusting it.
pg_restore --list "$FILE" > /dev/null

sha256sum "$FILE" > "$FILE.sha256"

# Off-box copy. A backup on the same disk as the database does not survive
# the failure it exists for. Configure OCI Object Storage or rclone here.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$FILE" "$BACKUP_REMOTE" --quiet
  rclone copy "$FILE.sha256" "$BACKUP_REMOTE" --quiet
fi

find "$DEST" -name "${DB}-*.dump*" -mtime "+${RETAIN_DAYS}" -delete

echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
