#!/usr/bin/env bash
# Настройка GitHub для выкладки — с рабочей машины, нужен GitHub CLI (https://cli.github.com, затем gh auth login):
#   bash deploy/github-env.sh root@<сервер> [ssh-порт]
# Заводит окружение production в CTG-Proto и CTG-Proto-Backend: доступ к серверу (ключ берёт с сервера) и
# настройки сервера — домен, папка игры, отладка, логин и пароль консоли Nakama. Повторный запуск — поменять их.
# Менять по одной: gh secret set CONSOLE_PASSWORD --env production -R eugene-ddev/CTG-Proto-Backend
set -euo pipefail

OWNER=${CTG_GITHUB_OWNER:-eugene-ddev}
BACK=$OWNER/CTG-Proto-Backend
PROTO=$OWNER/CTG-Proto
ENV=production
TARGET=${1:-}
PORT=${2:-22}

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

[ -n "$TARGET" ] || die "использование: bash deploy/github-env.sh root@<сервер> [ssh-порт]"
command -v gh >/dev/null 2>&1 || die "нужен GitHub CLI: https://cli.github.com, затем gh auth login"
gh auth status >/dev/null 2>&1 || die "сначала gh auth login"

case "$TARGET" in
  *@*) SSH_USER=${TARGET%@*} SSH_HOST=${TARGET#*@} ;;
  *) SSH_USER=root SSH_HOST=$TARGET ;;
esac

echo "== Ключ GitHub Actions с сервера"
KEY=$(ssh -p "$PORT" "$TARGET" 'cat ~/.ssh/ctg_actions') || die "на сервере нет ключа — сначала deploy/bootstrap.sh"

ask() {
  local prompt=$1 default=$2 answer
  read -r -p "$prompt [$default]: " answer
  echo "${answer:-$default}"
}

current_var() {
  gh variable get "$1" --env "$ENV" -R "$BACK" 2>/dev/null || true
}

echo
echo "== Настройки сервера (Enter — оставить значение в скобках)"
DOMAIN=$(ask "Домен" "$(current_var DOMAIN | grep . || echo theruiners.tech)")
GAME_PATH=$(ask "Папка игры" "$(current_var GAME_PATH | grep . || echo /ctg)")
CTG_DEBUG=$(ask "Режим отладки (true/false)" "$(current_var CTG_DEBUG | grep . || echo false)")
CONSOLE_USER=$(ask "Логин консоли Nakama" "$(current_var CONSOLE_USER | grep . || echo admin)")
read -r -s -p "Пароль консоли (Enter — сгенерировать, «-» — не менять): " CONSOLE_PASSWORD
echo
case "$CONSOLE_PASSWORD" in
  "") CONSOLE_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); NEW_PASSWORD=1 ;;
  -) CONSOLE_PASSWORD=""; NEW_PASSWORD="" ;;
  *"'"*) die "пароль не должен содержать одинарную кавычку" ;;
  *) NEW_PASSWORD="" ;;
esac

for repo in "$PROTO" "$BACK"; do
  echo "== $repo: окружение $ENV"
  gh api -X PUT "repos/$repo/environments/$ENV" >/dev/null
  gh secret set SSH_HOST --env "$ENV" -R "$repo" --body "$SSH_HOST"
  gh secret set SSH_USER --env "$ENV" -R "$repo" --body "$SSH_USER"
  gh secret set SSH_PORT --env "$ENV" -R "$repo" --body "$PORT"
  printf '%s\n' "$KEY" | gh secret set SSH_PRIVATE_KEY --env "$ENV" -R "$repo"
done

echo "== $BACK: настройки сервера"
gh variable set DOMAIN --env "$ENV" -R "$BACK" --body "$DOMAIN"
gh variable set GAME_PATH --env "$ENV" -R "$BACK" --body "$GAME_PATH"
gh variable set CTG_DEBUG --env "$ENV" -R "$BACK" --body "$CTG_DEBUG"
gh variable set CONSOLE_USER --env "$ENV" -R "$BACK" --body "$CONSOLE_USER"
[ -z "$CONSOLE_PASSWORD" ] || gh secret set CONSOLE_PASSWORD --env "$ENV" -R "$BACK" --body "$CONSOLE_PASSWORD"

echo
echo "Готово. Консоль: https://$DOMAIN/ — логин $CONSOLE_USER"
[ -z "$NEW_PASSWORD" ] || echo "Пароль (сгенерирован, сохрани — GitHub его больше не покажет): $CONSOLE_PASSWORD"
echo "Настройки применятся при выкладке CTG-Proto-Backend."
read -r -p "Запустить выкладку сейчас? [Y/n]: " go
case "$go" in
  n | N) echo "Позже: gh workflow run deploy.yml -R $BACK" ;;
  *) gh workflow run deploy.yml -R "$BACK" --ref main && echo "Запущена: gh run watch -R $BACK" ;;
esac
