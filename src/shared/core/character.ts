// Персонаж из скрафченной модели: снаряжение, имя, расчёт стат по формулам из доки
// (таб «Статы», «Бой», «Снаряжение»). Чистые функции без Phaser.
import { COMBAT, getBlueprint, getItem, hasItem, maxStackOf as stackOf, weaponStrike } from '../data/catalog';
import { weaponLevelName } from '../data/weaponLooks';
import { STATS, type CharacterBlueprint, type EquipmentItem, type Item, type Stat } from '../data/types';
import { disassemblyRefund } from './craft';
import { addCubes, addItem, uid, type CharacterState, type EquippedItem, type InventoryEntry, type PlayerState } from './state';

/** Слот персонажа: индекс слота чертежа (руки, артефакты) или рюкзак. */
export type SlotRef = number | 'rucksack';
export const NAME_MAX = 16;

// ───────────── статы ─────────────

/** Очков стат на чертёж / кубов (бэкенд, справочно). В Sandbox Arena куб даёт ровно 1 очко. */
export function pointsPerCube(bp: CharacterBlueprint): number {
  return bp.statsPoints / bp.blocks.length;
}

/**
 * Стата как в Sandbox Arena клиента (SandboxStats.Build): базовая стата чертежа + число кубов.
 * Стамина = Выносливость, мана = Интеллект.
 */
export const statValue = (bp: CharacterBlueprint, s: Stat, cubes: number) => (bp.baseStats[s] ?? 0) + cubes;

/** Шанс крита/уворота: без базы, асимптота 75%, при score = 60 — 37.5%. */
export const procChance = (score: number) => (score <= 0 ? 0 : (0.75 * score) / (60 + score));
export const critChance = (luck: number, str: number) => procChance(0.8 * luck + 0.2 * str);
export const dodgeChance = (luck: number, dex: number) => procChance(0.8 * luck + 0.2 * dex);

/** Доля физ. урона, которую режет броня (против атакующего уровня attackerLevel), не больше 85%. */
export function armorAbsorb(armor: number, attackerLevel = 1): number {
  if (armor <= 0) return 0;
  return Math.min(armor / (armor + 50 * (1 + 0.35 * (attackerLevel - 1))), 0.85);
}

/** Scaling из формулы урона: 70% от статы (эталон 100), 30% от уровня предмета (эталон 20). */
export const damageScaling = (stat: number, level: number) => 1 + 3 * (0.7 * (stat / 100) + 0.3 * (level / 20));
/**
 * Уровень, который идёт в формулу урона (этап 8): урон от уровня оружия не растёт — уровни дают свойства удара,
 * в формулу всегда подставляется 1 (баланс подбирался на 1-м уровне).
 */
export const DAMAGE_LEVEL = 1;
/** Condition: −2.5% за потерянное очко статы, пол 30%. */
export const damageCondition = (baseStat: number, currentStat: number) => Math.min(1, Math.max(0.3, 1 - 0.025 * (baseStat - currentStat)));

export interface CharacterStats {
  /** Стата на входе в бой: базовая стата чертежа + кубы (Sandbox). */
  base: Record<Stat, number>;
  /** Текущая: −1 за каждый разбитый куб этой статы, как в клиенте. */
  current: Record<Stat, number>;
  /** Кубов каждой статы (живых). */
  cubes: Record<Stat, number>;
  pointsPerCube: number;
  aliveBlocks: number;
  totalBlocks: number;
  crit: number;
  dodge: number;
  maxStamina: number;
  maxMana: number;
  /** Броня против атакующего 1-го уровня. */
  armorAbsorb: number;
  /** Статы без единого куба в сборке — отключены, как порогом в бою (statThresholds). */
  disabled: Stat[];
}

const zero = (): Record<Stat, number> => Object.fromEntries(STATS.map((s) => [s, 0])) as Record<Stat, number>;

export function characterStats(bp: CharacterBlueprint, blockStats: readonly Stat[], broken: readonly number[] = []): CharacterStats {
  const ppc = pointsPerCube(bp);
  const all = zero();
  const alive = zero();
  const dead = new Set(broken);
  blockStats.forEach((s, i) => {
    all[s] += 1;
    if (!dead.has(i)) alive[s] += 1;
  });
  const base = zero();
  const current = zero();
  for (const s of STATS) {
    base[s] = statValue(bp, s, all[s]);
    // в бою клиент снимает по 1 очку за разбитый куб (Stats.AdjustStats), не долю куба
    current[s] = Math.max(0, base[s] - (all[s] - alive[s]));
  }
  return {
    base,
    current,
    cubes: alive,
    pointsPerCube: ppc,
    aliveBlocks: blockStats.length - dead.size,
    totalBlocks: blockStats.length,
    // крит — только при живом кубе Силы, уворот — Ловкости
    crit: alive.Strength > 0 && all.Luck > 0 ? critChance(current.Luck, current.Strength) : 0,
    dodge: alive.Dexterity > 0 ? dodgeChance(current.Luck, current.Dexterity) : 0,
    maxStamina: current.Stamina,
    maxMana: current.Intelligence,
    armorAbsorb: armorAbsorb(current.Armor),
    disabled: COMBAT.statThresholds.stats.filter((s) => all[s] === 0),
  };
}

/** Стата, от которой растёт урон предмета: только Сила или Ловкость, у остального 1. */
export function scalingStatValue(item: EquipmentItem, stats: CharacterStats, which: 'base' | 'current' = 'base'): number {
  return item.scalingStat === 'Strength' || item.scalingStat === 'Dexterity' ? stats[which][item.scalingStat] : 1;
}

export interface SlotDamage {
  /** Урон одного удара этим бойцом (без крита и брони), с множителем свойства уровня. */
  damage: number;
  /** Ударов за ход — с учётом свойства уровня. */
  hits: number;
  /** Урон за ход для баланса: damage × ударов / max(1, cooldown). */
  perTurn: number;
  scaling: number;
  condition: number;
}

export function slotDamage(item: EquipmentItem, stats: CharacterStats): SlotDamage {
  const baseStat = scalingStatValue(item, stats, 'base');
  const currentStat = scalingStatValue(item, stats, 'current');
  const scaling = damageScaling(baseStat, DAMAGE_LEVEL);
  const condition = damageCondition(baseStat, currentStat);
  // нет кубов Силы — силовое оружие бьёт со штрафом, как при отключённой Силе в бою
  const penalty = item.scalingStat === 'Strength' && stats.disabled.includes('Strength') ? COMBAT.statThresholds.strengthWeaponMultiplier : 1;
  // свойство уровня меняет число ударов и урон одного удара (кинжал ур. 2–3) — как в бою
  const strike = weaponStrike(item);
  const k = scaling * condition * penalty;
  const damage = item.ability.damage * k * strike.multiplier;
  return { damage, hits: strike.hits, perTurn: (damage * strike.hits) / Math.max(1, item.ability.cooldown), scaling, condition };
}

/** Сколько очков скалирующей статы не хватает, чтобы надеть предмет (0 — хватает). */
export function requirementGap(item: Item, stats: CharacterStats): number {
  if (item.kind !== 'weapon' && item.kind !== 'artifact') return 0;
  return Math.max(0, item.minStatRequired - stats.base[item.scalingStat]);
}

// ───────────── слоты ─────────────

export function slotCount(bp: CharacterBlueprint): number {
  return bp.slots.length;
}

export function slotLabel(bp: CharacterBlueprint, slot: SlotRef): string {
  if (slot === 'rucksack') return 'Рюкзак';
  const s = bp.slots[slot];
  if (s.type === 'Hand') return s.isLeftHand ? 'Левая рука' : 'Правая рука';
  const n = bp.slots.slice(0, slot + 1).filter((x) => x.type === s.type).length;
  return `Артефакт ${n}`;
}

/** Подходит ли предмет в слот по типу. Подсумок не используется — его никуда не надеть. */
export function slotAccepts(bp: CharacterBlueprint, slot: SlotRef, item: Item): boolean {
  if (slot === 'rucksack') return item.kind === 'bag' && item.slot === 'Rucksack' && !item.unused;
  const s = bp.slots[slot];
  if (!s) return false;
  if (s.type === 'Hand') return item.kind === 'weapon' && item.slot === 'Hand';
  if (s.type === 'Artifact') return item.kind === 'artifact' && item.slot === 'Artifact';
  return false;
}

/** Все слоты персонажа по порядку: слоты чертежа, затем рюкзак. */
export function allSlots(bp: CharacterBlueprint): SlotRef[] {
  return [...bp.slots.map((_, i) => i), 'rucksack'];
}

/** Можно ли надеть предмет вообще (тип подходит хоть в один слот). */
export function isEquippable(item: Item): boolean {
  return (item.kind === 'weapon' || item.kind === 'artifact' || (item.kind === 'bag' && !item.unused && item.slot === 'Rucksack'));
}

export function validName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, ' ');
  return n.length >= 1 && n.length <= NAME_MAX ? n : null;
}

// ───────────── операции ─────────────

/** Уровень экземпляра — переносится вместе с предметом между инвентарём, слотами и рюкзаком. */
export const lv = (e: { level?: number; cells?: number; gems?: string[] }) => ({
  ...(e.level !== undefined ? { level: e.level } : {}),
  ...(e.cells !== undefined ? { cells: e.cells } : {}),
  ...(e.gems?.length ? { gems: [...e.gems] } : {}),
});

/** Предмет записи с уровнем экземпляра (лут с бота): снаряжение получает свой itemLevel. */
export function itemOf(e: { itemId: string; level?: number; cells?: number; gems?: string[] }): Item {
  const it = getItem(e.itemId);
  if (it.kind !== 'weapon' && it.kind !== 'artifact') return it;
  if (e.level === undefined && e.cells === undefined && !e.gems?.length) return it;
  // вставленные камни добавляют свои эффекты к удару оружия
  const gemEffects = (e.gems ?? []).flatMap((id) => {
    const gem = hasItem(id) ? getItem(id) : null;
    return gem?.kind === 'gem' ? gem.effects : [];
  });
  const effects = [...it.ability.effects, ...gemEffects.filter((id) => !it.ability.effects.includes(id))];
  return {
    ...it,
    ...(e.level !== undefined ? { itemLevel: e.level } : {}),
    // название по уровню: «Меч» → «Улучшенный меч» → «Сияющий меч»
    ...(it.kind === 'weapon' && e.level !== undefined ? { name: weaponLevelName(it.name, e.level) } : {}),
    ...(e.cells !== undefined ? { gemSlots: e.cells } : {}),
    ...(gemEffects.length ? { ability: { ...it.ability, effects }, gems: [...(e.gems ?? [])] } : {}),
  };
}

/** Забрать один предмет из записи инвентаря: стопка уменьшается, uid надетого — свой. */
function takeFromInventory(s: PlayerState, invUid: string): [EquippedItem, PlayerState] | null {
  const e = s.inventory.find((x) => x.uid === invUid);
  if (!e) return null;
  if (e.count <= 1) return [{ uid: e.uid, itemId: e.itemId, ...lv(e) }, { ...s, inventory: s.inventory.filter((x) => x.uid !== invUid) }];
  const [id, next] = uid(s, 'i');
  return [{ uid: id, itemId: e.itemId, ...lv(e) }, { ...next, inventory: next.inventory.map((x) => (x.uid === invUid ? { ...x, count: x.count - 1 } : x)) }];
}

/** Вернуть надетый предмет в инвентарь (снаряжение не стакается). */
function putBack(s: PlayerState, it: EquippedItem | null): PlayerState {
  if (!it) return s;
  return { ...s, inventory: [...s.inventory, { uid: it.uid, itemId: it.itemId, count: 1, ...lv(it) }] };
}

/** Боец в серии арены: снаряжение и рюкзак меняются только между боями, из рюкзака (core/arena). */
const busy = (s: PlayerState, charUid: string) => s.arenaRun?.charUid === charUid && (s.arenaRun.wins > 0 || s.arenaRun.inBattle);

function updateCharacter(s: PlayerState, charUid: string, fn: (c: CharacterState, s: PlayerState) => [CharacterState, PlayerState] | null, allowInRun = false): PlayerState | null {
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c || (!allowInRun && busy(s, charUid))) return null;
  const r = fn(c, s);
  if (!r) return null;
  const [nc, ns] = r;
  return { ...ns, characters: ns.characters.map((x) => (x.uid === charUid ? nc : x)) };
}

const slotGet = (c: CharacterState, slot: SlotRef) => (slot === 'rucksack' ? c.rucksack : c.equipment[slot] ?? null);
const slotSet = (c: CharacterState, slot: SlotRef, it: EquippedItem | null): CharacterState =>
  slot === 'rucksack' ? { ...c, rucksack: it } : { ...c, equipment: c.equipment.map((x, i) => (i === slot ? it : x)) };

/** Надеть предмет из инвентаря; то, что было в слоте, возвращается в инвентарь. */
export function equip(s: PlayerState, charUid: string, slot: SlotRef, invUid: string): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const bp = getBlueprint(c.blueprintId) as CharacterBlueprint;
    const e = st.inventory.find((x) => x.uid === invUid);
    if (!e || !hasItem(e.itemId)) return null;
    const item = getItem(e.itemId);
    if (!slotAccepts(bp, slot, item)) return null;
    if (requirementGap(item, characterStats(bp, c.blockStats)) > 0) return null;
    const taken = takeFromInventory(st, invUid);
    if (!taken) return null;
    let next = putBack(taken[1], slotGet(c, slot));
    let nc = slotSet(c, slot, taken[0]);
    if (slot === 'rucksack' && item.kind === 'bag') {
      // рюкзак сменили на меньший — что не поместилось, уходит в инвентарь
      next = emptyBag(next, c.bag.slice(item.capacity));
      nc = { ...nc, bag: c.bag.slice(0, item.capacity) };
    }
    return [nc, next];
  });
}

/** Снять предмет в инвентарь. */
/**
 * Перенести надетый предмет в другой слот (оружие — из руки в руку, артефакт — между слотами артефактов).
 * В занятом слоте предметы меняются местами. null — слот не подходит предмету или переносить нечего.
 */
export function moveEquipped(s: PlayerState, charUid: string, from: number, to: number): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const bp = getBlueprint(c.blueprintId) as CharacterBlueprint;
    const a = c.equipment[from] ?? null;
    const b = c.equipment[to] ?? null;
    if (from === to || !a || !bp.slots[from] || !bp.slots[to]) return null;
    if (!hasItem(a.itemId) || !slotAccepts(bp, to, getItem(a.itemId))) return null;
    if (b && (!hasItem(b.itemId) || !slotAccepts(bp, from, getItem(b.itemId)))) return null;
    const equipment = bp.slots.map((_, i) => (i === to ? a : i === from ? b : c.equipment[i] ?? null));
    return [{ ...c, equipment }, st];
  });
}

export function unequip(s: PlayerState, charUid: string, slot: SlotRef): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const it = slotGet(c, slot);
    if (!it) return null;
    let next = putBack(st, it);
    let nc = slotSet(c, slot, null);
    if (slot === 'rucksack') {
      // снятый рюкзак отдаёт содержимое в инвентарь
      next = emptyBag(next, c.bag);
      nc = { ...nc, bag: [] };
    }
    return [nc, next];
  });
}

/** Вместимость надетого рюкзака (0 — рюкзака нет). */
export function bagCapacity(c: CharacterState): number {
  if (!c.rucksack || !hasItem(c.rucksack.itemId)) return 0;
  const it = getItem(c.rucksack.itemId);
  return it.kind === 'bag' ? it.capacity : 0;
}

/** Ячейки рюкзака нужной длины. */
export function bagSlots(c: CharacterState): Array<InventoryEntry | null> {
  const n = bagCapacity(c);
  return Array.from({ length: n }, (_, i) => c.bag?.[i] ?? null);
}

/** Что можно положить в рюкзак: зелья и снаряжение (лут, запасное оружие на серию). */
export const bagAccepts = (item: Item) => item.kind === 'potion' || item.kind === 'weapon' || item.kind === 'artifact' || item.kind === 'resource';

const maxStackOf = (itemId: string) => stackOf(itemId);

/** Высыпать ячейки рюкзака в инвентарь: стопки докладываются, снаряжение — как есть (с уровнем). */
export function emptyBag(s: PlayerState, bag: ReadonlyArray<InventoryEntry | null> | undefined): PlayerState {
  let next = s;
  for (const e of bag ?? []) {
    if (!e || !hasItem(e.itemId)) continue;
    const max = maxStackOf(e.itemId);
    next = max > 1 ? addItem(next, e.itemId, e.count, max) : { ...next, inventory: [...next.inventory, { uid: e.uid, itemId: e.itemId, count: 1, ...lv(e) }] };
  }
  return next;
}

/**
 * Положить стопку из инвентаря в ячейку рюкзака. Та же вещь в ячейке — докладывается до максимума
 * стопки (лишнее остаётся в инвентаре); другая — меняются местами.
 */
export function putInBag(s: PlayerState, charUid: string, cell: number, invUid: string): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const slots = bagSlots(c);
    if (cell < 0 || cell >= slots.length) return null;
    const e = st.inventory.find((x) => x.uid === invUid);
    if (!e || !hasItem(e.itemId) || !bagAccepts(getItem(e.itemId))) return null;
    const cur = slots[cell];
    const max = maxStackOf(e.itemId);
    let next: PlayerState = st;
    let placed: InventoryEntry;
    if (cur && cur.itemId === e.itemId) {
      const put = Math.min(max - cur.count, e.count);
      if (put <= 0) return null;
      placed = { ...cur, count: cur.count + put };
      next = { ...next, inventory: next.inventory.map((x) => (x.uid === invUid ? { ...x, count: x.count - put } : x)).filter((x) => x.count > 0) };
    } else {
      const put = Math.min(max, e.count);
      placed = { uid: e.count > put ? `${e.uid}b` : e.uid, itemId: e.itemId, count: put, ...lv(e) };
      if (e.count > put) {
        let id: string;
        [id, next] = uid(next, 'i');
        placed = { ...placed, uid: id };
        next = { ...next, inventory: next.inventory.map((x) => (x.uid === invUid ? { ...x, count: x.count - put } : x)) };
      } else next = { ...next, inventory: next.inventory.filter((x) => x.uid !== invUid) };
      if (cur) next = emptyBag(next, [cur]);
    }
    slots[cell] = placed;
    return [{ ...c, bag: slots }, next];
  });
}

/**
 * Переложить внутри рюкзака из ячейки from в to: в пустую — переезжает, на то же зелье — докладывается
 * до максимума стопки (остаток остаётся на месте), на другое — меняются местами. Можно и в серии арены.
 */
export function moveInBag(s: PlayerState, charUid: string, from: number, to: number): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const slots = bagSlots(c);
    if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return null;
    const a = slots[from];
    const b = slots[to];
    if (!a) return null;
    if (b && b.itemId === a.itemId) {
      const put = Math.min(maxStackOf(a.itemId) - b.count, a.count);
      if (put <= 0) {
        [slots[from], slots[to]] = [b, a];
      } else {
        slots[to] = { ...b, count: b.count + put };
        slots[from] = a.count - put > 0 ? { ...a, count: a.count - put } : null;
      }
    } else {
      [slots[from], slots[to]] = [b, a];
    }
    return [{ ...c, bag: slots }, st];
  }, true);
}

/** Выбросить стопку из ячейки рюкзака (освободить место под лут на арене). entry — что выброшено. */
export function discardFromBag(s: PlayerState, charUid: string, cell: number): { state: PlayerState; entry: InventoryEntry } | null {
  let entry: InventoryEntry | null = null;
  const state = updateCharacter(s, charUid, (c, st) => {
    const slots = bagSlots(c);
    const cur = slots[cell];
    if (!cur) return null;
    entry = cur;
    slots[cell] = null;
    return [{ ...c, bag: slots }, st];
  }, true);
  return state && entry ? { state, entry } : null;
}

/** Достать стопку из ячейки рюкзака в инвентарь (докладывается в неполные стопки). */
export function takeFromBag(s: PlayerState, charUid: string, cell: number): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => {
    const slots = bagSlots(c);
    const cur = slots[cell];
    if (!cur) return null;
    slots[cell] = null;
    return [{ ...c, bag: slots }, emptyBag(st, [cur])];
  });
}

/** Сохранить порядок атаки блоков противника. */
export function setCharacterTarget(s: PlayerState, charUid: string, target: Stat[]): PlayerState | null {
  return updateCharacter(s, charUid, (c, st) => [{ ...c, target: [...target] }, st], true);
}

export function renameCharacter(s: PlayerState, charUid: string, name: string): PlayerState | null {
  const n = validName(name);
  if (!n) return null;
  return updateCharacter(s, charUid, (c, st) => [{ ...c, name: n }, st], true);
}

/** Кубы за разборку персонажа: половина живых, вниз. */
export function characterRefund(c: CharacterState): number {
  return disassemblyRefund(c.blockStats.length - c.brokenBlocks.length);
}

/** Разобрать: половина живых кубов, снаряжение — в инвентарь. */
export function disassembleCharacter(s: PlayerState, charUid: string): PlayerState | null {
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c || busy(s, charUid)) return null;
  let next: PlayerState = addCubes({ ...s, characters: s.characters.filter((x) => x.uid !== charUid) }, characterRefund(c));
  for (const it of [...c.equipment, c.rucksack]) next = putBack(next, it);
  next = emptyBag(next, c.bag);
  if (next.lastArenaCharacterId === charUid) next = { ...next, lastArenaCharacterId: null };
  return next;
}

/** Предметы инвентаря, которые можно надеть хоть куда-нибудь (зелья, камни, подсумок — нет). */
export function equippableEntries(s: PlayerState): PlayerState['inventory'] {
  return s.inventory.filter((e) => hasItem(e.itemId) && isEquippable(getItem(e.itemId)));
}

