#!/usr/bin/env bash
# Выкладка с рабочей машины (Git Bash на Windows, Linux, macOS): отправляет на сервер закоммиченное
# состояние CTG-Proto и CTG-Proto-Backend и пересобирает. GitHub не нужен — только SSH.
#   bash deploy/push.sh <пользователь@сервер> [папка на сервере, по умолчанию /opt/ctg]
# Первый раз после push — на сервере: bash /opt/ctg/CTG-Proto-Backend/deploy/setup.sh <домен>
set -euo pipefail

TARGET=${1:-}
REMOTE=${2:-/opt/ctg}
[ -n "$TARGET" ] || {
  echo "Использование: bash deploy/push.sh <пользователь@сервер> [папка]" >&2
  exit 1
}

BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
PROTO_DIR=$(cd "$BACKEND_DIR/../CTG-Proto" && pwd)

for dir in "$PROTO_DIR" "$BACKEND_DIR"; do
  git -C "$dir" rev-parse --verify -q HEAD >/dev/null || {
    echo "Ошибка: $dir — не git-репозиторий или в нём нет коммитов" >&2
    exit 1
  }
  dirty=$(git -C "$dir" status --porcelain | grep -v -e 'package-lock.json$' -e 'yarn.lock$' || true)
  if [ -n "$dirty" ]; then
    echo "!! В $(basename "$dir") есть незакоммиченные изменения — на сервер уйдёт только коммит:"
    echo "$dirty"
  fi
done

echo "== Проверяю, что логика сервера совпадает с прототипом"
node "$BACKEND_DIR/scripts/sync-core.mjs" --check "$PROTO_DIR"

send() {
  local dir=$1 name
  name=$(basename "$dir")
  echo "== $name $(git -C "$dir" log -1 --format='%h %s')"
  # распаковка в новую папку и подмена: удалённые из репозитория файлы на сервере не остаются
  git -C "$dir" archive --format=tar.gz HEAD |
    ssh "$TARGET" "set -e; mkdir -p '$REMOTE'; rm -rf '$REMOTE/$name.new'; mkdir '$REMOTE/$name.new'; tar -xzf - -C '$REMOTE/$name.new'; rm -rf '$REMOTE/$name.old'; if [ -d '$REMOTE/$name' ]; then mv '$REMOTE/$name' '$REMOTE/$name.old'; fi; mv '$REMOTE/$name.new' '$REMOTE/$name'; rm -rf '$REMOTE/$name.old'"
}

send "$PROTO_DIR"
send "$BACKEND_DIR"

if ssh "$TARGET" "[ -f '$REMOTE/.env' ]"; then
  ssh "$TARGET" "bash '$REMOTE/CTG-Proto-Backend/deploy/update.sh'"
else
  echo
  echo "Файлы на сервере. Первая настройка:"
  echo "  ssh $TARGET \"bash $REMOTE/CTG-Proto-Backend/deploy/setup.sh <домен>\""
fi
