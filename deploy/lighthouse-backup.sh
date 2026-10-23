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

# Files attached to tickets live next to the database, not inside it.
FILES_OUT="$BACKUP_DIR/attachments-$STAMP.tar.gz"
if [ -d "$DATA_DIR/attachments" ] && [ -n "$(ls -A "$DATA_DIR/attachments" 2>/dev/null)" ]; then
  tar -C "$DATA_DIR" -czf "$FILES_OUT" attachments && echo "Attachments written: $FILES_OUT"
fi

if [ -n "${S3_URI:-}" ]; then
  aws s3 cp "$OUT.gz" "$S3_URI/" --only-show-errors && echo "Copied to $S3_URI"
  [ -f "$FILES_OUT" ] && aws s3 cp "$FILES_OUT" "$S3_URI/" --only-show-errors
fi
if [ -n "${AZ_CONTAINER_URL:-}" ]; then
  azcopy login --identity >/dev/null && azcopy copy "$OUT.gz" "$AZ_CONTAINER_URL/" --log-level=ERROR >/dev/null && echo "Copied to $AZ_CONTAINER_URL"
  [ -f "$FILES_OUT" ] && azcopy copy "$FILES_OUT" "$AZ_CONTAINER_URL/" --log-level=ERROR >/dev/null
fi

find "$BACKUP_DIR" \( -name 'lighthouse-*.db.gz' -o -name 'attachments-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
