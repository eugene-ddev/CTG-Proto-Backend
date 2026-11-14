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
npm run logs      # в логе: «CTG-Proto-Backend 0.7.1 ready, core …, self-test: …»
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
| `system/ping` | `{ selfTest?: boolean, seed?: number }` | `{ server, protocol, shared: { proto, digest }, time, selfTest? }` — `selfTest` считает бой двух ботов по seed |
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
