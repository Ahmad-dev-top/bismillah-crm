#!/usr/bin/env bash
set -euo pipefail
SRC='/home/ubuntu/bismillah-crm/Bismillah Netwoks/Pakistan Bismillah.xlsx'
DEST=/var/lib/bismillah/imports/Pakistan-Bismillah.xlsx
cp "$SRC" "$DEST"
chown bismillah:bismillah "$DEST"
export PATH=/usr/local/lib/nodejs/bin:/usr/bin:$PATH
cd /opt/bismillah/current
sudo -u bismillah env PATH="$PATH" HOME=/opt/bismillah \
  node --env-file=/etc/bismillah/api.env --experimental-strip-types \
  scripts/import-customers.ts "$DEST" "$@"
