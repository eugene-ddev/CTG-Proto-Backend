// Действия игрока — единственный способ изменить состояние. Клиент исполняет действие сразу (store.act) и
// отправляет его на сервер; сервер исполняет то же действие над состоянием из базы (RPC player/act) и сверяет итог.
// Аргументы — только данные (JSON). Время и случайность — из ctx, чтобы обе стороны получили одно и то же.
// Новое изменение состояния = новая строка здесь; сцены состояние напрямую не меняют.
import { getBlueprint, getItem, hasBlueprint, ITEMS, maxStackOf } from '../data/catalog';
import type { ItemKind, Stat } from '../data/types';
import {
  convertShards, drinkPotion, endRun, equipFromBag, healFull, lobbyRegen, lootClose, lootDrop, lootTake, repairAll, startFight, startRun, stowToBag,
  stowToBagCell, surrenderRun, type PotionSource,
} from './arena';
import {
  discardFromBag, disassembleCharacter, equip, moveEquipped, moveInBag, putInBag, renameCharacter, setCharacterTarget, takeFromBag, unequip,
  type SlotRef,
} from './character';
import { withClock } from './clock';
import { completeCraft, disassembleItem, disassembleMany, unlockBlueprint } from './craft';
import { applyTarget, type CraftTarget } from './craftTarget';
import { applyCharacterEdit } from './edit';
import { resolveFight, type FightInputs } from './fight';
import { applyPreset, clearPreset, savePreset } from './preset';
import { addCubes, addItem, moveInventory, sortInventory, type InventoryEntry, type PlayerState } from './state';
import { addGemCell, insertGem, removeGem, upgradeWeapon, type UpgradeTarget } from './upgrade';

export interface ActionCtx {
  /** Время действия, мс (часы сервера; клиент присылает свою оценку). */
  now: number;
  /** Случайное зерно действия (uint32). */
  seed: number;
}

const blueprintOf = (itemId: string) => {
  const bpId = getItem(itemId).blueprintId;
  return bpId ? getBlueprint(bpId) : undefined;
};

const KIND_ORDER: ItemKind[] = ['resource', 'weapon', 'artifact', 'gem', 'potion', 'bag'];
/** Порядок «Сортировать»: по типу, затем по имени, полные стопки раньше. Сравнение имён — по кодам символов: одинаково в браузере и на сервере. */
function byKindAndName(a: InventoryEntry, b: InventoryEntry): number {
  const ia = getItem(a.itemId), ib = getItem(b.itemId);
  return KIND_ORDER.indexOf(ia.kind) - KIND_ORDER.indexOf(ib.kind) || (ia.name < ib.name ? -1 : ia.name > ib.name ? 1 : 0) || b.count - a.count;
}

export interface CraftArgs {
  blueprintId: string;
  /** true — собрано вручную (открывает автосборку). */
  manual: boolean;
  variantKey?: string;
  /** У персонажа: стата каждого блока. */
  blockStats?: Stat[];
  /** Сколько штук (автосборка); по умолчанию 1. Собирается, сколько хватает кубов, но не меньше одной. */
  count?: number;
}

type S = PlayerState;
type R = PlayerState | null;

export const ACTIONS = {
  // ── время ──
  /** Починка кубов в лобби по часам. */
  tick: (s: S, ctx: ActionCtx): R => lobbyRegen(s, ctx.now),

  // ── сборка и чертежи ──
  craft: (s: S, _c: ActionCtx, a: CraftArgs): R => {
    if (!hasBlueprint(a.blueprintId)) return null;
    const bp = getBlueprint(a.blueprintId);
    const opts = { manual: a.manual, variantKey: a.variantKey, maxStack: maxStackOf, blockStats: a.blockStats };
    let r = completeCraft(s, bp, opts);
    const count = a.manual ? 1 : Math.max(1, Math.min(99, Math.floor(a.count ?? 1)));
    for (let k = 1; r && k < count; k++) {
      const more = completeCraft(r.state, bp, opts);
      if (!more) break;
      r = more;
    }
    return r ? r.state : null;
  },
  craftToTarget: (s: S, _c: ActionCtx, target: CraftTarget, itemId: string): R => applyTarget(s, target, itemId),
  unlockBlueprint: (s: S, _c: ActionCtx, blueprintId: string): R => unlockBlueprint(s, blueprintId),
  disassembleItem: (s: S, _c: ActionCtx, entryUid: string): R => disassembleItem(s, entryUid, blueprintOf),
  disassembleMany: (s: S, _c: ActionCtx, entryUids: string[]): R => disassembleMany(s, entryUids, blueprintOf),
  convertShards: (s: S): R => convertShards(s),

  // ── инвентарь ──
  moveInventory: (s: S, _c: ActionCtx, fromUid: string, toUid: string | null): R => moveInventory(s, fromUid, toUid, maxStackOf),
  sortInventory: (s: S): R => sortInventory(s, byKindAndName),

  // ── персонаж ──
  setActiveCharacter: (s: S, _c: ActionCtx, charUid: string): R =>
    s.arenaRun || !s.characters.some((c) => c.uid === charUid) ? null : { ...s, lastArenaCharacterId: charUid },
  renameCharacter: (s: S, _c: ActionCtx, charUid: string, name: string): R => renameCharacter(s, charUid, name),
  editCharacter: (s: S, _c: ActionCtx, charUid: string, cells: Array<Stat | null>): R => applyCharacterEdit(s, charUid, cells),
  disassembleCharacter: (s: S, _c: ActionCtx, charUid: string): R => disassembleCharacter(s, charUid),
  setTarget: (s: S, _c: ActionCtx, charUid: string, order: Stat[]): R => setCharacterTarget(s, charUid, order),
  repairAll: (s: S, _c: ActionCtx, charUid: string): R => repairAll(s, charUid),
  drinkPotion: (s: S, _c: ActionCtx, charUid: string, src: PotionSource, prefer?: number | null): R => drinkPotion(s, charUid, src, prefer ?? undefined),

  // ── снаряжение и рюкзак ──
  equip: (s: S, _c: ActionCtx, charUid: string, slot: SlotRef, invUid: string): R => equip(s, charUid, slot, invUid),
  unequip: (s: S, _c: ActionCtx, charUid: string, slot: SlotRef): R => unequip(s, charUid, slot),
  moveEquipped: (s: S, _c: ActionCtx, charUid: string, from: number, to: number): R => moveEquipped(s, charUid, from, to),
  putInBag: (s: S, _c: ActionCtx, charUid: string, cell: number, invUid: string): R => putInBag(s, charUid, cell, invUid),
  takeFromBag: (s: S, _c: ActionCtx, charUid: string, cell: number): R => takeFromBag(s, charUid, cell),
  moveInBag: (s: S, _c: ActionCtx, charUid: string, from: number, to: number): R => moveInBag(s, charUid, from, to),
  discardFromBag: (s: S, _c: ActionCtx, charUid: string, cell: number): R => discardFromBag(s, charUid, cell)?.state ?? null,
  equipFromBag: (s: S, _c: ActionCtx, charUid: string, cell: number, slot: number): R => equipFromBag(s, charUid, cell, slot),
  stowToBag: (s: S, _c: ActionCtx, charUid: string, slot: number): R => stowToBag(s, charUid, slot),
  stowToBagCell: (s: S, _c: ActionCtx, charUid: string, slot: number, cell: number): R => stowToBagCell(s, charUid, slot, cell),
  savePreset: (s: S, _c: ActionCtx, charUid: string, slot: number): R => savePreset(s, charUid, slot),
  clearPreset: (s: S, _c: ActionCtx, charUid: string, slot: number): R => clearPreset(s, charUid, slot),
  applyPreset: (s: S, _c: ActionCtx, charUid: string, slot: number): R => applyPreset(s, charUid, slot)?.state ?? null,

  // ── оружие ──
  upgradeWeapon: (s: S, _c: ActionCtx, target: UpgradeTarget): R => upgradeWeapon(s, target),
  addGemCell: (s: S, _c: ActionCtx, target: UpgradeTarget): R => addGemCell(s, target),
  /** Камень в ячейку: gemId null — вынуть; replace — в ячейке уже есть камень (он возвращается в инвентарь). */
  setGem: (s: S, _c: ActionCtx, target: UpgradeTarget, cell: number, gemId: string | null, replace: boolean): R => {
    const cleared = replace ? removeGem(s, target, cell) : s;
    return cleared && gemId ? insertGem(cleared, target, gemId) : cleared;
  },

  // ── серия арены ──
  // Противника (startRun) и зерно боя (startFight) выбирает сервер — см. SERVER_SEEDED. Итог боя не присылается:
  // finishFight получает только ввод игрока и пересчитывает бой (core/fight.ts).
  startRun: (s: S, ctx: ActionCtx, charUid: string): R => startRun(s, charUid, ctx.seed),
  startFight: (s: S, ctx: ActionCtx): R => startFight(s, ctx.seed),
  finishFight: (s: S, _c: ActionCtx, inputs: FightInputs): R => resolveFight(s, inputs ?? {})?.state ?? null,
  // из начатого боя серию не закрыть — только итогом боя (finishFight), иначе от поражения можно было бы уйти
  surrenderRun: (s: S): R => (s.arenaRun?.inBattle ? null : surrenderRun(s)?.state ?? null),
  endRun: (s: S): R => (s.arenaRun?.inBattle ? null : endRun(s)),
  /** Журнал нападений прочитан. */
  inboxClear: (s: S): R => (s.inbox?.length ? { ...s, inbox: [] } : s),
  lootTake: (s: S, _c: ActionCtx, index: number, cell?: number | null): R => lootTake(s, index, cell ?? undefined)?.state ?? null,
  lootDrop: (s: S, _c: ActionCtx, cell: number): R => lootDrop(s, cell),
  lootClose: (s: S): R => lootClose(s),

  // ── отладка (сервер исполняет только в режиме отладки) ──
  debugAddCubes: (s: S, _c: ActionCtx, amount: number): R => addCubes(s, Math.max(0, Math.min(10000, Math.floor(amount)))),
  debugGiveAllItems: (s: S): R => ITEMS.filter((i) => i.blueprintId).reduce((acc, i) => addItem(acc, i.id, 1, maxStackOf(i.id)), s),
  debugHeal: (s: S, _c: ActionCtx, charUid: string): R => healFull(s, charUid),
} satisfies Record<string, (s: PlayerState, ctx: ActionCtx, ...args: never[]) => PlayerState | null>;

/**
 * Типы аргументов действий — сервер получает их от клиента как есть и обязан проверить до исполнения:
 * индекс «null» или «1.5» иначе записался бы в массив как свойство, мимо ячеек.
 * s — строка, i — целое ≥ 0, b — логическое, o — объект, a — массив, r — слот (целое ≥ 0 или 'rucksack');
 * «?» после типа — аргумент можно не передавать (undefined или null).
 */
export const ACTION_ARGS: Record<keyof typeof ACTIONS, string> = {
  tick: '',
  craft: 'o',
  craftToTarget: 'o s',
  unlockBlueprint: 's',
  disassembleItem: 's',
  disassembleMany: 'a',
  convertShards: '',
  moveInventory: 's s?',
  sortInventory: '',
  setActiveCharacter: 's',
  renameCharacter: 's s',
  editCharacter: 's a',
  disassembleCharacter: 's',
  setTarget: 's a',
  repairAll: 's',
  drinkPotion: 's o i?',
  equip: 's r s',
  unequip: 's r',
  moveEquipped: 's i i',
  putInBag: 's i s',
  takeFromBag: 's i',
  moveInBag: 's i i',
  discardFromBag: 's i',
  equipFromBag: 's i i',
  stowToBag: 's i',
  stowToBagCell: 's i i',
  savePreset: 's i',
  clearPreset: 's i',
  applyPreset: 's i',
  upgradeWeapon: 'o',
  addGemCell: 'o',
  setGem: 'o i s? b',
  startRun: 's',
  startFight: '',
  finishFight: 'o',
  surrenderRun: '',
  endRun: '',
  inboxClear: '',
  lootTake: 'i i?',
  lootDrop: 'i',
  lootClose: '',
  debugAddCubes: 'i',
  debugGiveAllItems: '',
  debugHeal: 's',
};

const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function argOk(type: string, v: unknown): boolean {
  if (type.charAt(type.length - 1) === '?') return v === undefined || v === null || argOk(type.slice(0, -1), v);
  switch (type) {
    case 's': return typeof v === 'string' && v.length <= 200;
    case 'i': return isIndex(v);
    case 'b': return typeof v === 'boolean';
    case 'o': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'a': return Array.isArray(v) && v.length <= 1000;
    case 'r': return isIndex(v) || v === 'rucksack';
    default: return false;
  }
}

/** Подходят ли аргументы действию по типам; лишние аргументы — ошибка. */
export function argsValid(name: keyof typeof ACTIONS, args: readonly unknown[]): boolean {
  const types = ACTION_ARGS[name] ? ACTION_ARGS[name].split(' ') : [];
  if (args.length > types.length) return false;
  return types.every((type, i) => argOk(type, args[i]));
}

export type ActionName = keyof typeof ACTIONS;
export type ActionArgs<K extends ActionName> = (typeof ACTIONS)[K] extends (s: PlayerState, ctx: ActionCtx, ...args: infer A) => unknown ? A : never;

export const isAction = (name: string): name is ActionName => Object.prototype.hasOwnProperty.call(ACTIONS, name);
export const isDebugAction = (name: string) => name.indexOf('debug') === 0;
/**
 * Действия, зерно которых выбирает сервер (противник, бой): клиент их не предсказывает — ждёт ответ и берёт
 * состояние сервера (store.request). Иначе зерно можно было бы перебирать.
 */
export const isServerSeeded = (name: string) => name === 'startRun' || name === 'startFight';

/** Действие в очереди на сервер. */
export interface ActionCall {
  name: string;
  args: unknown[];
  now: number;
  seed: number;
}

/**
 * Исполнить действие. null — действие отклонено (нет такого, не выполнены условия, плохие аргументы);
 * то же состояние — действие ничего не изменило.
 */
export function applyAction(s: PlayerState, name: string, args: readonly unknown[], ctx: ActionCtx): PlayerState | null {
  if (!isAction(name)) return null;
  // аргументы приходят и напрямую, и через JSON (сервер): там undefined в массиве становится null —
  // необязательные аргументы действия обязаны понимать оба значения одинаково (см. тест «через JSON»)
  if (!argsValid(name, args)) return null;
  const fn = ACTIONS[name] as (s: PlayerState, ctx: ActionCtx, ...args: unknown[]) => PlayerState | null;
  try {
    return withClock(ctx.now, () => fn(s, ctx, ...args));
  } catch {
    return null;
  }
}

/** JSON с ключами по алфавиту: порядок ключей после базы данных не сохраняется, отпечаток от него зависеть не должен. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Отпечаток состояния: клиент и сервер сверяют итог действий (djb2 по JSON с упорядоченными ключами). */
export function stateHash(s: PlayerState): string {
  const text = canonical(s);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(16)}`;
}
