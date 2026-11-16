# Общее для скриптов выкладки (подключается через «. lib.sh»).
# Раскладка на сервере:
#   <корень>/.env                 — секреты и настройки (вне репозиториев, выкладка его не трогает)
#   <корень>/backups/             — дампы базы
#   <корень>/CTG-Proto            — прототип, git-клон (из него собирается клиент)
#   <корень>/CTG-Proto-Backend    — сервер, git-клон
BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT_DIR=$(cd "$BACKEND_DIR/.." && pwd)
PROTO_DIR="$ROOT_DIR/CTG-Proto"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_DIR="$ROOT_DIR/backups"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$BACKEND_DIR/docker-compose.prod.yml" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"
}

# Настройки, которые можно задать из GitHub (окружение production, см. deploy/github-env.sh).
# POSTGRES_PASSWORD — только на сервере: Postgres берёт пароль один раз, при создании базы.
GITHUB_ENV_KEYS="DOMAIN GAME_PATH CTG_DEBUG CONSOLE_USER CONSOLE_PASSWORD CONSOLE_SIGNING_KEY SERVER_KEY HTTP_KEY SESSION_KEY REFRESH_KEY"

# KEY=VALUE в .env (значение — в одинарных кавычках: docker compose не подставляет в нём $)
put_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp "$ENV_FILE.XXXX")
  grep -v "^$key=" "$ENV_FILE" >"$tmp" || true
  printf "%s='%s'\n" "$key" "$value" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
