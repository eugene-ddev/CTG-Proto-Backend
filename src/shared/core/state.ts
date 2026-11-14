// Состояние игрока и операции над ним. Чистые функции без Phaser: на вход
// состояние, на выход новое состояние. Удобно тестировать и потом перенести на сервер.
import type { StartConfig, Stat } from '../data/types';
import type { ArenaRun, LootEntry, PvpPending } from './arena';
import type { EquipmentPreset } from './preset';
import type { Bags } from './bag';

export const STATE_VERSION = 4;

/** Ресурсы — предметы инвентаря (config/resources.json); стопка кубов — 100. */
export const CUBE_ID = 'cube';
export const CUBE_STACK = 500;
export const SHARD_ID = 'cubeShard';
export const SHARD_STACK = 100;
export const WHETSTONE_ID = 'whetstone';
export const PARCHMENT_ID = 'parchment';

/** Предмет в инвентаре. Зелья и ресурсы лежат стопкой (count), снаряжение — по одному. */
export interface InventoryEntry {
  uid: string;
  itemId: string;
  count: number;
  /** Уровень экземпляра снаряжения (лут с бота); нет — уровень шаблона предмета. */
  level?: number;
  /** Ячеек камней в этом экземпляре оружия (ювелирный набор, этап 8); нет — как у шаблона. */
  cells?: number;
  /** Камни, вставленные в ячейки этого оружия (id предметов-камней), по порядку ячеек. */
  gems?: string[];
}

/** Предмет, надетый на персонажа. Из инвентаря он уходит и возвращается при снятии. */
export interface EquippedItem {
  uid: string;
  itemId: string;
  level?: number;
  cells?: number;
  gems?: string[];
}

/**
 * Персонаж. Появляется сразу после крафта по чертежу — с именем по умолчанию и без снаряжения;
 * снаряжение и имя меняются в окне «Персонажи», статы блоков — нет.
 */
export interface CharacterState {
  uid: string;
  name: string;
  blueprintId: string;
  /** Стата каждого блока по индексу блока в чертеже — задана при крафте. */
  blockStats: Stat[];
  /** Индексы разбитых блоков: на арене сами не чинятся (только зельем), вне арены — со временем. */
  brokenBlocks: number[];
  /** Снаряжение по слотам чертежа (руки, артефакты), null — пусто. */
  equipment: Array<EquippedItem | null>;
  /** Рюкзак — отдельный слот, не из чертежа. */
  rucksack: EquippedItem | null;
  /** Порядок стат, в котором боец бьёт блоки противника (экран «Новый противник»). */
  target?: Stat[];
  /** Содержимое рюкзака по его ячейкам (зелья стопками, лут поштучно); длина = вместимость надетого рюкзака. */
  bag: Array<InventoryEntry | null>;
  /** С какого момента идёт восстановление разбитых кубов (мс); undefined — чинить нечего. */
  lobbySince?: number;
  /** Сохранённый пресет снаряжения (что надеть одной кнопкой). */
  preset?: EquipmentPreset;
  /** Ячейки пресетов (PRESET_SLOTS); null — пустая. Старый одиночный `preset` читается как ячейка 1. */
  presets?: Array<EquipmentPreset | null>;
}

export interface PlayerState {
  version: number;
  /** Всё, включая кубы и осколки, — записи инвентаря. */
  inventory: InventoryEntry[];
  characters: CharacterState[];
  /** Чертежи, открытые игроку. На старте — все. */
  unlockedBlueprints: string[];
  /** Чертежи, собранные вручную хотя бы раз: у них появляется «Автосборка». */
  manuallyCrafted: string[];
  lastArenaCharacterId: string | null;
  /** Идущая серия боёв арены (null — нет). */
  arenaRun: ArenaRun | null;
  /**
   * Итог последнего боя с игроком: по нему сервер меняет рейтинг обоим и пишет защитнику в журнал.
   * Сами рейтинг, счёт и журнал — не в состоянии, а в отдельной записи игрока (ArenaProfile): их меняют и чужие бои.
   */
  pvpPending?: PvpPending | null;
  /** Лут побеждённого противника, который можно забрать в рюкзак бойца (окно победы); null — нет. */
  loot?: { charUid: string; entries: LootEntry[] } | null;
  /** Счётчик для uid — детерминированно и без коллизий после загрузки. */
  nextUid: number;
  /** Марбл-бэги вне боя (награды, генерация ботов) — живут между боями и сериями (этап 6). */
  bags: Bags;
}

/**
 * Состояние нового игрока. allItemIds — все предметы игры: с `start.allItems` каждый кладётся полной стопкой
 * (кубы — отдельно, `start.cubes`).
 */
export function createInitialState(start: StartConfig, allBlueprintIds: string[], maxStack: (itemId: string) => number, allItemIds: string[] = []): PlayerState {
  let s: PlayerState = {
    version: STATE_VERSION,
    inventory: [],
    characters: [],
    unlockedBlueprints: start.unlockAllBlueprints ? [...allBlueprintIds] : (start.blueprints ?? []).filter((id) => allBlueprintIds.includes(id)),
    manuallyCrafted: [],
    lastArenaCharacterId: null,
    arenaRun: null,
    nextUid: 1,
    bags: {},
  };
  s = addCubes(s, start.cubes);
  if (start.allItems && allItemIds.length) {
    for (const itemId of allItemIds) if (itemId !== CUBE_ID) s = addItem(s, itemId, maxStack(itemId), maxStack(itemId));
    return s;
  }
  for (const { itemId, count } of start.inventory) s = addItem(s, itemId, count, maxStack(itemId));
  return s;
}

export function uid(s: PlayerState, prefix: string): [string, PlayerState] {
  return [`${prefix}${s.nextUid}`, { ...s, nextUid: s.nextUid + 1 }];
}

/** Сколько штук предмета лежит в инвентаре (все стопки). */
export const itemCount = (s: PlayerState, itemId: string) => s.inventory.reduce((n, e) => (e.itemId === itemId ? n + e.count : n), 0);

/** Кубы — стопки «Куб» в инвентаре. */
export const cubeCount = (s: PlayerState) => itemCount(s, CUBE_ID);

/** Положить кубы в инвентарь (докладываются в неполные стопки по 100). Отрицательное — списать сколько есть. */
export function addCubes(s: PlayerState, amount: number): PlayerState {
  if (amount < 0) return takeItems(s, CUBE_ID, Math.min(-amount, cubeCount(s))) ?? s;
  return amount > 0 ? addItem(s, CUBE_ID, amount, CUBE_STACK) : s;
}

/** Списать кубы из инвентаря. null — не хватает. */
export function spendCubes(s: PlayerState, amount: number): PlayerState | null {
  return takeItems(s, CUBE_ID, amount);
}

/** Забрать count штук предмета из инвентаря — сначала из неполных стопок. null — не хватает. */
export function takeItems(s: PlayerState, itemId: string, count: number): PlayerState | null {
  if (count <= 0) return s;
  if (itemCount(s, itemId) < count) return null;
  let left = count;
  const order = s.inventory.filter((e) => e.itemId === itemId).sort((a, b) => a.count - b.count).map((e) => e.uid);
  const take = new Map<string, number>();
  for (const u of order) {
    if (left <= 0) break;
    const e = s.inventory.find((x) => x.uid === u)!;
    const n = Math.min(e.count, left);
    take.set(u, n);
    left -= n;
  }
  return { ...s, inventory: s.inventory.map((e) => (take.has(e.uid) ? { ...e, count: e.count - take.get(e.uid)! } : e)).filter((e) => e.count > 0) };
}

/**
 * Положить предмет. Стакающиеся (maxStack > 1) докладываются в неполные стопки,
 * остаток — новыми стопками; нестакающиеся — по одной записи на штуку.
 */
export function addItem(s: PlayerState, itemId: string, count = 1, maxStack = 1): PlayerState {
  let next = { ...s, inventory: s.inventory.map((e) => ({ ...e })) };
  let left = count;
  if (maxStack > 1) {
    for (const e of next.inventory) {
      if (left <= 0) break;
      if (e.itemId !== itemId || e.count >= maxStack) continue;
      const put = Math.min(maxStack - e.count, left);
      e.count += put;
      left -= put;
    }
  }
  while (left > 0) {
    const put = Math.min(maxStack, left);
    let id: string;
    [id, next] = uid(next, 'i');
    next.inventory.push({ uid: id, itemId, count: put });
    left -= put;
  }
  return next;
}

/**
 * Перетащить запись инвентаря на место другой: то же зелье — докладывается до максимума стопки
 * (остаток остаётся), другое — меняются местами. toUid = null — в конец списка.
 */
export function moveInventory(s: PlayerState, fromUid: string, toUid: string | null, maxStack: (itemId: string) => number): PlayerState | null {
  const inv = [...s.inventory];
  const i = inv.findIndex((e) => e.uid === fromUid);
  if (i < 0 || fromUid === toUid) return null;
  if (toUid === null) {
    if (i === inv.length - 1) return null;
    const [e] = inv.splice(i, 1);
    return { ...s, inventory: [...inv, e] };
  }
  const j = inv.findIndex((e) => e.uid === toUid);
  if (j < 0) return null;
  const a = inv[i];
  const b = inv[j];
  const put = a.itemId === b.itemId ? Math.min(maxStack(a.itemId) - b.count, a.count) : 0;
  if (put > 0) {
    inv[j] = { ...b, count: b.count + put };
    if (a.count - put > 0) inv[i] = { ...a, count: a.count - put };
    else inv.splice(i, 1);
  } else {
    [inv[i], inv[j]] = [b, a];
  }
  return { ...s, inventory: inv };
}

/** Упорядочить инвентарь (кнопка «Сортировать»). */
export function sortInventory(s: PlayerState, cmp: (a: InventoryEntry, b: InventoryEntry) => number): PlayerState {
  return { ...s, inventory: [...s.inventory].sort(cmp) };
}

/** Убрать count штук из записи инвентаря. */
export function removeItem(s: PlayerState, entryUid: string, count = 1): PlayerState {
  return {
    ...s,
    inventory: s.inventory
      .map((e) => (e.uid === entryUid ? { ...e, count: e.count - count } : e))
      .filter((e) => e.count > 0),
  };
}

export function totalItemCount(s: PlayerState): number {
  return s.inventory.reduce((n, e) => n + e.count, 0);
}
