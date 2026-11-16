#!/usr/bin/env bash
# Выкладка: подтянуть main обоих репозиториев и пересобрать. Запускает GitHub Actions по SSH — ключ в
# authorized_keys разрешает только эту команду (см. bootstrap.sh). Вручную на сервере: bash deploy/pull.sh
# На вход (stdin) — строки KEY=VALUE из окружения GitHub: заданные значения записываются в ../.env,
# незаданные остаются как были. Две выкладки одновременно (push в обе репы) не пересекаются — вторая ждёт первую.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

main() {
  local BRANCH=${CTG_BRANCH:-main}
  [ -f "$ENV_FILE" ] || die "нет $ENV_FILE — сначала deploy/bootstrap.sh <домен>"
  exec 9>"$ROOT_DIR/.deploy.lock"
  if ! flock -n 9; then
    echo "== Идёт другая выкладка — жду"
    flock -w 1200 9 || die "другая выкладка идёт больше 20 минут"
  fi

  [ -t 0 ] || apply_env

  local dir
  for dir in "$PROTO_DIR" "$BACKEND_DIR"; do
    [ -d "$dir/.git" ] || die "$dir — не git-клон; запусти deploy/bootstrap.sh"
    git -C "$dir" fetch -q --prune origin "$BRANCH"
    # клоны на сервере — только для выкладки: локальных правок там нет и не должно быть
    git -C "$dir" reset -q --hard "origin/$BRANCH"
    git -C "$dir" clean -q -fd
    echo "== $(basename "$dir"): $(git -C "$dir" log -1 --format='%h %s')"
  done

  bash "$BACKEND_DIR/deploy/update.sh"
}

apply_env() {
  local line key value changed="" any=""
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [ -n "$line" ] || continue
    any=1
    key=${line%%=*}
    value=${line#*=}
    case " $GITHUB_ENV_KEYS " in
      *" $key "*) ;;
      *)
        echo "!! $key из GitHub пропущен: не настраивается оттуда"
        continue
        ;;
    esac
    [ -n "$value" ] || continue
    case "$value" in
      *"'"*) die "$key: значение не должно содержать одинарную кавычку" ;;
    esac
    if [ "$(env_value "$key")" != "$value" ]; then
      put_env "$key" "$value"
      changed="$changed $key"
    fi
  done
  if [ -n "$changed" ]; then
    echo "== Настройки из GitHub обновлены:$changed"
  elif [ -n "$any" ]; then
    echo "== Настройки из GitHub: без изменений"
  fi
}

# весь скрипт разобран до запуска: git reset ниже может заменить этот файл, пока он исполняется
main "$@"
exit
