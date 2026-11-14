# Общее для скриптов выкладки (подключается через «. lib.sh»).
# Раскладка на сервере:
#   <корень>/.env                 — секреты и настройки (вне репозиториев, выкладка его не трогает)
#   <корень>/backups/             — дампы базы
#   <корень>/CTG-Proto            — прототип (из него собирается клиент)
#   <корень>/CTG-Proto-Backend    — сервер
BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT_DIR=$(cd "$BACKEND_DIR/.." && pwd)
PROTO_DIR="$ROOT_DIR/CTG-Proto"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_DIR="$ROOT_DIR/backups"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$BACKEND_DIR/docker-compose.prod.yml" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
