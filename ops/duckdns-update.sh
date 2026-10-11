#!/usr/bin/env bash
# Keep DuckDNS pointed at this VM's public IPv4.
# Install: /etc/bismillah/duckdns.env (mode 0600) with DUCKDNS_SUB and DUCKDNS_TOKEN.
# Cron (as root): */5 * * * * /opt/bismillah/current/ops/duckdns-update.sh
set -euo pipefail

# shellcheck disable=SC1091
source /etc/bismillah/duckdns.env

if [ -z "${DUCKDNS_SUB:-}" ] || [ -z "${DUCKDNS_TOKEN:-}" ]; then
  echo "duckdns: DUCKDNS_SUB and DUCKDNS_TOKEN must be set in /etc/bismillah/duckdns.env" >&2
  exit 1
fi

url="https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip="
resp="$(curl -fsS --max-time 20 "$url" || true)"
if [ "$resp" != "OK" ]; then
  echo "duckdns update failed: ${resp:-empty}" >&2
  exit 1
fi
