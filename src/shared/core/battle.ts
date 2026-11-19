// Пошаговый бой — перенос логики клиента Unity без Phaser:
//   ArenaBattleProcessor (очерёдность ходов, лимит), Character (BeginTurn, TakeDamage),
//   Abilities (AutoUse, кулдауны, TryUseSlot), AttackAbility (урон, крит), Stats (регенерация,
//   крит/уворот, −1 за разбитый куб), Block/Durability, Effects (горение/яд/щит, обновление длительности при повторе).
// Раскопка (этап 3): бить можно только передний живой куб столбика (перёд модели — +Z); какой столбик копать —
// по приоритету стат атакующего (targetBlock). Куда идёт урон сверх прочности — схема оружия (этап 4, applyOverflow).
// Отличия от клиента (docs/battle-rework.md, этап 1): урон удара фиксированный (без разброса min–max);
// крит, уворот и распространение горения — марбл-бэги (core/bag.ts), а не чистый рандом.
// Порядок шариков в мешках — от seed-а: один seed и одни входные данные дают один исход.
import { COMBAT, EFFECTS, getBlueprint, weaponPerk } from '../data/catalog';
import { STATS, type Ability, type CharacterBlueprint, type EffectId, type EquipmentItem, type Stat, type Vec3, type WeaponPattern, type WeaponPerk } from '../data/types';
import { DAMAGE_LEVEL, armorAbsorb, characterStats, critChance, damageCondition, damageScaling, dodgeChance } from './character';
import { createRng, type Rng } from './rng';
import { createBag, drawBag, type MarbleBag } from './bag';

export const MAX_TURNS = 200;
/** Прочность куба (config/combat.json → blockDurability). */
export const BLOCK_DURABILITY = COMBAT.blockDurability;
export const CRIT_MULTIPLIER = 2;
/** Базовый реген стамины (без доли от максимума) — combat.json → stamina.regenBase. */
export const STAMINA_REGEN = 2;
/** Пороги стат (config/combat.json → statThresholds, battle-rework этап 2). */
export const THRESHOLDS = COMBAT.statThresholds;
export const MANA_REGEN = 2;
/** Порядок по умолчанию, в котором бьются блоки противника (InitialTargetBlocksDistribution). */
export const DEFAULT_TARGET: Stat[] = ['Armor', 'Strength', 'Dexterity', 'Stamina', 'Intelligence', 'Luck'];

/**
 * Удар пустой рукой — базовая атака персонажей Sandbox Arena (2, кулдаун 1, 1 стамина).
 * В клиенте без оружия урон сейчас 0; в прототипе кулак бьёт, чтобы бойца без снаряжения
 * можно было вывести на арену.
 */
export const FIST: Ability = { type: 'Attack', cooldown: 1, staminaCost: 1, manaCost: 0, range: 0.5, damage: 20, effects: [] };

export type Side = 'player' | 'enemy';

export interface BattleBlock {
  index: number;
  stat: Stat;
  pos: Vec3;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Соседи через грань (до 6). В клиенте BlockUtility.GetTouchingBlocksPositions берёт все 26 — здесь сужено ради баланса горения (0.0.105). */
  neighbours: number[];
}

export interface BattleSlot {
  type: 'Hand' | 'Artifact';
  isLeftHand: boolean;
  item: EquipmentItem | null;
  /** Способность слота: оружие/артефакт; пустая рука — кулак; пустой артефакт — null. */
  ability: Ability | null;
  /** Осталось своих ходов до готовности. 0 — готова. */
  cooldown: number;
}

export interface ActiveEffect {
  id: EffectId;
  /** Блок-носитель; null — эффект на бойце (щит). */
  block: number | null;
  remaining: number;
  sinceLast: number;
}

/** Какую долю очка статы куб сейчас не даёт: 1 — разбит или заморожен, 1 − statMultiplier — отравлен, 0 — цел. */
function statLoss(f: Fighter, index: number): number {
  if (!f.blocks[index].alive) return 1;
  let loss = 0;
  for (const e of f.effects) {
    if (e.block !== index) continue;
    const def = EFFECTS[e.id];
    if (def.statDisabled) loss = 1;
    else if (def.statMultiplier !== undefined) loss = Math.max(loss, 1 - def.statMultiplier);
  }
  return loss;
}

export interface Fighter {
  side: Side;
  name: string;
  blueprintId: string;
  /** Визуальный скин, не участвует в расчёте боя. */
  skinId?: string;
  blocks: BattleBlock[];
  /** Боевые статы: стартуют со статов персонажа, −1 за каждый разбитый куб (Stats.AdjustStats). */
  stats: Record<'Armor' | 'Strength' | 'Dexterity' | 'Luck', number>;
  /** Статы урона на входе в бой — от них скейлинг и штраф за потерянные очки (AbilitiesUtility: baseStat). */
  entryStats: Record<'Strength' | 'Dexterity', number>;
  maxStamina: number;
  stamina: number;
  maxMana: number;
  mana: number;
  slots: BattleSlot[];
  /** Порядок стат, в котором этот боец бьёт блоки противника. */
  target: Stat[];
  effects: ActiveEffect[];
  /**
   * Столбики вдоль оси атаки (+Z — перёд): индексы блоков от переднего к заднему.
   * Столбики упорядочены по X, затем по Y — это и есть фиксированный порядок при равенстве.
   */
  columns: number[][];
  /** Столбик каждого блока (индекс в columns) и столбик по ключу «x,y» — для схем удара. */
  colOf: number[];
  colAt: Map<string, number>;
  /** Кубов каждой статы в чертеже бойца и сколько из них разбито (с учётом разбитых до боя). */
  cubeTotals: Record<Stat, number>;
  cubeBroken: Record<Stat, number>;
  /** Сколько очка статы уже снято за каждый куб (разбит — 1, отравлен — доля, заморожен — 1). */
  statLost: number[];
  /** Статы, отключённые порогом (в порядке отключения). */
  disabled: Stat[];
  /** Марбл-бэги бойца: крит (его удары), уворот (удары по нему), распространение горения по нему, оглушение (его удары). */
  bags: Record<'crit' | 'dodge' | 'burnSpread' | 'stun', MarbleBag>;
  /** Оглушён: пропускает свой следующий ход (булава ур. 2–3, этап 8). */
  stunned: boolean;
  aliveBlocks: number;
}

export type BattleEvent =
  | { t: 'turn'; turn: number; side: Side }
  | { t: 'attack'; side: Side; slot: number; weapon: string; block: number; damage: number; crit: boolean; outcome: 'hit' | 'evade' | 'shield'; absorbed: number }
  | { t: 'damage'; side: Side; block: number; damage: number; spread: boolean; source: 'attack' | EffectId }
  | { t: 'break'; side: Side; block: number; stat: Stat }
  | { t: 'disable'; side: Side; stat: Stat }
  | { t: 'stun'; side: Side }
  | { t: 'effect'; side: Side; effect: EffectId; block: number | null; refreshed: boolean }
  | { t: 'expire'; side: Side; effect: EffectId; block: number | null }
  | { t: 'artifact'; side: Side; slot: number; item: string }
  | { t: 'skip'; side: Side; reason: 'blocked' | 'stamina' | 'cooldown' | 'nothing' | 'stunned' }
  | { t: 'end'; winner: Side; reason: 'death' | 'turns' };

export interface BattleState {
  seed: number;
  rng: Rng;
  turn: number;
  next: Side;
  player: Fighter;
  enemy: Fighter;
  over: { winner: Side; reason: 'death' | 'turns' } | null;
  log: BattleEvent[];
}

/** Что нужно, чтобы вывести бойца на арену. */
export interface FighterInput {
  name: string;
  blueprintId: string;
  /** Визуальный скин; на расчёт боя не влияет. */
  skinId?: string;
  blockStats: readonly Stat[];
  brokenBlocks?: readonly number[];
  /** Предметы по слотам чертежа (null — пусто). */
  equipment: ReadonlyArray<EquipmentItem | null>;
  target?: readonly Stat[];
}

const key = (p: Vec3) => p.map((v) => Math.round(v)).join(',');

export function createFighter(side: Side, input: FighterInput): Fighter {
  const bp = getBlueprint(input.blueprintId) as CharacterBlueprint;
  const broken = new Set(input.brokenBlocks ?? []);
  const st = characterStats(bp, input.blockStats, [...broken]);
  const byPos = new Map(bp.blocks.map((b, i) => [key(b.pos), i]));
  const blocks: BattleBlock[] = bp.blocks.map((b, i) => {
    // соседи через грань (6 направлений) — на них перекидывается горение
    const neighbours: number[] = [];
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const j = byPos.get(key([b.pos[0] + x, b.pos[1] + y, b.pos[2] + z]));
      if (j !== undefined) neighbours.push(j);
    }
    const alive = !broken.has(i);
    return { index: i, stat: input.blockStats[i], pos: b.pos, hp: alive ? BLOCK_DURABILITY : 0, maxHp: BLOCK_DURABILITY, alive, neighbours };
  });
  // кулак — только без оружия в руках и одной рукой (обе руки бьют за ход, 0.0.54: иначе пустая рука добивала бы кулаком)
  const handIdx = bp.slots.map((s, i) => (s.type === 'Hand' ? i : -1)).filter((i) => i >= 0);
  const fistAt = handIdx.some((i) => input.equipment[i]) ? -1 : handIdx[0] ?? -1;
  const slots: BattleSlot[] = bp.slots
    .filter((s) => s.type === 'Hand' || s.type === 'Artifact')
    .map((s) => {
      const i = bp.slots.indexOf(s);
      const item = input.equipment[i] ?? null;
      const ability = item ? item.ability : i === fistAt ? FIST : null;
      return { type: s.type as 'Hand' | 'Artifact', isLeftHand: s.isLeftHand, item, ability, cooldown: 0 };
    });
  // столбики вдоль +Z: ключ — (x, y), внутри — от переднего (больший z) к заднему
  const byColumn = new Map<string, number[]>();
  blocks.forEach((blk) => {
    const k = `${Math.round(blk.pos[0])},${Math.round(blk.pos[1])}`;
    if (!byColumn.has(k)) byColumn.set(k, []);
    byColumn.get(k)!.push(blk.index);
  });
  const sortedCols = [...byColumn.entries()].sort(([a], [b]) => {
    const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number);
    return ax - bx || ay - by;
  });
  const columns = sortedCols.map(([, idx]) => idx.sort((i, j) => blocks[j].pos[2] - blocks[i].pos[2]));
  const colAt = new Map(sortedCols.map(([k], c) => [k, c]));
  const colOf: number[] = [];
  columns.forEach((col, c) => col.forEach((i) => (colOf[i] = c)));
  const cubeTotals = Object.fromEntries(STATS.map((s) => [s, 0])) as Record<Stat, number>;
  const cubeBroken = { ...cubeTotals };
  blocks.forEach((blk) => {
    cubeTotals[blk.stat]++;
    if (!blk.alive) cubeBroken[blk.stat]++;
  });
  return {
    side,
    name: input.name,
    blueprintId: bp.id,
    skinId: input.skinId,
    blocks,
    stats: { Armor: st.current.Armor, Strength: st.current.Strength, Dexterity: st.current.Dexterity, Luck: st.current.Luck },
    entryStats: { Strength: st.current.Strength, Dexterity: st.current.Dexterity },
    maxStamina: st.maxStamina,
    stamina: st.maxStamina,
    maxMana: st.maxMana,
    mana: st.maxMana,
    slots,
    target: normalizeTarget(input.target),
    effects: [],
    columns,
    colOf,
    colAt,
    cubeTotals,
    cubeBroken,
    statLost: blocks.map((blk) => (blk.alive ? 0 : 1)),
    // разбитые до боя кубы тоже считаются: вышел покалеченным — стата может быть отключена с первого хода;
    // стата без единого куба в сборке отключена с самого начала — иначе силовое оружие без кубов Силы било бы без штрафа
    disabled: THRESHOLDS.stats.filter((s) => cubeTotals[s] === 0 || overThreshold(cubeBroken[s], cubeTotals[s])),
    bags: { crit: createBag(COMBAT.bagSize), dodge: createBag(COMBAT.bagSize), burnSpread: createBag(COMBAT.bagSize), stun: createBag(COMBAT.bagSize) },
    stunned: false,
    aliveBlocks: blocks.filter((b) => b.alive).length,
  };
}

/** Все 6 стат без повторов: заданный порядок, недостающие — по умолчанию (TargetBlocksDistributionUtility.Normalize). */
export function normalizeTarget(source?: readonly Stat[]): Stat[] {
  const out: Stat[] = [];
  for (const s of source ?? []) if (DEFAULT_TARGET.includes(s) && !out.includes(s)) out.push(s);
  for (const s of DEFAULT_TARGET) if (!out.includes(s)) out.push(s);
  return out;
}

export function createBattle(seed: number, player: FighterInput, enemy: FighterInput): BattleState {
  return {
    seed,
    rng: createRng(seed),
    turn: 0,
    next: 'player', // PlayerMovesFirst
    player: createFighter('player', player),
    enemy: createFighter('enemy', enemy),
    over: null,
    log: [],
  };
}

const other = (b: BattleState, f: Fighter) => (f.side === 'player' ? b.enemy : b.player);
const fighter = (b: BattleState, side: Side) => (side === 'player' ? b.player : b.enemy);

// ───────────── статы ─────────────

/** Отключена ли стата порогом. */
export const isDisabled = (f: Pick<Fighter, 'disabled'>, stat: Stat) => f.disabled.includes(stat);

/** Есть ли у бойца хотя бы один живой куб статы. */
export const hasAliveCube = (f: Pick<Fighter, 'cubeTotals' | 'cubeBroken'>, stat: Stat) => f.cubeTotals[stat] - f.cubeBroken[stat] > 0;

/** Крит — только при живом кубе Силы, уворот — Ловкости; без них шанс 0 и мешок не тянется. */
export const critOf = (f: Fighter) => (isDisabled(f, 'Luck') || !hasAliveCube(f, 'Strength') ? 0 : critChance(f.stats.Luck, f.stats.Strength));
export const dodgeOf = (f: Fighter) => (isDisabled(f, 'Dexterity') || !hasAliveCube(f, 'Dexterity') ? 0 : dodgeChance(f.stats.Luck, f.stats.Dexterity));

const overThreshold = (broken: number, total: number) => total > 0 && broken > THRESHOLDS.share * total;

/**
 * Сколько ещё кубов статы разбить, чтобы она отключилась: 0 — уже отключена;
 * null — у статы нет порога или у бойца нет её кубов (такая стата отключена с начала боя).
 */
export function cubesToDisable(f: Pick<Fighter, 'cubeTotals' | 'cubeBroken' | 'disabled'>, stat: Stat): number | null {
  const total = f.cubeTotals[stat];
  if (!THRESHOLDS.stats.includes(stat) || total <= 0) return null;
  if (isDisabled(f, stat)) return 0;
  return Math.max(0, Math.floor(THRESHOLDS.share * total) + 1 - f.cubeBroken[stat]);
}

/** Реген стамины за ход по максимуму выносливости (combat.json → stamina). */
export const staminaRegenFor = (maxStamina: number) => COMBAT.stamina.regenBase + COMBAT.stamina.regenShare * maxStamina;
/**
 * Реген стамины за ход: regenBase + regenShare × максимум (0.0.70: чем больше кубов Выносливости, тем больше
 * восстанавливается; при regenShare = 1 — вся каждый ход). При отключённой Выносливости — THRESHOLDS.staminaRegen.
 */
export const staminaRegenOf = (f: Pick<Fighter, 'maxStamina' | 'disabled'>) =>
  isDisabled(f, 'Stamina') ? THRESHOLDS.staminaRegen : staminaRegenFor(f.maxStamina);

/** После разбитого куба: стата перешла порог — отключить (одно событие на стату за бой). */
function checkThreshold(b: BattleState, f: Fighter, stat: Stat) {
  if (isDisabled(f, stat) || !THRESHOLDS.stats.includes(stat)) return;
  if (!overThreshold(f.cubeBroken[stat], f.cubeTotals[stat])) return;
  f.disabled.push(stat);
  b.log.push({ t: 'disable', side: f.side, stat });
}

/** Попытка из мешка бойца: при шансе 10% — ровно 1 срабатывание на каждые 10 попыток (заменяет лимит серии Stats.Roll). */
const roll = (b: BattleState, chance: number, f: Fighter, bag: keyof Fighter['bags']) => drawBag(f.bags[bag], chance, b.rng);

/**
 * Привести стату к состоянию куба: разбитый снимает 1 очко своей статы, отравленный — долю (statMultiplier),
 * замороженный — всё очко на время эффекта; эффект прошёл — очко возвращается. Макс. стамина/мана — так же,
 * текущая — не выше максимума.
 */
function syncStat(f: Fighter, index: number) {
  const loss = statLoss(f, index);
  const amount = loss - f.statLost[index];
  if (Math.abs(amount) < 1e-9) return;
  f.statLost[index] = loss;
  const stat = f.blocks[index].stat;
  const dec = (v: number) => (v - amount < 0.01 ? 0 : v - amount);
  if (stat === 'Stamina') {
    f.maxStamina = dec(f.maxStamina);
    f.stamina = Math.min(f.stamina, f.maxStamina);
  } else if (stat === 'Intelligence') {
    f.maxMana = dec(f.maxMana);
    f.mana = Math.min(f.mana, f.maxMana);
  } else f.stats[stat] = dec(f.stats[stat]);
}

// ───────────── урон по блокам ─────────────

/**
 * Урон в прочность блока. Возвращает остаток сверх прочности — куда он идёт, решает вызывающий
 * (удар — в следующий куб раскопки; эффекты — пропадает). В клиенте остаток делится между соседями.
 */
export function damageBlock(b: BattleState, f: Fighter, index: number, value: number, source: 'attack' | EffectId, spread = false): number {
  const blk = f.blocks[index];
  if (!blk.alive || value <= 0) return 0;
  const taken = Math.min(value, blk.hp);
  blk.hp = Math.max(blk.hp - value, 0);
  b.log.push({ t: 'damage', side: f.side, block: index, damage: value, spread, source });
  if (blk.hp <= 0) {
    blk.alive = false;
    f.aliveBlocks--;
    f.cubeBroken[blk.stat]++;
    syncStat(f, index);
    b.log.push({ t: 'break', side: f.side, block: index, stat: blk.stat });
    checkThreshold(b, f, blk.stat);
  }
  return value - taken;
}

const hasShield = (f: Fighter) => f.effects.some((e) => e.id === 'shield');

// ───────────── эффекты ─────────────

/** Наложить эффект. Тот же вид на тот же блок — обновить длительность, без дубля (Effects.Apply). */
export function applyEffect(b: BattleState, f: Fighter, id: EffectId, block: number | null) {
  const def = EFFECTS[id];
  if (!def) return;
  if (block !== null && !f.blocks[block]?.alive) return;
  const existing = f.effects.find((e) => e.id === id && e.block === block);
  if (existing) {
    existing.remaining = def.duration;
    b.log.push({ t: 'effect', side: f.side, effect: id, block, refreshed: true });
    return;
  }
  // огонь снимает лёд с блока
  for (const r of def.removes ?? []) {
    const k = f.effects.findIndex((e) => e.id === r && e.block === block);
    if (k >= 0) removeEffect(b, f, k);
  }
  f.effects.push({ id, block, remaining: def.duration, sinceLast: 0 });
  if (id === 'freeze' && block !== null) {
    const blk = f.blocks[block];
    const m = def.durabilityMultiplier ?? 0.5;
    blk.maxHp *= m;
    blk.hp *= m;
  }
  if (block !== null) syncStat(f, block);
  b.log.push({ t: 'effect', side: f.side, effect: id, block, refreshed: false });
}

function removeEffect(b: BattleState, f: Fighter, k: number) {
  const e = f.effects[k];
  f.effects.splice(k, 1);
  if (e.id === 'freeze' && e.block !== null) {
    const blk = f.blocks[e.block];
    const m = EFFECTS.freeze.durabilityMultiplier ?? 0.5;
    blk.maxHp /= m;
    if (blk.alive) blk.hp = Math.min(blk.hp / m, blk.maxHp);
  }
  if (e.block !== null) syncStat(f, e.block);
  b.log.push({ t: 'expire', side: f.side, effect: e.id, block: e.block });
}

/** Продвинуть эффекты бойца на его ход: тики DoT, распространение горения, истечение. С конца — новые горения не тикают сразу. */
function advanceEffects(b: BattleState, f: Fighter) {
  for (let k = f.effects.length - 1; k >= 0; k--) {
    const e = f.effects[k];
    if (!e) continue;
    const def = EFFECTS[e.id];
    if (e.block !== null && !f.blocks[e.block].alive) {
      removeEffect(b, f, k);
      continue;
    }
    if (def.damagePerTick && e.block !== null) {
      e.sinceLast++;
      const interval = Math.max(1, def.interval ?? 1);
      while (e.sinceLast >= interval && e.remaining > 0) {
        e.sinceLast -= interval;
        damageBlock(b, f, e.block, def.damagePerTick, e.id);
        if (e.id === 'burn') spreadBurn(b, f, e.block);
        if (!f.blocks[e.block].alive) break;
      }
    }
    e.remaining--;
    if (e.remaining <= 0 || (e.block !== null && !f.blocks[e.block].alive)) {
      const idx = f.effects.indexOf(e);
      if (idx >= 0) removeEffect(b, f, idx);
    }
  }
}

/**
 * Перекид горения: один бросок за тик горящего куба; удался — загорается один случайный живой негорящий куб,
 * соседний через грань. Раньше бросок шёл на каждого из соседей, включая диагональных (в среднем 8 у лобстера) —
 * огонь расходился цепной реакцией (0.0.105).
 */
function spreadBurn(b: BattleState, f: Fighter, from: number) {
  const chance = EFFECTS.burn.spreadChance ?? 0;
  const free = f.blocks[from].neighbours.filter((j) => f.blocks[j].alive && !f.effects.some((e) => e.id === 'burn' && e.block === j));
  if (!free.length || !roll(b, chance, f, 'burnSpread')) return;
  applyEffect(b, f, 'burn', free[b.rng.int(0, free.length - 1)]);
}

// ───────────── способности ─────────────

/** Главная цель раскопки: первая стата приоритета, у которой у цели есть живые кубы. */
export function digGoal(order: readonly Stat[], target: Pick<Fighter, 'blocks'>, alive: (i: number) => boolean = (i) => target.blocks[i].alive): Stat | null {
  return order.find((s) => target.blocks.some((x) => x.stat === s && alive(x.index))) ?? null;
}

/**
 * Куб, по которому придёт удар (раскопка, этап 3). Достать можно только передний живой куб столбика.
 * 1. Главная цель — первая стата приоритета, у которой есть живые кубы.
 * 2. Столбик, где до ближайшего куба этой статы меньше всего живых кубов спереди.
 * 3. Ничья — столбик, чей передний куб выше в приоритете; дальше — порядок столбиков (X, затем Y).
 */
export function digTarget(order: readonly Stat[], target: Pick<Fighter, 'blocks' | 'columns'>, alive: (i: number) => boolean = (i) => target.blocks[i].alive): number | null {
  const goal = digGoal(order, target, alive);
  if (!goal) return null;
  let best: { front: number; cost: number; rank: number } | null = null;
  for (const col of target.columns) {
    let front = -1;
    let cost = 0;
    let found = false;
    for (const i of col) {
      if (!alive(i)) continue;
      if (front < 0) front = i;
      if (target.blocks[i].stat === goal) {
        found = true;
        break;
      }
      cost++;
    }
    if (!found) continue;
    const rank = order.indexOf(target.blocks[front].stat);
    if (!best || cost < best.cost || (cost === best.cost && rank < best.rank)) best = { front, cost, rank };
  }
  return best?.front ?? null;
}

/** Куб, по которому сейчас ударит атакующий. */
export const targetBlock = (attacker: Pick<Fighter, 'target'>, target: Fighter): number | null => digTarget(attacker.target, target);

/**
 * Предпросмотр раскопки: следующие n кубов, которые выбьет атакующий с порядком order, если каждый удар ломает куб
 * (порядок не зависит от оружия — только от приоритета и раскладки цели).
 */
export function digPreview(order: readonly Stat[], target: Fighter, n: number): number[] {
  const alive = target.blocks.map((x) => x.alive);
  const out: number[] = [];
  while (out.length < n) {
    const i = digTarget(order, target, (k) => alive[k]);
    if (i === null) break;
    out.push(i);
    alive[i] = false;
  }
  return out;
}

/**
 * Множитель урона слота от статы: скейлинг по стате на входе в бой и уровню предмета,
 * штраф −2.5% за каждое очко, потерянное с начала боя (пол 30%). Без скалирующей статы (кулак) — только уровень.
 */
function slotMultiplier(f: Fighter, slot: BattleSlot): number {
  const s = slot.item?.scalingStat;
  // урон от уровня оружия не растёт (этап 8): у оружия в формуле всегда DAMAGE_LEVEL, у кулака — 0
  const level = slot.item ? DAMAGE_LEVEL : 0;
  if (s !== 'Strength' && s !== 'Dexterity') return damageScaling(1, level);
  const disabled = s === 'Strength' && isDisabled(f, 'Strength') ? THRESHOLDS.strengthWeaponMultiplier : 1;
  return damageScaling(f.entryStats[s], level) * damageCondition(f.entryStats[s], f.stats[s]) * disabled;
}

/** Урон удара слота при текущих статах — без крита, брони и приоритета (для подсказок). */
export function slotDamageValue(f: Fighter, slot: BattleSlot): number {
  const a = slot.ability;
  if (!a || a.type === 'ApplyEffect') return 0;
  return a.damage * slotMultiplier(f, slot) * (perkOf(slot.item).damageMultiplier ?? 1);
}

const canPay = (f: Fighter, a: Ability) => f.stamina >= a.staminaCost && f.mana >= a.manaCost;

/** Свойства уровня оружия (этап 8): ур. 1 — ничего, ур. 2–3 — из combat.json → weaponLevels.perks. */
export function perkOf(item: Pick<EquipmentItem, 'id' | 'itemLevel'> | null | undefined): WeaponPerk {
  return weaponPerk(item);
}

/** Схема удара слота: у оружия — своя, у кулака и оружия без схемы — carry. */
export const patternOf = (slot: Pick<BattleSlot, 'item'>): WeaponPattern => slot.item?.pattern ?? 'carry';

/** Глубина куба по оси атаки (z, округлённо). */
const zOf = (f: Fighter, i: number) => Math.round(f.blocks[i].pos[2]);

/**
 * Боковая цель схемы: передний живой куб соседнего столбика (x, y), только если он вплотную к цели по глубине
 * (|Δz| ≤ 1). Столбик рядом, но его перёд глубже или дальше — не сосед (0.0.40).
 */
function sideAt(f: Fighter, x: number, y: number, z: number): number | null {
  const c = f.colAt.get(`${x},${y}`);
  if (c === undefined) return null;
  const front = f.columns[c].find((i) => f.blocks[i].alive);
  return front !== undefined && Math.abs(zOf(f, front) - z) <= 1 ? front : null;
}

/** Куб вплотную за кубом i (соседняя клетка позади, z − 1), если он живой; через пустоту не достаёт. */
function behindOf(f: Fighter, i: number): number | null {
  const z = zOf(f, i);
  return f.columns[f.colOf[i]].find((j) => f.blocks[j].alive && zOf(f, j) === z - 1) ?? null;
}

/**
 * Кубы за кубом i в пределах depth клеток по оси (z − 1 … z − depth), от ближнего к дальнему.
 * Пустые и разбитые клетки внутри дальности копьё проходит насквозь; дальше depth — не достаёт.
 */
function piercedBehind(f: Fighter, i: number, depth: number): number[] {
  const z = zOf(f, i);
  return f.columns[f.colOf[i]].filter((j) => f.blocks[j].alive && zOf(f, j) < z && zOf(f, j) >= z - depth);
}

/**
 * Куда уходит урон сверх прочности куба i (этап 4). Остаток делится поровну между клетками схемы ур. 1;
 * клетки от свойств уровня получают сверх этого extraShare такой доли (combat.json → weaponLevels);
 * то, что не поместилось уже в них, пропадает (кроме carry и pierce — у них цепочка).
 */
function applyOverflow(b: BattleState, actor: Fighter, target: Fighter, i: number, rest: number, pattern: WeaponPattern, perk: WeaponPerk = {}) {
  if (rest <= 1e-6) return;
  const [x, y, z] = [Math.round(target.blocks[i].pos[0]), Math.round(target.blocks[i].pos[1]), zOf(target, i)];
  // full — каждой цели остаток целиком (рубящий ур. 3), иначе поровну
  // остаток делится между клетками схемы ур. 1; клетки от свойств уровня — сверх них, по extraShare доли (0.0.76)
  const share = (baseIds: Array<number | null>, allIds: Array<number | null>) => {
    const alive = (ids: Array<number | null>) => [...new Set(ids.filter((j): j is number => j !== null && j !== i && target.blocks[j].alive))];
    const base = alive(baseIds);
    const part = rest / Math.max(1, base.length);
    for (const j of alive(allIds)) damageBlock(b, target, j, base.includes(j) ? part : part * (perk.extraShare ?? COMBAT.weaponLevels.extraShare), 'attack', true);
  };
  const chain = (depth: number) => {
    for (const next of piercedBehind(target, i, depth)) {
      if (rest <= 1e-6) return;
      rest = damageBlock(b, target, next, rest, 'attack', true);
    }
  };
  const behind = (n: number) => (n <= 1 ? [behindOf(target, i)] : piercedBehind(target, i, n));
  const cross = [sideAt(target, x - 1, y, z), sideAt(target, x + 1, y, z), sideAt(target, x, y - 1, z), sideAt(target, x, y + 1, z)];
  // остаток — дальше по раскопке, пока не кончится
  const carry = () => {
    while (rest > 1e-6) {
      const next = targetBlock(actor, target);
      if (next === null) return;
      rest = damageBlock(b, target, next, rest, 'attack', true);
    }
  };
  switch (pattern) {
    case 'precise':
      // 0.0.73 (решение Евгения): остаток не пропадает — цепочкой вглубь своего столбика, без ограничения дальности
      // (иначе урон ножа и кинжала — ступеньки «разбил с одного удара или нет»); столбик кончился — остаток пропадает
      return chain(Infinity);
    case 'carry':
      return carry();
    case 'pierce':
      // цепочкой вглубь, но только в пределах depth клеток от цели (столбик уже упорядочен спереди назад)
      return chain(perk.depth ?? COMBAT.patterns.pierce.depth);
    case 'cleave': {
      const base = [sideAt(target, x - 1, y, z), sideAt(target, x + 1, y, z)];
      return share(base, [...base, ...(perk.sidesY ? [sideAt(target, x, y - 1, z), sideAt(target, x, y + 1, z)] : []), ...(perk.behind ? behind(perk.behind) : [])]);
    }
    case 'split': {
      const side = sideAt(target, x + 1, y, z) ?? sideAt(target, x - 1, y, z);
      const sides = perk.bothSides ? [sideAt(target, x + 1, y, z), sideAt(target, x - 1, y, z)] : [side];
      return share([behindOf(target, i), side], [...behind(perk.behind ?? 1), ...sides]);
    }
    case 'crush': {
      const diag = perk.diagonals ? [sideAt(target, x - 1, y - 1, z), sideAt(target, x + 1, y - 1, z), sideAt(target, x - 1, y + 1, z), sideAt(target, x + 1, y + 1, z)] : [];
      return share([...cross, behindOf(target, i)], [...cross, ...diag, ...behind(perk.behind ?? 1)]);
    }
  }
}

/** Куб, на который ляжет эффект удара: цель, если уцелела; иначе задетый остатком живой куб; иначе следующий по фокусу. */
function effectCarrier(b: BattleState, actor: Fighter, target: Fighter, block: number, logFrom: number): number | null {
  if (target.blocks[block].alive) return block;
  for (let k = logFrom; k < b.log.length; k++) {
    const e = b.log[k];
    if (e.t === 'damage' && e.side === target.side && target.blocks[e.block].alive) return e.block;
  }
  return target.aliveBlocks > 0 ? targetBlock(actor, target) : null;
}

function attack(b: BattleState, actor: Fighter, target: Fighter, slotIndex: number): boolean {
  const slot = actor.slots[slotIndex];
  const a = slot.ability!;
  if (targetBlock(actor, target) === null) return false;
  actor.stamina -= a.staminaCost;
  actor.mana -= a.manaCost;
  const pattern = patternOf(slot);
  const perk = perkOf(slot.item);
  const weapon = slot.item?.name ?? 'Кулак';
  // несколько ударов за использование (кинжал — 2): у каждого свой крит, уворот и цель раскопки
  for (let h = 0; h < Math.max(1, perk.hits ?? a.hits ?? 1); h++) {
    const block = targetBlock(actor, target);
    if (block === null || b.over) break;
    const crit = roll(b, critOf(actor), actor, 'crit');
    let damage = slotDamageValue(actor, slot) * (crit ? perk.critMultiplier ?? CRIT_MULTIPLIER : 1);
    // Character.TakeDamage: щит → уворот → броня (крит её игнорирует) → прочность блока
    if (hasShield(target)) {
      b.log.push({ t: 'attack', side: actor.side, slot: slotIndex, weapon, block, damage: 0, crit, outcome: 'shield', absorbed: damage });
    } else if (roll(b, dodgeOf(target), target, 'dodge')) {
      b.log.push({ t: 'attack', side: actor.side, slot: slotIndex, weapon, block, damage: 0, crit, outcome: 'evade', absorbed: 0 });
    } else {
      let absorbed = 0;
      if (!crit && target.stats.Armor > 0) {
        const ignore = perk.armorIgnore ?? (pattern === 'precise' ? COMBAT.patterns.precise.armorIgnore : 0);
        absorbed = damage * armorAbsorb(target.stats.Armor) * (1 - ignore);
        damage -= absorbed;
      }
      b.log.push({ t: 'attack', side: actor.side, slot: slotIndex, weapon, block, damage, crit, outcome: 'hit', absorbed });
      const from = b.log.length;
      const rest = damageBlock(b, target, block, damage, 'attack');
      applyOverflow(b, actor, target, block, rest, pattern, perk);
      if (a.effects.length) {
        // эффект ложится на куб-цель; если удар его разбил — на уцелевший куб, задетый остатком,
        // иначе — на следующий куб по фокусу атаки (иначе сильное оружие никогда не поджигало бы)
        const carrier = effectCarrier(b, actor, target, block, from);
        if (carrier !== null) for (const id of a.effects) applyEffect(b, target, id, carrier);
      }
      // булава ур. 2–3: оглушение — из мешка атакующего; оглушённый пропускает свой следующий ход
      if (perk.stun && !target.stunned && roll(b, perk.stun, actor, 'stun')) {
        target.stunned = true;
        b.log.push({ t: 'stun', side: target.side });
      }
    }
    if (target.aliveBlocks <= 0) break;
  }
  slot.cooldown = a.cooldown;
  return true;
}

/**
 * Ход бойца: бьют ВСЕ готовые руки по порядку слотов — у каждой свой кулдаун, стамина и мана списываются за каждый
 * удар (0.0.54, решение Евгения: раньше, как в Abilities.AutoUse клиента, била только первая готовая рука,
 * вторая была запасной). Рука без стамины пропускается, следующая — пробует.
 */
function autoUse(b: BattleState, actor: Fighter, target: Fighter): BattleEvent['t'] | 'blocked' | 'stamina' | 'cooldown' | 'nothing' {
  if (hasShield(actor)) return 'blocked'; // щит: ActionBlocked
  let sawCooldown = false;
  let sawStamina = false;
  let hit = false;
  for (let i = 0; i < actor.slots.length; i++) {
    if (b.over || target.aliveBlocks <= 0) break;
    const slot = actor.slots[i];
    if (!slot.ability || slot.type === 'Artifact') continue; // артефакты — вручную
    if (slot.cooldown > 0) {
      sawCooldown = true;
      continue;
    }
    if (!canPay(actor, slot.ability)) {
      sawStamina = true;
      continue;
    }
    if (attack(b, actor, target, i)) hit = true;
  }
  if (hit) return 'attack';
  return sawStamina ? 'stamina' : sawCooldown ? 'cooldown' : 'nothing';
}

/** Можно ли сейчас активировать артефакт (TryUseSlot). */
export function canUseArtifact(b: BattleState, side: Side, slotIndex: number): boolean {
  const f = fighter(b, side);
  const slot = f.slots[slotIndex];
  if (isDisabled(f, 'Intelligence')) return false; // Интеллект отключён порогом — артефакты не работают
  return !b.over && f.aliveBlocks > 0 && slot?.type === 'Artifact' && !!slot.ability && slot.cooldown === 0 && canPay(f, slot.ability) && slot.ability.effects.length > 0;
}

/** Активировать артефакт: накладывает свои эффекты на владельца (щит). Не тратит ход. */
export function useArtifact(b: BattleState, side: Side, slotIndex: number): boolean {
  if (!canUseArtifact(b, side, slotIndex)) return false;
  const f = fighter(b, side);
  const slot = f.slots[slotIndex];
  const a = slot.ability!;
  f.stamina -= a.staminaCost;
  f.mana -= a.manaCost;
  b.log.push({ t: 'artifact', side, slot: slotIndex, item: slot.item?.name ?? '' });
  for (const id of a.effects) applyEffect(b, f, id, null);
  slot.cooldown = a.cooldown;
  return true;
}

// ───────────── ход ─────────────

function checkDeath(b: BattleState): boolean {
  if (b.over) return true;
  const dead = b.player.aliveBlocks <= 0 ? b.player : b.enemy.aliveBlocks <= 0 ? b.enemy : null;
  if (!dead) return false;
  b.over = { winner: dead.side === 'player' ? 'enemy' : 'player', reason: 'death' };
  b.log.push({ t: 'end', ...b.over });
  return true;
}

/**
 * Один ход того, чья очередь (ArenaBattleProcessor.RunTurn):
 * эффекты → кулдауны → +2 стамины и маны → AutoUse; затем очередь переходит к сопернику.
 * Возвращает события этого хода.
 */
export function step(b: BattleState): BattleEvent[] {
  const from = b.log.length;
  if (b.over) return [];
  if (b.turn >= MAX_TURNS) {
    // лимит ходов: побеждает тот, у кого больше живых блоков; ничья — игроку
    b.over = { winner: b.player.aliveBlocks >= b.enemy.aliveBlocks ? 'player' : 'enemy', reason: 'turns' };
    b.log.push({ t: 'end', ...b.over });
    return b.log.slice(from);
  }
  const actor = fighter(b, b.next);
  const target = other(b, actor);
  b.turn++;
  b.log.push({ t: 'turn', turn: b.turn, side: actor.side });
  advanceEffects(b, actor);
  for (const s of actor.slots) s.cooldown = Math.max(0, s.cooldown - 1);
  actor.stamina = Math.min(actor.maxStamina, actor.stamina + staminaRegenOf(actor));
  actor.mana = Math.min(actor.maxMana, actor.mana + MANA_REGEN);
  if (!checkDeath(b)) {
    if (actor.stunned) {
      actor.stunned = false; // оглушение — ровно один пропущенный ход
      b.log.push({ t: 'skip', side: actor.side, reason: 'stunned' });
    } else {
      const r = autoUse(b, actor, target);
      if (r !== 'attack') b.log.push({ t: 'skip', side: actor.side, reason: r as 'blocked' | 'stamina' | 'cooldown' | 'nothing' });
    }
    checkDeath(b);
  }
  b.next = target.side;
  return b.log.slice(from);
}

/** Прогнать бой до конца (тесты, автобой). */
export function runToEnd(b: BattleState): BattleState {
  while (!b.over) step(b);
  return b;
}
