#!/usr/bin/env bash
# Выкладка: подтянуть main обоих репозиториев и пересобрать. Запускает GitHub Actions по SSH — ключ в
# authorized_keys разрешает только эту команду (см. bootstrap.sh). Вручную на сервере: bash deploy/pull.sh
# На вход (stdin) — строки KEY=VALUE из окружения GitHub: заданные значения записываются в ../.env,
# незаданные остаются как были. Две выкладки одновременно (push в обе репы) не пересекаются — вторая ждёт первую.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ENV_CHANGED=""

main() {
  local BRANCH=${CTG_BRANCH:-main}
  [ -f "$ENV_FILE" ] || die "нет $ENV_FILE — сначала deploy/bootstrap.sh <домен>"
  exec 9>"$ROOT_DIR/.deploy.lock"
  if ! flock -n 9; then
    echo "== Идёт другая выкладка — жду"
    flock -w 1200 9 || die "другая выкладка идёт больше 20 минут"
  fi

  # настройки из GitHub — во временный файл: применит уже обновлённый pull.sh (он знает новые ключи)
  local incoming="$ROOT_DIR/.deploy.env"
  (umask 077 && : >"$incoming")
  [ -t 0 ] || cat >"$incoming"

  local dir
  for dir in "$PROTO_DIR" "$BACKEND_DIR"; do
    [ -d "$dir/.git" ] || die "$dir — не git-клон; запусти deploy/bootstrap.sh"
    git -C "$dir" fetch -q --prune origin "$BRANCH"
    # клоны на сервере — только для выкладки: локальных правок там нет и не должно быть
    git -C "$dir" reset -q --hard "origin/$BRANCH"
    git -C "$dir" clean -q -fd
    echo "== $(basename "$dir"): $(git -C "$dir" log -1 --format='%h %s')"
  done

  # дальше — новой версией скрипта (блокировка — открытый дескриптор 9 — переходит к ней)
  exec bash "$BACKEND_DIR/deploy/pull.sh" --continue
}

# вторая половина выкладки: уже после git pull
finish() {
  local incoming="$ROOT_DIR/.deploy.env"
  [ -f "$incoming" ] && apply_env <"$incoming"
  rm -f "$incoming"

  bash "$BACKEND_DIR/deploy/update.sh"

  # уведомления в Telegram только что заданы или поменялись — проверочное сообщение
  case "$ENV_CHANGED" in
    *" TG_"*) bash "$BACKEND_DIR/deploy/healthcheck.sh" --test && echo "== Telegram: проверочное сообщение отправлено" ;;
  esac
}

apply_env() {
  local line key value any=""
  ENV_CHANGED=""
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [ -n "$line" ] || continue
    any=1
    key=${line%%=*}
    value=${line#*=}
    case " $GITHUB_ENV_KEYS " in
      *" $key "*) ;;
      *) continue ;; # прочие переменные и секреты окружения — не для сервера
    esac
    [ -n "$value" ] || continue
    # «-» — убрать настройку с сервера (например, выключить уведомления)
    if [ "$value" = "-" ]; then
      if grep -q "^$key=" "$ENV_FILE"; then
        grep -v "^$key=" "$ENV_FILE" >"$ENV_FILE.tmp" && chmod 600 "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
        ENV_CHANGED="$ENV_CHANGED -$key"
      fi
      continue
    fi
    case "$value" in
      *"'"*) die "$key: значение не должно содержать одинарную кавычку" ;;
    esac
    if [ "$(env_value "$key")" != "$value" ]; then
      put_env "$key" "$value"
      ENV_CHANGED="$ENV_CHANGED $key"
    fi
  done
  if [ -n "$ENV_CHANGED" ]; then
    echo "== Настройки из GitHub обновлены:$ENV_CHANGED"
  elif [ -n "$any" ]; then
    echo "== Настройки из GitHub: без изменений"
  fi
}

# весь скрипт разобран до запуска: git reset может заменить этот файл, пока он исполняется
if [ "${1:-}" = "--continue" ]; then
  finish
else
  main "$@"
fi
exit
