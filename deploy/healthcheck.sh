#!/usr/bin/env bash
# Слежение за сервером: cron каждую минуту (ставит update.sh при выкладке). Пишет в Telegram, когда игра перестаёт
# работать (снаружи через Caddy не отвечает или не отвечает база) и когда восстанавливается; предупреждает, когда
# кончается место на диске. Бот и чат — TG_BOT_TOKEN, TG_CHAT_ID в .env (из окружения GitHub); без них — молчит.
#   bash deploy/healthcheck.sh          — проверка (сообщение — только когда состояние изменилось)
#   bash deploy/healthcheck.sh --test   — проверочное сообщение
set -uo pipefail
. "$(dirname "$0")/lib.sh"

TOKEN=$(env_value TG_BOT_TOKEN)
CHAT=$(env_value TG_CHAT_ID)
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  # проверочное сообщение — явная ошибка (иначе выкладка решит, что всё отправлено); по расписанию — молча
  [ "${1:-}" = "--test" ] || exit 0
  echo "Telegram не настроен: нет ${TOKEN:+}$([ -n "$TOKEN" ] || echo "TG_BOT_TOKEN ")$([ -n "$CHAT" ] || echo "TG_CHAT_ID")" >&2
  exit 1
fi

STATE="$ROOT_DIR/.health"
mkdir -p "$STATE"
URL=$(game_url)

send() {
  local reply
  reply=$(curl -sS --max-time 15 "https://api.telegram.org/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$1" 2>&1)
  case "$reply" in
    *'"ok":true'*) return 0 ;;
    *)
      # ответ Telegram с причиной: неверный токен, chat not found (боту не писали /start) и т. п.
      echo "Telegram не принял сообщение: $(printf '%s' "$reply" | cut -c1-200)" >&2
      return 1
      ;;
  esac
}

if [ "${1:-}" = "--test" ]; then
  send "✅ CTG: уведомления подключены. Слежу за $URL/ — напишу, если игра или база перестанут отвечать."
  exit
fi

# идёт выкладка — сервер перезапускается, не проверяем
exec 9>"$ROOT_DIR/.deploy.lock"
flock -n 9 || exit 0
flock -u 9

# --- игра: через Caddy (на этот же сервер, мимо DNS) до Nakama и базы ---
domain=$(env_value DOMAIN)
resolve=()
case "$domain" in
  :* | http://*) ;;
  *) resolve=(--resolve "$domain:443:127.0.0.1") ;;
esac
answer=$(curl -sS --max-time 10 "${resolve[@]}" "$URL/v2/rpc/system%2Fping?http_key=$(env_value HTTP_KEY)&unwrap" -d '{"db":true}' 2>&1)
case "$answer" in
  *'"db":true'*) problem="" ;;
  *'"db":'*) problem="база не отвечает: $(printf '%s' "$answer" | sed 's/.*"db":"//; s/"}$//; s/\\n.*//' | cut -c1-200)" ;;
  *) problem="не отвечает: $(printf '%s' "$answer" | tr '\n' ' ' | cut -c1-200)" ;;
esac

now=$(date +%s)
prev=$(cat "$STATE/state" 2>/dev/null || echo up)
fails=$(cat "$STATE/fails" 2>/dev/null || echo 0)

if [ -z "$problem" ]; then
  if [ "$prev" = down ]; then
    since=$(cat "$STATE/since" 2>/dev/null || echo "$now")
    send "🟢 CTG снова работает ($URL/). Простой — $(((now - since + 59) / 60)) мин." && echo up >"$STATE/state"
  else
    echo up >"$STATE/state"
  fi
  echo 0 >"$STATE/fails"
else
  fails=$((fails + 1))
  echo "$fails" >"$STATE/fails"
  [ "$fails" -eq 1 ] && echo "$now" >"$STATE/since"
  # две проверки подряд (2 минуты) — не поднимать тревогу из-за одного сбоя сети
  if [ "$prev" = up ] && [ "$fails" -ge 2 ]; then
    containers=$(compose ps -a --format '{{.Service}}: {{.Status}}' 2>/dev/null | tr '\n' ';' | sed 's/;$//; s/;/; /g')
    send "🔴 CTG не работает ($URL/)
$problem
Контейнеры: ${containers:-?}
Свободно на диске: $(free_mb) МБ" && echo down >"$STATE/state"
  fi
fi

# --- место на диске (тревога — меньше 2 ГБ, отбой — больше 3 ГБ) ---
disk=$(cat "$STATE/disk" 2>/dev/null || echo ok)
mb=$(free_mb)
if [ "$disk" = ok ] && [ "$mb" -lt 2048 ]; then
  send "🟠 CTG: на диске осталось $mb МБ. Когда место кончится, упадёт Postgres. Что занято: docker system df" && echo low >"$STATE/disk"
elif [ "$disk" = low ] && [ "$mb" -gt 3072 ]; then
  send "🟢 CTG: место на диске освободилось — $mb МБ." && echo ok >"$STATE/disk"
fi
