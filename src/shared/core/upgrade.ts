// Прокачка оружия (doc mechanics.md, «Уровень снаряжения»; battle-rework этап 8):
// - 3 уровня; ур. 2 и 3 стоят точильных камней (combat.json → weaponLevels.cost) и дают свойства удара, а не урон;
// - ячейки камней — отдельно: каждая стоит один ювелирный набор (combat.json → gemCells), максимум 3;
// - качается оружие в инвентаре и надетое; боец на арене (идёт серия) не качается — противник уже подобран под его оружие.
// - камни вставляются в свободные ячейки и вынимаются обратно в инвентарь; эффект камня добавляется к удару оружия
//   (itemOf в core/character.ts); два одинаковых камня в одно оружие не ставятся — эффект не складывается.
// Чистые функции над PlayerState.
import { COMBAT, getItem, hasItem, maxStackOf } from '../data/catalog';
import { STATS, type Stat } from '../data/types';
import { WHETSTONE_ID, addItem, itemCount, takeItems, type CharacterState, type PlayerState } from './state';

/** Что качаем: запись инвентаря или оружие в слоте бойца. */
export type UpgradeTarget = { kind: 'inv'; uid: string } | { kind: 'equip'; charUid: string; slot: number } | { kind: 'bag'; charUid: string; cell: number };

type Entry = { itemId: string; level?: number; cells?: number; gems?: string[] };

/** Изменить запись оружия там, где она лежит: инвентарь, слот бойца или ячейка его рюкзака. */
function patchEntry(s: PlayerState, t: UpgradeTarget, fn: <T extends Entry>(e: T) => T): PlayerState {
  if (t.kind === 'inv') return { ...s, inventory: s.inventory.map((e) => (e.uid === t.uid ? fn(e) : e)) };
  return {
    ...s,
    characters: s.characters.map((c) => {
      if (c.uid !== t.charUid) return c;
      if (t.kind === 'equip') return { ...c, equipment: c.equipment.map((e, i) => (i === t.slot && e ? fn(e) : e)) };
      return { ...c, bag: c.bag.map((e, i) => (i === t.cell && e ? fn(e) : e)) };
    }),
  };
}

/** Камней, чтобы поднять оружие с уровня level на level + 1. */
export const upgradeCost = (level: number) => COMBAT.weaponLevels.cost[level - 1] ?? Infinity;
export const MAX_WEAPON_LEVEL = COMBAT.weaponLevels.max;
/** Ячеек камней в оружии — не больше. */
export const MAX_GEM_CELLS = COMBAT.gemCells.max;
/** Ювелирный набор: одна ячейка — один набор. */
export const JEWELER_ID = COMBAT.gemCells.itemId;

export interface UpgradeInfo {
  level: number;
  cost: number;
  have: number;
  /** Можно качать прямо сейчас. */
  ok: boolean;
  /** Почему нельзя (для подписи); нет — можно или просто не хватает камней. */
  reason?: 'max' | 'arena' | 'notWeapon';
}

function entryOf(s: PlayerState, t: UpgradeTarget): Entry | null {
  if (t.kind === 'inv') return s.inventory.find((e) => e.uid === t.uid) ?? null;
  const c = s.characters.find((x) => x.uid === t.charUid);
  return (t.kind === 'equip' ? c?.equipment[t.slot] : c?.bag[t.cell]) ?? null;
}

/** Уровень экземпляра: свой (лут, прокачка) или шаблона предмета. */
export function weaponLevelOf(e: { itemId: string; level?: number }): number {
  const it = getItem(e.itemId);
  return e.level ?? ('itemLevel' in it ? it.itemLevel : 1);
}

export function upgradeInfo(s: PlayerState, t: UpgradeTarget): UpgradeInfo | null {
  const e = entryOf(s, t);
  if (!e || !hasItem(e.itemId)) return null;
  const level = weaponLevelOf(e);
  const cost = upgradeCost(level);
  const have = itemCount(s, WHETSTONE_ID);
  let reason: UpgradeInfo['reason'];
  if (getItem(e.itemId).kind !== 'weapon') reason = 'notWeapon';
  else if (level >= MAX_WEAPON_LEVEL) reason = 'max';
  else if (t.kind !== 'inv' && s.arenaRun?.charUid === t.charUid) reason = 'arena';
  return { level, cost, have, ok: !reason && have >= cost, reason };
}

/** Поднять уровень оружия на 1, списав камни из инвентаря. null — нельзя. */
export function upgradeWeapon(s: PlayerState, t: UpgradeTarget): PlayerState | null {
  const info = upgradeInfo(s, t);
  if (!info?.ok) return null;
  const paid = takeItems(s, WHETSTONE_ID, info.cost);
  if (!paid) return null;
  const level = info.level + 1;
  return patchEntry(paid, t, (e) => ({ ...e, level }));
}

// ───────────── встроенные зелья и рюкзак ─────────────

export interface CharacterUpgradeInfo {
  level: number;
  max: number;
  cost: 1;
  have: number;
  ok: boolean;
  reason?: 'max' | 'notCharacter';
}

function patchCharacter(s: PlayerState, charUid: string, fn: (c: CharacterState) => CharacterState): PlayerState {
  return { ...s, characters: s.characters.map((c) => c.uid === charUid ? fn(c) : c) };
}

export function potionUpgradeInfo(s: PlayerState, charUid: string, stat: Stat): CharacterUpgradeInfo | null {
  if (!STATS.includes(stat)) return null;
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c) return null;
  const level = c.potions[stat].level;
  const max = COMBAT.characterUpgrades.potionLevels.length;
  const have = itemCount(s, COMBAT.characterUpgrades.alchemistKit);
  const reason = level >= max ? 'max' as const : undefined;
  return { level, max, cost: 1, have, ok: !reason && have >= 1, reason };
}

/** Улучшить одно зелье до следующего уровня и наполнить его. */
export function upgradePotion(s: PlayerState, charUid: string, stat: Stat): PlayerState | null {
  const info = potionUpgradeInfo(s, charUid, stat);
  if (!info?.ok) return null;
  const paid = takeItems(s, COMBAT.characterUpgrades.alchemistKit, 1);
  if (!paid) return null;
  const level = info.level + 1;
  const charges = COMBAT.characterUpgrades.potionLevels[level - 1].charges;
  return patchCharacter(paid, charUid, (c) => ({ ...c, potions: { ...c.potions, [stat]: { level, charges } } }));
}

export function rucksackUpgradeInfo(s: PlayerState, charUid: string): CharacterUpgradeInfo | null {
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c) return null;
  const level = c.rucksackLevel;
  const max = COMBAT.characterUpgrades.rucksackLevels.length;
  const have = itemCount(s, COMBAT.characterUpgrades.leatherworkerKit);
  const reason = level >= max ? 'max' as const : undefined;
  return { level, max, cost: 1, have, ok: !reason && have >= 1, reason };
}

/** Увеличить постоянный рюкзак на следующий уровень, содержимое сохраняется. */
export function upgradeRucksack(s: PlayerState, charUid: string): PlayerState | null {
  const info = rucksackUpgradeInfo(s, charUid);
  if (!info?.ok) return null;
  const paid = takeItems(s, COMBAT.characterUpgrades.leatherworkerKit, 1);
  return paid ? patchCharacter(paid, charUid, (c) => ({ ...c, rucksackLevel: info.level + 1 })) : null;
}

// ───────────── ячейки камней (ювелирный набор) ─────────────

export interface CellInfo {
  /** Ячеек сейчас. */
  cells: number;
  max: number;
  /** Ювелирных наборов в инвентаре. */
  have: number;
  ok: boolean;
  reason?: 'max' | 'arena' | 'notWeapon';
}

/** Ячеек у экземпляра оружия: свои (ювелирный набор) или шаблона предмета. */
export function cellsOf(e: { itemId: string; cells?: number }): number {
  const it = getItem(e.itemId);
  return e.cells ?? ('gemSlots' in it ? it.gemSlots : 0);
}

export function cellInfo(s: PlayerState, t: UpgradeTarget): CellInfo | null {
  const e = entryOf(s, t);
  if (!e || !hasItem(e.itemId)) return null;
  const cells = cellsOf(e);
  const have = itemCount(s, JEWELER_ID);
  let reason: CellInfo['reason'];
  if (getItem(e.itemId).kind !== 'weapon') reason = 'notWeapon';
  else if (cells >= MAX_GEM_CELLS) reason = 'max';
  else if (t.kind !== 'inv' && s.arenaRun?.charUid === t.charUid) reason = 'arena';
  return { cells, max: MAX_GEM_CELLS, have, ok: !reason && have >= 1, reason };
}

/** Создать ячейку камня в оружии, потратив ювелирный набор. null — нельзя. */
export function addGemCell(s: PlayerState, t: UpgradeTarget): PlayerState | null {
  const info = cellInfo(s, t);
  if (!info?.ok) return null;
  const paid = takeItems(s, JEWELER_ID, 1);
  if (!paid) return null;
  const cells = info.cells + 1;
  return patchEntry(paid, t, (e) => ({ ...e, cells }));
}

// ───────────── камни в ячейках ─────────────

export interface GemInfo {
  /** Ячеек у оружия. */
  cells: number;
  /** Вставленные камни по порядку ячеек (id предметов). */
  gems: string[];
  /** Камни из инвентаря, которые можно вставить сейчас: id предмета и сколько штук. */
  available: Array<{ itemId: string; count: number }>;
  /** Почему нельзя менять камни; нет — можно. */
  reason?: 'arena' | 'notWeapon';
}

/** Запись оружия с новым набором камней. */
function withGems(s: PlayerState, t: UpgradeTarget, gems: string[]): PlayerState {
  return patchEntry(s, t, (e) => {
    const { gems: _old, ...rest } = e;
    return (gems.length ? { ...rest, gems } : rest) as typeof e;
  });
}

export function gemInfo(s: PlayerState, t: UpgradeTarget): GemInfo | null {
  const e = entryOf(s, t);
  if (!e || !hasItem(e.itemId)) return null;
  const gems = (e.gems ?? []).filter((id) => hasItem(id));
  let reason: GemInfo['reason'];
  if (getItem(e.itemId).kind !== 'weapon') reason = 'notWeapon';
  else if (t.kind !== 'inv' && s.arenaRun?.charUid === t.charUid) reason = 'arena';
  const counts = new Map<string, number>();
  for (const x of s.inventory) if (hasItem(x.itemId) && getItem(x.itemId).kind === 'gem' && !gems.includes(x.itemId)) counts.set(x.itemId, (counts.get(x.itemId) ?? 0) + x.count);
  return { cells: cellsOf(e), gems, available: [...counts].map(([itemId, count]) => ({ itemId, count })), reason };
}

/** Вставить камень из инвентаря в свободную ячейку оружия. null — нельзя. */
export function insertGem(s: PlayerState, t: UpgradeTarget, gemId: string): PlayerState | null {
  const info = gemInfo(s, t);
  if (!info || info.reason || info.gems.length >= info.cells) return null;
  if (!info.available.some((g) => g.itemId === gemId)) return null;
  const paid = takeItems(s, gemId, 1);
  return paid ? withGems(paid, t, [...info.gems, gemId]) : null;
}

/** Вынуть камень из ячейки обратно в инвентарь. null — нельзя. */
export function removeGem(s: PlayerState, t: UpgradeTarget, cell: number): PlayerState | null {
  const info = gemInfo(s, t);
  if (!info || info.reason) return null;
  const gemId = info.gems[cell];
  if (!gemId) return null;
  return addItem(withGems(s, t, info.gems.filter((_, i) => i !== cell)), gemId, 1, maxStackOf(gemId));
}

/** Вернуть в инвентарь камни оружия, которое уходит (разборка). */
export function returnGems(s: PlayerState, gems: readonly string[] | undefined): PlayerState {
  let next = s;
  for (const id of gems ?? []) if (hasItem(id)) next = addItem(next, id, 1, maxStackOf(id));
  return next;
}
