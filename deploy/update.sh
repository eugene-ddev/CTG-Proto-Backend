#!/usr/bin/env bash
# Пересобрать и перезапустить сервер и клиент из папок на сервере (без git pull). Вызывается из pull.sh и setup.sh:
#   bash deploy/update.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ -f "$ENV_FILE" ] || die "нет $ENV_FILE — сначала bash deploy/setup.sh <домен>"
[ -d "$PROTO_DIR/src/core" ] || die "рядом нет прототипа ($PROTO_DIR)"

echo "== Проверяю, что логика сервера совпадает с прототипом"
docker run --rm -v "$ROOT_DIR:/w:ro" node:22-alpine \
  node /w/CTG-Proto-Backend/scripts/sync-core.mjs --check /w/CTG-Proto ||
  die "src/shared расходится с прототипом: на рабочей машине npm run sync-core, коммит и push в CTG-Proto-Backend"

# сборка идёт на сервере: кэш и образы копятся. Мало места — Postgres падает (16.11.2026)
free_mb() { df -Pm "$ROOT_DIR" | awk 'NR == 2 { print $4 }'; }
if [ "$(free_mb)" -lt 2048 ]; then
  echo "== Свободно $(free_mb) МБ — чищу кэш сборки и неиспользуемые образы"
  docker builder prune -af >/dev/null 2>&1 || true
  docker image prune -af >/dev/null 2>&1 || true
  echo "   свободно $(free_mb) МБ"
  [ "$(free_mb)" -ge 1024 ] || die "на диске меньше 1 ГБ — сборка не поместится, а Postgres может упасть. docker system df покажет, что занято"
fi

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
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q nakama)" 2>/dev/null)" = healthy ] &&
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q postgres)" 2>/dev/null)" = healthy ]; then
    ok=1
    break
  fi
  sleep 2
done
[ -n "$ok" ] || {
  compose ps -a
  compose logs --tail 20 postgres
  compose logs --tail 40 nakama
  die "Nakama или Postgres не поднялись — лог выше"
}
compose logs nakama 2>/dev/null | grep -m1 -o 'CTG-Proto-Backend [^"]*' || true

# снаружи — через Caddy до Nakama и базы (сертификат выдаётся при первом обращении, на это уходит до минуты)
case "$DOMAIN" in
  :*) URL="http://127.0.0.1$DOMAIN" ;;
  http://*) URL="$DOMAIN" ;;
  *) URL="https://$DOMAIN" ;;
esac
PING="$URL$GAME_PATH/v2/rpc/system%2Fping?http_key=$(env_value HTTP_KEY)&unwrap"
answer=""
for _ in $(seq 1 20); do
  answer=$(curl -fsS --max-time 5 "$PING" -d '{"db":true}' 2>/dev/null || true)
  case "$answer" in *'"db":true'*) break ;; esac
  sleep 3
done
case "$answer" in
  *'"db":true'*) echo "== $URL$GAME_PATH/ отвечает, база работает" ;;
  *'"db":'*)
    compose ps -a
    compose logs --tail 30 postgres
    die "Nakama отвечает, а база — нет: $answer"
    ;;
  *)
    echo "!! $URL$GAME_PATH/ не отвечает. Проверь: A-запись домена указывает на этот сервер, порты 80 и 443 открыты."
    echo "   Порты заняты другим сервером (старый Caddy игры)? Останови его: docker ps, docker stop <имя>."
    echo "   Лог Caddy: docker compose --env-file $ENV_FILE -f $BACKEND_DIR/docker-compose.prod.yml logs web"
    # первая настройка: домен и сертификат могут быть ещё не готовы — не обрываем setup.sh
    [ -n "${CTG_FIRST_RUN:-}" ] || exit 1
    ;;
esac

# после выкладки: висящие образы и кэш сборки старше двух суток (свежий — ускоряет следующую сборку)
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
echo "== Свободно на диске: $(free_mb) МБ"
