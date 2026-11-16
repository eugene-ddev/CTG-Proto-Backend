#!/usr/bin/env bash
# Первая настройка сервера — запускается с рабочей машины, на сервер заходить не нужно:
#   ssh root@<сервер> 'bash -s' < deploy/bootstrap.sh <домен> [--debug] [--show-key]
# Ставит git и Docker, клонирует CTG-Proto и CTG-Proto-Backend с GitHub в /opt/ctg (git-клоны), заводит ключ
# для GitHub Actions (умеет только запускать выкладку), затем — deploy/setup.sh (секреты, запуск, дампы базы).
# Повторный запуск безопасен. Старые папки без git (от прежнего push.sh) переносятся в /opt/ctg/_old.
# Приватные репозитории: скрипт создаст deploy-ключи и покажет, куда их добавить; после этого — запустить снова.
set -euo pipefail

main() {
  local OWNER=${CTG_GITHUB_OWNER:-eugene-ddev}
  local ROOT=${CTG_ROOT:-/opt/ctg}
  local BRANCH=${CTG_BRANCH:-main}
  local BASE=${CTG_REPO_BASE:-}
  local SSH_DIR=${CTG_SSH_DIR:-/root/.ssh}
  local DOMAIN="" SETUP_ARGS=() SHOW_KEY=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --debug | --no-debug) SETUP_ARGS+=("$arg") ;;
      --show-key) SHOW_KEY=1 ;;
      -*) fail "неизвестный параметр $arg" ;;
      *) DOMAIN=$arg ;;
    esac
  done

  [ "$(id -u)" = 0 ] || fail "нужен root"

  if ! command -v git >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
    echo "== Ставлю git"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssh-client util-linux >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q git curl openssh-clients util-linux
    else
      fail "не знаю, как поставить git на этой системе — поставь вручную"
    fi
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "== Ставлю Docker"
    curl -fsSL https://get.docker.com | sh
  fi

  mkdir -p "$ROOT" "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  touch "$SSH_DIR/known_hosts" "$SSH_DIR/config" "$SSH_DIR/authorized_keys"
  chmod 600 "$SSH_DIR/config" "$SSH_DIR/authorized_keys"
  grep -q '^github.com ' "$SSH_DIR/known_hosts" 2>/dev/null || ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >>"$SSH_DIR/known_hosts"

  # --- репозитории ---
  local missing=() name url dir
  for name in CTG-Proto CTG-Proto-Backend; do
    url=$(repo_url "$name")
    if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git ls-remote "$url" HEAD >/dev/null 2>&1; then
      missing+=("$name")
      continue
    fi
    dir="$ROOT/$name"
    if [ -d "$dir/.git" ]; then
      git -C "$dir" remote set-url origin "$url"
      echo "== $name: уже git-клон ($(git -C "$dir" log -1 --format='%h %s'))"
    else
      if [ -e "$dir" ]; then
        mkdir -p "$ROOT/_old"
        mv "$dir" "$ROOT/_old/$name-$(date +%Y%m%d-%H%M%S)"
        echo "== $name: старая папка без git перенесена в $ROOT/_old"
      fi
      echo "== Клонирую $name"
      git clone -q --branch "$BRANCH" "$url" "$dir"
    fi
  done

  # --- ключ для GitHub Actions: в authorized_keys с принудительной командой — может только запустить выкладку ---
  local KEY="$SSH_DIR/ctg_actions"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "ctg-github-actions" -f "$KEY"
  local PUB
  PUB=$(cat "$KEY.pub")
  local LINE="command=\"bash $ROOT/CTG-Proto-Backend/deploy/pull.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUB"
  grep -vF "$PUB" "$SSH_DIR/authorized_keys" >"$SSH_DIR/authorized_keys.new" || true
  echo "$LINE" >>"$SSH_DIR/authorized_keys.new"
  mv "$SSH_DIR/authorized_keys.new" "$SSH_DIR/authorized_keys"
  chmod 600 "$SSH_DIR/authorized_keys"

  if [ ${#missing[@]} -gt 0 ]; then
    echo
    echo "!! Нет доступа к репозиториям: ${missing[*]} (приватные?)."
    echo "   Добавь ключи в GitHub → репозиторий → Settings → Deploy keys → Add deploy key (Allow write access — не нужно):"
    for name in "${missing[@]}"; do
      echo
      echo "   $name:"
      echo "   $(cat "$SSH_DIR/ctg_deploy_$name.pub")"
    done
    echo
    echo "   Затем запусти bootstrap.sh ещё раз."
    exit 2
  fi

  echo
  if [ -n "$DOMAIN" ] || [ -f "$ROOT/.env" ]; then
    bash "$ROOT/CTG-Proto-Backend/deploy/setup.sh" ${DOMAIN:+"$DOMAIN"} "${SETUP_ARGS[@]}"
  else
    echo "Репозитории на месте. Укажи домен: ssh root@<сервер> 'bash -s' < deploy/bootstrap.sh <домен>"
  fi

  echo
  if [ -n "$SHOW_KEY" ]; then
    cat <<INFO
== Ключ для GitHub Actions (секрет SSH_PRIVATE_KEY окружения production в обоих репозиториях).
   Проще — bash deploy/github-env.sh root@<сервер>: заведёт всё сам.

$(cat "$KEY")
INFO
  else
    echo "== Дальше — настройка GitHub с рабочей машины: bash deploy/github-env.sh root@<сервер>"
  fi
}

fail() {
  echo "Ошибка: $*" >&2
  exit 1
}

# адрес репозитория: публичный — https; иначе — по SSH с отдельным deploy-ключом (GitHub: один ключ — один репозиторий)
repo_url() {
  local name=$1
  if [ -n "$BASE" ]; then
    echo "$BASE/$name"
    return
  fi
  local https="https://github.com/$OWNER/$name.git"
  if GIT_TERMINAL_PROMPT=0 git ls-remote "$https" HEAD >/dev/null 2>&1; then
    echo "$https"
    return
  fi
  local key="$SSH_DIR/ctg_deploy_$name"
  [ -f "$key" ] || ssh-keygen -q -t ed25519 -N "" -C "ctg-deploy-$name" -f "$key"
  if ! grep -q "^Host github-$name\$" "$SSH_DIR/config"; then
    printf '\nHost github-%s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$name" "$key" >>"$SSH_DIR/config"
  fi
  echo "git@github-$name:$OWNER/$name.git"
}

# весь скрипт разобран до запуска: его можно подавать через stdin (ssh … 'bash -s' < bootstrap.sh)
main "$@"
exit
