# Арена: матчи и бои — контекст для клиента

Справка для клиентской интеграции (Nakama RPC). Матч — это **серия боёв** (`Combats`). Все enum передаются **числами**. Все RPC требуют аутентификации; без неё вернётся ошибка `UNAUTHENTICATED` (16).

Payload и ответ — JSON-строки (как принято в Nakama RPC).

---

## Enum (числовые значения)

```
MatchStatus:  Started = 0,  Cancelled = 1,  Finished = 2
MatchType:    Training = 0, DangerZone = 1
CombatResult: Win = 0,      Lose = 1,       Cancelled = 2
```

`seriesCombatsCount` (длина серии) и `maxRetriesCount` (лимит ретраев) определяются типом матча на сервере и приходят уже заполненными в записи матча.

---

## Модели

### Match (`IMatchRecord`)
```ts
{
  id: string
  status: MatchStatus          // 0 Started | 1 Cancelled | 2 Finished
  type: MatchType              // 0 Training | 1 DangerZone
  seriesCombatsCount: number   // сколько боёв нужно выиграть в серии
  currentCombatNumber: number  // текущий номер боя в серии (0 пока бой не создан)
  maxRetriesCount: number      // лимит ретраев
  retriesCount: number         // использовано ретраев
  combats: string[]            // id боёв в порядке создания
  createdAt: number            // мс
  updatedAt: number            // мс
}
```

### Combat (`ICombatRecord`)
```ts
{
  id: string
  result: CombatResult | null  // null пока бой не завершён; иначе 0 Win | 1 Lose | 2 Cancelled
  createdAt: number            // момент создания (подбор оппонента)
  startedAt: number | null     // момент старта боя; null пока не начат
  updatedAt: number
  playerCharacterId: string
  opponent: IOpponent   // серверный снапшот оппонента, живёт прямо в бою
  looted: boolean
}
```

### Opponent (поле `combat.opponent`; в ответах RPC `character` — уже резолвнутый view)
```ts
{
  account: { userId: string; userName: string; avatarUrl: string }
  character: ICharacterRecordView   // резолвнутый персонаж оппонента (см. README — Shared Types)
}
```

Лутабельные предметы оппонента видны в `character.slots` (оружие/артефакты и содержимое подсумка/рюкзака); их `id` передаются в `arena/transferLoot`. Отдельного `loot` в ответе больше нет.

### Общие ответы
- Успех без данных: `{ code: 200 }`
- Ошибка: `{ message: string, code: number }`, где `code` — gRPC-код: `INVALID_ARGUMENT` 3, `NOT_FOUND` 5, `FAILED_PRECONDITION` 9, `INTERNAL` 13, `UNAUTHENTICATED` 16.

---

## Флоу

```
getNewMatch ──► [ nextCombat ──► startCombat ──► submitCombatResult ] × серия
                       ▲                                   │
                       └──── (Win, серия не закончена) ─────┘
                                          │
               (Lose, есть ретраи) ──► retryLastCombat ──► startCombat ──► submitCombatResult
```

- Активным (`Started`) может быть только **один** матч. `getNewMatch` сам отменяет предыдущий незавершённый.
- Перед боями нужен активный персонаж (`account/setActiveCharacter`) — по нему подбирается оппонент.
- Прогресс серии считается **по победам**. Следующий оппонент выдаётся, пока побед `< seriesCombatsCount` и последний бой выигран.
- Матч завершается (`Finished`) автоматически в `submitCombatResult`: победа в последнем бою серии (успех) **или** поражение при исчерпанных ретраях (провал).

---

## RPC

### `arena/getNewMatch`
Создаёт матч; предыдущий незавершённый отменяется.
- **Request:** `{ matchType: MatchType }`
- **Response:** `IMatchRecord`

### `arena/getCurrentMatch`
Активный матч пользователя.
- **Request:** *(пусто)*
- **Response:** `IMatchRecord | null`

### `arena/nextCombat`
Подбирает оппонента и создаёт бой для текущего слота серии. `currentCombatNumber` становится `побед + 1`.
- **Request:** `{ matchId: string }`
- **Response:** `ICombatView` — `ICombatRecord` с резолвнутым `opponent: IOpponentView` (`{ account, character: ICharacterRecordView }`)
- **Ошибки:** `FAILED_PRECONDITION` — матч не активен / нет активного персонажа / есть незавершённый бой / последний бой не выигран / серия уже пройдена.

### `arena/startCombat`
Помечает текущий бой начатым (`startedAt`). Вызывать перед `submitCombatResult`.
- **Request:** `{ matchId: string }`
- **Response:** `ICombatView` (поле `opponent` — как `{ account, character: ICharacterRecordView }`)
- **Ошибки:** `FAILED_PRECONDITION` — нет боя для старта / бой уже начат.

### `arena/submitCombatResult`
Фиксирует исход текущего боя и, если нужно, завершает матч.
- **Request:** `{ matchId: string, result: CombatResult }` — допустимо только `Win` (0) или `Lose` (1)
- **Response:** `IMatchRecord` (обновлённый — по `status` видно, завершился ли матч)
- **Ошибки:** `INVALID_ARGUMENT` — невалидный `result`; `FAILED_PRECONDITION` — нет боя в процессе / бой не начат.

### `arena/retryLastCombat`
Перебивает проигранный последний бой против того же оппонента. Создаёт новый бой (его потом так же `startCombat` → `submitCombatResult`).
- **Request:** `{ matchId: string }`
- **Response:** `ICombatView` (тот же оппонент, `opponent` резолвнут)
- **Ошибки:** `FAILED_PRECONDITION` — последний бой не проигран / ретраи исчерпаны.

### `arena/terminateMatch`
Досрочно завершает активный матч со статусом `Cancelled` (открытый бой тоже `Cancelled`).
- **Request:** `{ matchId: string }`
- **Response:** `{ code: 200 }`
- **Ошибки:** `FAILED_PRECONDITION` — матч не активен.

---

## Типовая последовательность (победа серии из 3 боёв)

```
setActiveCharacter
getNewMatch { matchType: 0 }                 -> match (status 0, seriesCombatsCount 3)
nextCombat { matchId }                       -> opponent #1
startCombat { matchId }
submitCombatResult { matchId, result: 0 }    -> match (status 0)
nextCombat { matchId }                       -> opponent #2
startCombat { matchId }
submitCombatResult { matchId, result: 0 }    -> match (status 0)
nextCombat { matchId }                       -> opponent #3
startCombat { matchId }
submitCombatResult { matchId, result: 0 }    -> match (status 2 Finished)
```
