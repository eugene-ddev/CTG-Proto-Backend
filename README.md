# CTG-Proto-Backend

Сервер браузерного прототипа Cuber The Game (`CTG-Proto`): Nakama 3.32 + Postgres, TypeScript-рантайм.
Устроен по примеру `CTG-Backend`, но правила игры не пишутся заново: сервер исполняет ту же логику, что и клиент
(`src/shared` — копия `CTG-Proto/src/core` и `src/data`), и сам считает бои.

План и статус по этапам — `CTG-Backend/docs/network.md`.

## Запуск

Нужен Docker Desktop.

```bash
npm install
npm run up        # собрать и поднять Nakama + Postgres
npm run logs      # в логе: «CTG-Proto-Backend 0.8.4 ready, core …, self-test: …»
npm run down
```

| Что | Адрес |
| --- | --- |
| API для клиента | `http://127.0.0.1:7450` (server key `defaultkey`) |
| Консоль Nakama | `http://127.0.0.1:7451` (admin / password) |
| Postgres | `127.0.0.1:5442` |

Порты сдвинуты на +100 относительно `CTG-Backend`, чтобы оба сервера работали одновременно.

Проверка из консоли Nakama (API Explorer) или curl:

```bash
curl "http://127.0.0.1:7450/v2/rpc/system%2Fping?http_key=defaulthttpkey&unwrap" -d '{"selfTest":true}'
```

## Выкладка на сервер

Push в `main` любого из двух репозиториев (`CTG-Proto`, `CTG-Proto-Backend`) → GitHub Actions: проверка, затем
по SSH на сервере `deploy/pull.sh` — `git pull` обоих клонов в `/opt/ctg` и пересборка. На сервер заходить не нужно.

Один домен, Caddy сам получает сертификат:

| Адрес | Что |
| --- | --- |
| `https://<домен>/ctg/` | игра и её API (`/ctg/v2`, `/ctg/ws` → Nakama, `/ctg` срезается) |
| `https://<домен>/` | консоль Nakama — работает только из корня |

### Первый раз

Из Git Bash в папке `CTG-Proto-Backend`:

```bash
# 1. оба репозитория — на GitHub (выкладка пока пропускается: окружение не настроено)
git push                      # и в CTG-Proto тоже

# 2. сервер: git, Docker, клоны с GitHub, секреты, запуск, ежедневные дампы базы
ssh root@<сервер> 'bash -s' < deploy/bootstrap.sh theruiners.tech

# 3. GitHub: окружение production в обоих репозиториях — доступ к серверу, домен, логин и пароль консоли
bash deploy/github-env.sh root@<сервер>      # нужен gh: https://cli.github.com, gh auth login
```

До шага 2 — A-запись домена на IP сервера, порты 80 и 443 открыты и свободны. За Cloudflare — на первый запуск
«DNS only», иначе Caddy не получит сертификат. Если репозитории приватные, `bootstrap.sh` покажет deploy-ключи:
добавить их в Settings → Deploy keys каждого репозитория и запустить шаг 2 ещё раз.

### Настройки — в GitHub

Окружение `production` в `CTG-Proto-Backend` (Settings → Environments). При выкладке заданные значения
записываются в `/opt/ctg/.env`, незаданные сервер оставляет свои (их сгенерировал `bootstrap.sh`).

| Имя | Вид | Что |
| --- | --- | --- |
| `SSH_HOST`, `SSH_PRIVATE_KEY` | секрет | доступ к серверу (`SSH_USER`, `SSH_PORT` — если не root и не 22); то же — в `CTG-Proto` |
| `DOMAIN`, `GAME_PATH` | переменная | домен и папка игры (`/ctg`) |
| `CTG_DEBUG` | переменная | `true` — debug-действия и сброс игрока у всех |
| `CONSOLE_USER` | переменная | логин консоли Nakama |
| `CONSOLE_PASSWORD` | секрет | пароль консоли Nakama |
| `SERVER_KEY`, `HTTP_KEY`, `SESSION_KEY`, `REFRESH_KEY`, `CONSOLE_SIGNING_KEY` | секрет | ключи Nakama — по желанию; смена `SESSION_KEY` разлогинит всех |
| `TG_BOT_TOKEN` | секрет | токен Telegram-бота для уведомлений (@BotFather → `/newbot`) |
| `TG_CHAT_ID` | переменная | кому писать (свой id — у @userinfobot; для группы — id группы, бот в ней) |

`POSTGRES_PASSWORD` из GitHub не берётся: Postgres задаёт пароль один раз, при создании базы.
Значения — без одинарной кавычки; значение `-` убирает настройку с сервера (например, `TG_CHAT_ID=-` выключает
уведомления). Action передаёт серверу только настройки из явного списка в шаге «Выкладка» (`toJSON(secrets)` GitHub
справедливо считает вредоносным). Новая настройка: добавить в этот список и в `deploy/lib.sh` → `GITHUB_ENV_KEYS`. Поменять настройку: `bash deploy/github-env.sh root@<сервер>` (спросит всё заново)
или `gh secret set CONSOLE_PASSWORD --env production -R eugene-ddev/CTG-Proto-Backend`, затем выкладка —
`gh workflow run deploy.yml -R eugene-ddev/CTG-Proto-Backend` (или Actions → Deploy → Run workflow).

### Слежение и уведомления в Telegram

`deploy/healthcheck.sh` — cron каждую минуту (ставится при выкладке), пишет, только если заданы `TG_BOT_TOKEN`
и `TG_CHAT_ID`:

- 🔴 игра не работает — две проверки подряд (2 минуты) `system/ping` с `{"db":true}` через Caddy не вернули
  `"db":true`; в сообщении причина (база или нет ответа), состояние контейнеров и свободное место;
- 🟢 снова работает — с длительностью простоя;
- 🟠 на диске меньше 2 ГБ (отбой — больше 3 ГБ).

Во время выкладки проверка пропускается. После выкладки, в которой поменялись `TG_*`, приходит проверочное
сообщение. Вручную на сервере: `bash deploy/healthcheck.sh --test`.

### Как устроено

- Ключ GitHub Actions лежит на сервере в `authorized_keys` с принудительной командой: им можно только запустить
  `deploy/pull.sh`, ни shell, ни туннелей.
- Клоны на сервере — только для выкладки: `pull.sh` делает `reset --hard` на `origin/main`.
- Push в оба репозитория сразу — две выкладки идут по очереди (блокировка на сервере).
- Правила игры поменялись — push в `CTG-Proto`, потом `npm run sync-core` и push в `CTG-Proto-Backend`. Между ними
  выкладка из `CTG-Proto` остановится на проверке совпадения логики (красный Action) — так и задумано.
- `index.html` не кешируется: игроки получают новую версию обычным обновлением страницы.
- Образы собираются на сервере. Перед сборкой: меньше 2 ГБ свободно — чистится весь кэш сборки и неиспользуемые
  образы, меньше 1 ГБ после чистки — выкладка останавливается. После выкладки — висящие образы и кэш старше двух суток.
  (16.11.2026 кончилось место — упал Postgres.)
- Выкладка считается успешной, только если `system/ping` с `{"db":true}` через Caddy отвечает `"db":true`: штатный
  healthcheck Nakama при лежащей базе отвечает «healthy».

| На сервере (если зайти) | |
| --- | --- |
| `bash deploy/pull.sh` | выкладка вручную |
| `bash deploy/setup.sh [домен] [--debug \| --no-debug]` | сменить домен или отладку (GitHub при следующей выкладке перезапишет, если там задано) |
| `bash deploy/backup.sh` | дамп базы; по расписанию — каждый день в 04:17 в `/opt/ctg/backups`, хранится 14 |
| `docker compose --env-file /opt/ctg/.env -f docker-compose.prod.yml logs -f nakama` | логи |

Файлы: `.github/workflows/deploy.yml`, `docker-compose.prod.yml`, `prod.yml` (конфиг Nakama без секретов),
`deploy/` — `bootstrap.sh`, `github-env.sh` (с рабочей машины), `pull.sh`, `setup.sh`, `update.sh`, `backup.sh`,
`healthcheck.sh`,
`lib.sh` (на сервере), `Caddyfile`, `web.Dockerfile`.

## Общая логика с прототипом

```bash
npm run sync-core    # скопировать core и data из ../CTG-Proto в src/shared
npm run check-core   # проверить, что src/shared совпадает с прототипом
```

- `src/shared` руками не правится: правка — в `CTG-Proto/src/core`, затем `npm run sync-core` и коммит в обоих репозиториях.
- `src/shared/version.json` — версия прототипа и отпечаток логики; сервер отдаёт их в `system/ping`, клиент сверяет
  со своими (несовпадение — клиент и сервер считают по разным правилам).
- Рантайм Nakama — движок goja: сборка идёт через babel в ES5, как в `CTG-Backend`. В `core` нельзя использовать
  браузерные API (`window`, `localStorage`) — `core/save.ts` поэтому не копируется.

## Структура

| Путь | Что |
| --- | --- |
| `src/main.ts` | `InitModule`: регистрация RPC и хуков, самопроверка логики при старте |
| `src/rpc/<Домен>/*Rpc.ts` | RPC по доменам; лог до и после действия |
| `src/lib` | ответы, версии, самопроверка, `protectedRpc` (проверка входа, лог, ошибки) |
| `src/entities/Player` | запись игрока: чтение, создание, стартовое состояние |
| `src/hooks` | хуки Nakama |
| `src/shared` | логика и конфиги прототипа (копия) |
| `scripts/sync-core.mjs` | синхронизация `src/shared` |

## RPC

| RPC | Вход | Выход |
| --- | --- | --- |
| `system/ping` | `{ selfTest?: boolean, seed?: number, db?: boolean }` | `{ server, protocol, shared: { proto, digest }, time, selfTest?, db? }` — `selfTest` считает бой двух ботов по seed; `db` — `true` или текст ошибки базы |
| `player/read` | `{}` | `{ state, rev, serverTime, server, protocol, shared, debug, arena }` — состояние игрока; нет записи — создаётся стартовое. При чтении: бой, прерванный перезагрузкой, засчитывается поражением; кубы чинятся по часам сервера |
| `player/act` | `{ rev, actions: [{ name, args, now, seed }] }` | `{ ok: true, rev, hash, state?, arena? }` — действия исполнены (`hash` — отпечаток состояния для сверки); `{ ok: false, reason: 'rejected' \| 'conflict', state, rev, action? }` — действие отклонено или ревизия устарела, клиент берёт состояние сервера. Пачка исполняется целиком или не исполняется вовсе |
| `player/reset` | `{}` | как `player/read` — сброс к стартовому состоянию; только в режиме отладки |
| `arena/opponents` | `{}` | `{ me: { rating, wins, losses, inbox }, opponents: [{ userId, name, rating, wins, losses, winDelta, loseDelta, snapshot }] }` — до 30 игроков с бойцом, ближайшие по рейтингу; `winDelta` / `loseDelta` — изменение рейтинга вызывающего |
| `arena/leaderboard` | `{}` | `{ total, me, top, around }` — первые 50 строк таблицы рейтинга (`rank, name, rating, wins, losses, me`); если игрок не в них — `around`: 7 строк вокруг его места |
| `arena/claimInbox` | `{}` | `{ state, rev, arena }` — журнал нападений очищен, награды из него положены в инвентарь |
| `arena/challenge` | `{ userId, charUid }` | `{ state, rev }` — начата серия с игроками или выбран соперник следующего её боя: в `arenaRun.opp.player` — снимок бойца соперника и рейтинги обоих |

Хук `AfterAuthenticateDevice` (`src/hooks/initPlayer.ts`) создаёт игроку стартовое состояние при первом входе.

## Действия

Список действий и их исполнение — `src/shared/core/actions.ts` (из прототипа): `applyAction(state, name, args, { now, seed })`.
Сервер не доверяет состоянию клиента — только названию действия и аргументам; условия проверяет сама логика.

- `now` — время действия от клиента; принимается, если отличается от часов сервера не больше чем на 10 с, иначе
  берётся время сервера. `seed` — случайное зерно действия.
- Действия `debug*` и `player/reset` исполняются только в режиме отладки: `runtime.env: CTG_DEBUG=true` в `local.yml`.
- Действия `startRun` и `startFight` (`isServerSeeded`) получают зерно от сервера, а не от клиента; в ответе на
  такую пачку есть `state` — клиент берёт его целиком. Так нельзя перебирать противника или зерно боя.
- Бой серии: `finishFight` принимает только ввод игрока (артефакты, ход сдачи); бой пересчитывается на сервере
  (`src/shared/core/fight.ts`) по бойцу, противнику и зерну из состояния. Лут — из `state.loot` (`lootTake`).

## Бои с игроками

- Бой асинхронный: дерутся со **снимком** активного бойца соперника (`fighter/active`, кубы целые); лут победителю —
  копии, хозяин ничего не теряет. Снимок и запись в таблице рейтинга обновляются после любого изменения состояния
  (`entities/Arena/publish.ts`), только если изменились.
- Бой считается как в серии с ботами (`startFight` → `finishFight` с вводом игрока). Итог оставляет в состоянии
  нападавшего `pvpPending`; сервер один раз (`record.pvpDone`) разносит его (`entities/Arena/settlePvp.ts`) по
  **профилям арены** обоих: рейтинг (у защитника с обратным знаком), счёт, а защитнику — запись в журнал
  (`inbox`) с наградой, если он отбился (`arena.json → defenseReward` кубов + один вариант из `reward.drops`).
- Профиль арены (`arena/profile`: `{ rating, wins, losses, inbox }`) — отдельная запись игрока. Состояние
  защитника чужой бой не меняет: награду он забирает сам (`arena/claimInbox`), когда читает журнал.
- Рейтинг — Эло (`src/shared/core/rating.ts`): старт 1000, K = 32. Таблица — лидерборд Nakama `arena_rating`
  (score = рейтинг, metadata = победы / поражения).
- Перезагрузка посреди боя с игроком — поражение со всеми последствиями (`player/read`).

## Хранение

| Коллекция | Ключ | Что |
| --- | --- | --- |
| `player` | `state` | `{ state: PlayerState, rev, createdAt, updatedAt }` — всё состояние игрока (тип из `src/shared/core/state.ts`); пишет только сервер, `rev` растёт с каждой записью |
| `arena` | `profile` | `{ rating, wins, losses, inbox }` — рейтинг, счёт боёв с игроками и журнал нападений; меняют свои и чужие бои (запись с повтором при конфликте версии), вслед обновляется лидерборд |
| `fighter` | `active` | `{ snapshot, updatedAt }` — снимок активного бойца игрока для боёв с игроками; читать могут все, пишет сервер |
