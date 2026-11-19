// Пресет снаряжения бойца: что в руках и артефактах, какой рюкзак и что в нём лежит.
// Надеть пресет: каждая вещь берётся из инвентаря (снаряжение — лучшего уровня), чего нет — собирается
// автосборкой; если чертёж не открыт или ещё ни разу не собран вручную, или не хватает кубов — вещь
// пропускается, а в отчёте сказано почему. Чистые функции, как и остальное ядро.
import { getBlueprint, getItem, hasItem, maxStackOf } from '../data/catalog';
import type { Blueprint, CharacterBlueprint } from '../data/types';
import { bagCapacity, characterStats, emptyBag, lv, requirementGap, slotAccepts } from './character';
import { canAutoCraft, completeCraft, craftCost } from './craft';
import { cubeCount, takeItems, uid, type CharacterState, type InventoryEntry, type PlayerState } from './state';

export interface EquipmentPreset {
  /** itemId по слотам чертежа (руки, артефакты); null — пусто. */
  equipment: Array<string | null>;
  /** Ячейки рюкзака: что и сколько. Уровень самого рюкзака в пресет не входит. */
  bag: Array<{ itemId: string; count: number } | null>;
}

export type PresetMiss = 'locked' | 'notLearned' | 'noCubes' | 'stats' | 'noRucksack';

export interface PresetReport {
  /** Взято из инвентаря (itemId, штук). */
  taken: Array<{ itemId: string; count: number }>;
  /** Собрано автосборкой (itemId, штук, кубов потрачено). */
  built: Array<{ itemId: string; count: number; cubes: number }>;
  /** Не получилось: что и почему. */
  missing: Array<{ itemId: string; count: number; reason: PresetMiss }>;
}

export const PRESET_MISS_LABEL: Record<PresetMiss, string> = {
  locked: 'чертёж не изучен',
  notLearned: 'чертёж ещё не собран вручную — автосборка недоступна',
  noCubes: 'не хватает кубов',
  stats: 'не хватает статов, чтобы надеть',
  noRucksack: 'не хватает ячеек рюкзака',
};

/** Снимок текущего снаряжения бойца. */
export function presetOf(c: CharacterState): EquipmentPreset {
  return {
    equipment: c.equipment.map((e) => e?.itemId ?? null),
    bag: (c.bag ?? []).map((e) => (e ? { itemId: e.itemId, count: e.count } : null)),
  };
}

/** Сколько ячеек пресетов у бойца. */
export const PRESET_SLOTS = 5;

/** Ячейки пресетов бойца (всегда PRESET_SLOTS); старый одиночный пресет — в первой. */
export function presetsOf(c: CharacterState): Array<EquipmentPreset | null> {
  const src = c.presets ?? [c.preset ?? null];
  return Array.from({ length: PRESET_SLOTS }, (_, i) => src[i] ?? null);
}

/** Совпадает ли то, что надето, с пресетом в ячейке slot. */
export function matchesPreset(c: CharacterState, slot = 0): boolean {
  const p = presetsOf(c)[slot];
  if (!p) return false;
  const cur = presetOf(c);
  const trim = (b: EquipmentPreset['bag']) => {
    const out = [...b];
    while (out.length && !out[out.length - 1]) out.pop();
    return JSON.stringify(out);
  };
  return JSON.stringify(cur.equipment) === JSON.stringify(p.equipment) && trim(cur.bag) === trim(p.bag);
}

const busy = (s: PlayerState, charUid: string) => s.arenaRun?.charUid === charUid && (s.arenaRun.wins > 0 || s.arenaRun.inBattle);
const withChar = (s: PlayerState, c: CharacterState): PlayerState => ({ ...s, characters: s.characters.map((x) => (x.uid === c.uid ? c : x)) });

/** Записать ячейки пресетов (старое поле `preset` больше не нужно). */
function withPresets(s: PlayerState, c: CharacterState, presets: Array<EquipmentPreset | null>): PlayerState {
  const { preset: _old, ...rest } = c;
  return withChar(s, { ...rest, presets });
}

/** Сохранить текущее снаряжение бойца в ячейку пресета slot (повторное сохранение — перезапись). */
export function savePreset(s: PlayerState, charUid: string, slot = 0): PlayerState | null {
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c || slot < 0 || slot >= PRESET_SLOTS) return null;
  const list = presetsOf(c);
  list[slot] = presetOf(c);
  return withPresets(s, c, list);
}

/** Очистить ячейку пресета. */
export function clearPreset(s: PlayerState, charUid: string, slot: number): PlayerState | null {
  const c = s.characters.find((x) => x.uid === charUid);
  const list = c ? presetsOf(c) : [];
  if (!c || !list[slot]) return null;
  list[slot] = null;
  return withPresets(s, c, list);
}

/** Вариант чертежа (зелье — стата, камень — стихия), который даёт этот предмет. */
function variantKeyFor(bp: Blueprint, itemId: string): string | undefined {
  return 'variants' in bp ? bp.variants.find((v) => v.itemId === itemId)?.key : undefined;
}

/** Собрать n штук предмета автосборкой. Возвращает новое состояние и сколько собрано; причина — если не всё. */
function build(s: PlayerState, itemId: string, n: number): { state: PlayerState; made: number; cubes: number; reason?: PresetMiss } {
  const bpId = hasItem(itemId) ? getItem(itemId).blueprintId : undefined;
  if (!bpId) return { state: s, made: 0, cubes: 0, reason: 'locked' };
  const bp = getBlueprint(bpId);
  if (!s.unlockedBlueprints.includes(bp.id)) return { state: s, made: 0, cubes: 0, reason: 'locked' };
  if (!canAutoCraft(s, bp.id)) return { state: s, made: 0, cubes: 0, reason: 'notLearned' };
  let next = s;
  let made = 0;
  for (; made < n; made++) {
    if (cubeCount(next) < craftCost(bp)) return { state: next, made, cubes: made * craftCost(bp), reason: 'noCubes' };
    const r = completeCraft(next, bp, { manual: false, variantKey: variantKeyFor(bp, itemId), maxStack: maxStackOf });
    if (!r) return { state: next, made, cubes: made * craftCost(bp), reason: 'noCubes' };
    next = r.state;
  }
  return { state: next, made, cubes: made * craftCost(bp) };
}

/** Забрать из инвентаря одну вещь снаряжения — лучшего уровня. */
function takeEquipment(s: PlayerState, itemId: string): [InventoryEntry, PlayerState] | null {
  const level = (e: InventoryEntry) => e.level ?? (getItem(e.itemId) as { itemLevel?: number }).itemLevel ?? 0;
  const pool = s.inventory.filter((e) => e.itemId === itemId).sort((a, b) => level(b) - level(a));
  const e = pool[0];
  if (!e) return null;
  const rest = e.count > 1 ? s.inventory.map((x) => (x.uid === e.uid ? { ...x, count: x.count - 1 } : x)) : s.inventory.filter((x) => x.uid !== e.uid);
  return [{ ...e, count: 1 }, { ...s, inventory: rest }];
}

/**
 * Надеть пресет: всё надетое и содержимое рюкзака уходит в инвентарь, затем слоты и ячейки
 * заполняются по пресету — из инвентаря, недостающее собирается автосборкой. null — нет пресета или боец в серии.
 */
export function applyPreset(s0: PlayerState, charUid: string, slot = 0): { state: PlayerState; report: PresetReport } | null {
  const c0 = s0.characters.find((x) => x.uid === charUid);
  const preset = c0 ? presetsOf(c0)[slot] : null;
  if (!c0 || !preset || busy(s0, charUid)) return null;
  const bp = getBlueprint(c0.blueprintId) as CharacterBlueprint;
  const stats = characterStats(bp, c0.blockStats);
  const report: PresetReport = { taken: [], built: [], missing: [] };
  const note = (list: Array<{ itemId: string; count: number }>, itemId: string, count: number) => {
    if (count <= 0) return;
    const r = list.find((x) => x.itemId === itemId);
    if (r) r.count += count;
    else list.push({ itemId, count });
  };
  const noteBuilt = (itemId: string, count: number, cubes: number) => {
    if (count <= 0) return;
    const r = report.built.find((x) => x.itemId === itemId);
    if (r) {
      r.count += count;
      r.cubes += cubes;
    } else report.built.push({ itemId, count, cubes });
  };

  // 1. всё снять в инвентарь
  let s: PlayerState = s0;
  const back = (it: { uid: string; itemId: string; level?: number } | null) => {
    if (it) s = { ...s, inventory: [...s.inventory, { uid: it.uid, itemId: it.itemId, count: 1, ...lv(it) }] };
  };
  c0.equipment.forEach(back);
  s = emptyBag(s, c0.bag);
  let c: CharacterState = { ...c0, equipment: c0.equipment.map(() => null), bag: [] };

  // одна вещь снаряжения: из инвентаря, иначе собрать
  const fetchOne = (itemId: string): InventoryEntry | null => {
    let got = takeEquipment(s, itemId);
    if (got) {
      s = got[1];
      note(report.taken, itemId, 1);
      return got[0];
    }
    const b = build(s, itemId, 1);
    s = b.state;
    if (!b.made) {
      miss(itemId, 1, b.reason ?? 'locked');
      return null;
    }
    noteBuilt(itemId, 1, b.cubes);
    got = takeEquipment(s, itemId);
    if (!got) return null;
    s = got[1];
    return got[0];
  };
  const miss = (itemId: string, count: number, reason: PresetMiss) => {
    const m = report.missing.find((x) => x.itemId === itemId && x.reason === reason);
    if (m) m.count += count;
    else report.missing.push({ itemId, count, reason });
  };

  // 2. руки и артефакты
  preset.equipment.forEach((itemId, i) => {
    if (!itemId || !hasItem(itemId) || i >= c.equipment.length) return;
    const item = getItem(itemId);
    if (!slotAccepts(bp, i, item)) return;
    if (requirementGap(item, stats) > 0) return miss(itemId, 1, 'stats');
    const e = fetchOne(itemId);
    if (e) c = { ...c, equipment: c.equipment.map((x, k) => (k === i ? { uid: e.uid, itemId: e.itemId, ...lv(e) } : x)) };
  });

  // 3. содержимое рюкзака
  const cap = bagCapacity(c);
  const bag: Array<InventoryEntry | null> = Array.from({ length: cap }, () => null);
  preset.bag.forEach((cell, k) => {
    if (!cell || !hasItem(cell.itemId) || getItem(cell.itemId).kind === 'potion' || getItem(cell.itemId).kind === 'bag') return;
    if (k >= cap) return miss(cell.itemId, cell.count, 'noRucksack');
    const max = maxStackOf(cell.itemId);
    if (max <= 1) {
      const e = fetchOne(cell.itemId);
      if (e) bag[k] = { ...e, count: 1 };
      return;
    }
    // стопка: сколько есть — из инвентаря, недостающее — собрать
    const want = Math.min(cell.count, max);
    const have = s.inventory.reduce((n, e) => (e.itemId === cell.itemId ? n + e.count : n), 0);
    if (have < want) {
      const b = build(s, cell.itemId, want - have);
      s = b.state;
      noteBuilt(cell.itemId, b.made, b.cubes);
      if (b.made < want - have) miss(cell.itemId, want - have - b.made, b.reason ?? 'locked');
    }
    const n = Math.min(want, s.inventory.reduce((acc, e) => (e.itemId === cell.itemId ? acc + e.count : acc), 0));
    if (n <= 0) return;
    note(report.taken, cell.itemId, Math.max(0, Math.min(n, have)));
    s = takeItems(s, cell.itemId, n) ?? s;
    let id: string;
    [id, s] = uid(s, 'i');
    bag[k] = { uid: id, itemId: cell.itemId, count: n };
  });
  c = { ...c, bag };
  return { state: withChar(s, c), report };
}
