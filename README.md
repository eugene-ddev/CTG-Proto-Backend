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
npm run logs      # в логе: «CTG-Proto-Backend 0.1.0 ready, core …, self-test: …»
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
| `src/lib` | ответы, версии, самопроверка |
| `src/shared` | логика и конфиги прототипа (копия) |
| `scripts/sync-core.mjs` | синхронизация `src/shared` |

## RPC

| RPC | Вход | Выход |
| --- | --- | --- |
| `system/ping` | `{ selfTest?: boolean, seed?: number }` | `{ server, protocol, shared: { proto, digest }, time, selfTest? }` — `selfTest` считает бой двух ботов по seed |
