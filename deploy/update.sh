#!/usr/bin/env bash
# Пересобрать и перезапустить сервер и клиент из папок на сервере. Вызывается из push.sh и setup.sh:
#   bash deploy/update.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ -f "$ENV_FILE" ] || die "нет $ENV_FILE — сначала bash deploy/setup.sh <домен>"
[ -d "$PROTO_DIR/src/core" ] || die "рядом нет прототипа ($PROTO_DIR)"

echo "== Проверяю, что логика сервера совпадает с прототипом"
docker run --rm -v "$ROOT_DIR:/w:ro" node:22-alpine \
  node /w/CTG-Proto-Backend/scripts/sync-core.mjs --check /w/CTG-Proto ||
  die "src/shared расходится с прототипом: на рабочей машине npm run sync-core, коммит, снова push.sh"

echo "== Собираю и запускаю"
compose build
# nakama и web пересоздаются всегда: папка репозитория при выкладке подменяется, а Caddyfile примонтирован из неё
compose up -d --remove-orphans
compose up -d --force-recreate --no-deps nakama web

echo "== Жду сервер"
DOMAIN=$(env_value DOMAIN)
GAME_PATH=$(env_value GAME_PATH)
GAME_PATH=${GAME_PATH:-/ctg}
ok=""
for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q nakama)" 2>/dev/null)" = healthy ]; then
    ok=1
    break
  fi
  sleep 2
done
[ -n "$ok" ] || {
  compose logs --tail 40 nakama
  die "Nakama не поднялась — лог выше"
}
compose logs nakama 2>/dev/null | grep -m1 -o 'CTG-Proto-Backend [^"]*' || true

# снаружи: сертификат выдаётся при первом обращении, на это уходит до минуты
case "$DOMAIN" in
  :*) URL="http://127.0.0.1$DOMAIN" ;;
  http://*) URL="$DOMAIN" ;;
  *) URL="https://$DOMAIN" ;;
esac
ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 5 "$URL$GAME_PATH/healthcheck" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 3
done
if [ -n "$ok" ]; then
  echo "== $URL$GAME_PATH/ отвечает"
else
  echo "!! $URL$GAME_PATH/healthcheck не отвечает. Проверь: A-запись домена указывает на этот сервер, порты 80 и 443 открыты."
  echo "   Порты заняты другим сервером (старый Caddy игры)? Останови его: docker ps, docker stop <имя>."
  echo "   Лог Caddy: docker compose --env-file $ENV_FILE -f $BACKEND_DIR/docker-compose.prod.yml logs web"
fi

docker image prune -f >/dev/null 2>&1 || true
