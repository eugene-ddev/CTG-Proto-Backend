#!/usr/bin/env bash
# Дамп базы в ../backups (по расписанию из setup.sh или вручную). Хранится 14 последних.
#   bash deploy/backup.sh
# Восстановление (сервер остановлен, база пустая):
#   gunzip -c backups/nakama-….sql.gz | docker compose … exec -T postgres psql -U postgres nakama
set -euo pipefail
. "$(dirname "$0")/lib.sh"

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/nakama-$(date +%Y%m%d-%H%M%S).sql.gz"
compose exec -T postgres pg_dump -U postgres nakama | gzip >"$FILE.part"
mv "$FILE.part" "$FILE"
ls -1t "$BACKUP_DIR"/nakama-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "$(date '+%F %T') $FILE ($(du -h "$FILE" | cut -f1))"
