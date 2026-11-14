#!/usr/bin/env bash
# Первая настройка сервера (Linux, от root). Запускается один раз, после deploy/push.sh:
#   bash deploy/setup.sh <домен> [--debug]
# Ставит Docker, создаёт ../.env с секретами, поднимает сервер, включает ежедневные дампы базы.
# Повторный запуск безопасен: секреты не меняются, обновляются только домен и режим отладки.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

DOMAIN=""
DEBUG=""
for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG=true ;;
    --no-debug) DEBUG=false ;;
    -*) die "неизвестный параметр $arg" ;;
    *) DOMAIN=$arg ;;
  esac
done

[ "$(id -u)" = 0 ] || die "нужен root (sudo bash deploy/setup.sh …)"
[ -d "$PROTO_DIR/src/core" ] || die "рядом нет прототипа ($PROTO_DIR) — сначала deploy/push.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "== Ставлю Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "нет docker compose (нужен Docker с плагином compose)"

secret() {
  # только hex: значение попадает в адрес базы и в аргументы запуска
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
}

set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >>"$ENV_FILE"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  [ -n "$DOMAIN" ] || die "укажи домен: bash deploy/setup.sh play.example.com"
  echo "== Создаю $ENV_FILE"
  umask 077
  cat >"$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
CTG_DEBUG=${DEBUG:-false}
POSTGRES_PASSWORD=$(secret)
SERVER_KEY=$(secret)
HTTP_KEY=$(secret)
SESSION_KEY=$(secret)
REFRESH_KEY=$(secret)
CONSOLE_USER=admin
CONSOLE_PASSWORD=$(secret)
CONSOLE_SIGNING_KEY=$(secret)
ENV
else
  echo "== $ENV_FILE уже есть — секреты не трогаю"
  [ -z "$DOMAIN" ] || set_env DOMAIN "$DOMAIN"
  [ -z "$DEBUG" ] || set_env CTG_DEBUG "$DEBUG"
fi
chmod 600 "$ENV_FILE"

mkdir -p "$BACKUP_DIR"
CRON=/etc/cron.d/ctg-proto-backup
if [ -d /etc/cron.d ]; then
  echo "17 4 * * * root bash $BACKEND_DIR/deploy/backup.sh >>$BACKUP_DIR/backup.log 2>&1" >"$CRON"
  chmod 644 "$CRON"
  echo "== Дампы базы: каждый день в 04:17 → $BACKUP_DIR"
else
  echo "== Нет /etc/cron.d — дампы базы по расписанию не включены (вручную: bash deploy/backup.sh)"
fi

# порты 80/443 должны быть свободны или заняты нашим же Caddy
OURS=$(compose ps -q web 2>/dev/null || true)
if [ -z "$OURS" ]; then
  BUSY=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E '(0\.0\.0\.0|\[::\]):(80|443)->' | cut -d' ' -f1 | sort -u | tr '\n' ' ' || true)
  [ -z "$BUSY" ] || die "порты 80/443 заняты контейнером: $BUSY— останови его (docker stop $BUSY) и запусти setup.sh снова"
fi

bash "$BACKEND_DIR/deploy/update.sh"

HOST=$(env_value DOMAIN)
GAME_PATH=$(env_value GAME_PATH)
GAME_PATH=${GAME_PATH:-/ctg}
cat <<INFO

Готово.
  Игра:     https://$HOST$GAME_PATH/
  Консоль:  https://$HOST/
            логин $(env_value CONSOLE_USER), пароль $(env_value CONSOLE_PASSWORD)
  Отладка:  CTG_DEBUG=$(env_value CTG_DEBUG) (сменить: bash deploy/setup.sh --debug | --no-debug)
  Секреты:  $ENV_FILE
INFO
