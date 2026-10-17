#!/usr/bin/env bash
# Consistent online backup of the Lighthouse database, keeping the last 14 days.
# Optional off-site copy: set S3_URI (AWS) or AZ_CONTAINER_URL (Azure) in /etc/lighthouse/backup.env.
set -euo pipefail
# systemd's default PATH omits snap and /usr/local tools such as the AWS CLI and azcopy.
export PATH="$PATH:/usr/local/bin:/snap/bin"

DATA_DIR="${DATA_DIR:-/var/lib/lighthouse}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lighthouse}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Values in backup.env are exported so the aws / azcopy tools see them (keys, endpoint, region).
if [ -f /etc/lighthouse/backup.env ]; then set -a; . /etc/lighthouse/backup.env; set +a; fi

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
OUT="$BACKUP_DIR/lighthouse-$STAMP.db"

APP_DIR="${APP_DIR:-/opt/lighthouse}"
DATA_DIR="$DATA_DIR" node --disable-warning=ExperimentalWarning "$APP_DIR/scripts/backup.js" "$OUT"
gzip -9 "$OUT"
echo "Backup written: $OUT.gz"

if [ -n "${S3_URI:-}" ]; then
  aws s3 cp "$OUT.gz" "$S3_URI/" --only-show-errors && echo "Copied to $S3_URI"
fi
if [ -n "${AZ_CONTAINER_URL:-}" ]; then
  azcopy login --identity >/dev/null && azcopy copy "$OUT.gz" "$AZ_CONTAINER_URL/" --log-level=ERROR >/dev/null && echo "Copied to $AZ_CONTAINER_URL"
fi

find "$BACKUP_DIR" -name 'lighthouse-*.db.gz' -mtime +"$KEEP_DAYS" -delete
