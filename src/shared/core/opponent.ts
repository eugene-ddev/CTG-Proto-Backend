// Противники арены.
// - generateOpponent — боты из конфига (config/opponents.json): уровень оружия — как у игрока или ниже (до −разброса),
//   оружие под главную стату, артефакт с маной — только вместе с кубами Интеллекта, рюкзак с содержимым (лут).
// - OPPONENT_PRESETS — пресеты Sandbox Arena клиента (Data/Sandbox/Characters), для тестов и сравнения.
// Кубы раскладываются по блокам чертежа подряд, в порядке стат (SandboxCharacterConfig.ResolveBlockTypes).
import { weaponLevelName } from '../data/weaponLooks';
import { BLUEPRINTS, COMBAT, ITEMS, OPPONENTS, getBlueprint, getItem, outOfRotation } from '../data/catalog';
import { STATS, type BagItem, type CharacterBlueprint, type EffectId, type EquipmentItem, type GemItem, type OpponentsConfig, type Stat } from '../data/types';
import { DEFAULT_TARGET, createFighter, digGoal, type FighterInput } from './battle';
import { layeredStats } from './layout';
import { createRng } from './rng';
import { bagDraws, drawInt, rngDraws, type Bags, type DrawLog, type DrawSource } from './bag';

interface PresetWeapon {
  itemId: string;
  level: number;
  /** Свой урон экземпляра, если отличается от шаблона. */
  damage?: number;
  gems?: EffectId[];
}

export interface OpponentPreset {
  id: string;
  name: string;
  blueprintId: string;
  /** Кубов каждой статы — раскладываются подряд в порядке STATS. */
  counts: Partial<Record<Stat, number>>;
  /** Оружие по индексу слота чертежа. */
  weapons: Record<number, PresetWeapon>;
  target: Stat[];
}

export const OPPONENT_PRESETS: OpponentPreset[] = [
  {
    id: 'player-lobster',
    name: 'Mega Lobster',
    blueprintId: 'bp-lobster',
    counts: { Armor: 3, Dexterity: 20, Stamina: 5, Luck: 10 },
    weapons: { 0: { itemId: 'rustyDagger', level: 10, damage: 80 } },
    target: ['Luck', 'Armor', 'Strength', 'Dexterity', 'Intelligence', 'Stamina'],
  },
  {
    id: 'waran-1',
    name: 'Waran',
    blueprintId: 'bp-waran',
    counts: { Dexterity: 10, Stamina: 5, Luck: 7 },
    weapons: { 0: { itemId: 'rustySword', level: 1, gems: ['burn'] }, 1: { itemId: 'rustySword', level: 1 } },
    target: ['Armor', 'Strength', 'Luck', 'Stamina', 'Dexterity', 'Intelligence'],
  },
  {
    id: 'strength-waran',
    name: 'Strength Waran',
    blueprintId: 'bp-waran',
    counts: { Strength: 10, Stamina: 5, Luck: 7 },
    weapons: { 0: { itemId: 'rustySword', level: 1 }, 1: { itemId: 'rustySword', level: 1 } },
    target: ['Dexterity', 'Stamina', 'Luck', 'Strength', 'Intelligence', 'Armor'],
  },
];

/** Стопка в рюкзаке бота. */
export interface OpponentBagEntry {
  itemId: string;
  count: number;
}

export interface Opponent extends FighterInput {
  seed: number;
  /** Пресет или «чертёж/главная стата» у сгенерированного — чтобы «Другой противник» не повторял. */
  presetId: string;
  /** Подпись под именем: чертёж, стата, уровень, камни, рюкзак. */
  pattern: string;
  /** Уровень оружия по слотам (для показа). */
  weaponLevels: Array<number | null>;
  /** Надетый рюкзак (id) и его содержимое — лут вместе с оружием. */
  rucksack: string | null;
  bag: OpponentBagEntry[];
}

/** Собрать противника из пресета. */
export function opponentFromPreset(p: OpponentPreset, seed = 0): Opponent {
  const bp = getBlueprint(p.blueprintId);
  const blockStats: Stat[] = [];
  for (const s of STATS) for (let i = 0; i < (p.counts[s] ?? 0) && blockStats.length < bp.blocks.length; i++) blockStats.push(s);
  while (blockStats.length < bp.blocks.length) blockStats.push('Stamina'); // недобор — как пустой бюджет, добиваем выносливостью
  const slots = bp.kind === 'character' ? bp.slots : [];
  const equipment: Array<EquipmentItem | null> = slots.map(() => null);
  const weaponLevels: Array<number | null> = slots.map(() => null);
  const gemNames: string[] = [];
  for (const [k, w] of Object.entries(p.weapons)) {
    const i = Number(k);
    const base = getItem(w.itemId) as EquipmentItem;
    const ability = { ...base.ability, effects: [...base.ability.effects, ...(w.gems ?? [])] };
    if (w.damage) ability.damage = w.damage;
    const level = Math.min(w.level, COMBAT.weaponLevels.max); // уровни 1–3 (этап 8)
    const gemIds = (w.gems ?? []).flatMap((effect) => ITEMS.filter((it) => it.kind === 'gem' && it.effects.includes(effect)).slice(0, 1).map((it) => it.id));
    equipment[i] = { ...base, name: weaponLevelName(base.name, level), itemLevel: level, ability, ...(gemIds.length ? { gemSlots: Math.max(base.gemSlots, gemIds.length), gems: gemIds } : {}) };
    weaponLevels[i] = level;
    if (w.gems?.length) gemNames.push(`${base.name}: камень ${w.gems.map((g) => (g === 'burn' ? 'огня' : g === 'poison' ? 'яда' : 'льда')).join(', ')}`);
  }
  return {
    seed,
    presetId: p.id,
    name: p.name,
    pattern: [bp.name, ...gemNames].join(' · '),
    blueprintId: p.blueprintId,
    blockStats,
    equipment,
    target: p.target,
    weaponLevels,
    rucksack: null,
    bag: [],
  };
}

// ───────────── генерация ботов ─────────────

const MAIN_TITLE: Record<Stat, string> = {
  Strength: 'силач', Dexterity: 'ловкач', Intelligence: 'маг', Armor: 'танк', Stamina: 'стайер', Luck: 'везунчик',
};
const STAT_NAME: Record<Stat, string> = {
  Strength: 'Сила', Dexterity: 'Ловкость', Intelligence: 'Интеллект', Armor: 'Броня', Stamina: 'Выносливость', Luck: 'Удача',
};

// оружие вне ротации (combat.json → outOfRotation) ботам не выдаётся
const weapons = () => ITEMS.filter((i): i is EquipmentItem => i.kind === 'weapon' && i.slot === 'Hand' && !outOfRotation(i.id));
const artifacts = () => ITEMS.filter((i): i is EquipmentItem => i.kind === 'artifact' && !outOfRotation(i.id));
/** Главные статы — те, от которых скалируется хоть одно оружие (сейчас Сила и Ловкость). */
export const mainStats = (): Stat[] => STATS.filter((s) => weapons().some((w) => w.scalingStat === s));

/** Уровень оружия игрока: лучшее оружие в руках; без оружия — минимальный. */
export function playerWeaponLevel(equipment: ReadonlyArray<EquipmentItem | null>, cfg: OpponentsConfig = OPPONENTS): number {
  const lv = equipment.filter((e): e is EquipmentItem => !!e && e.kind === 'weapon').map((e) => e.itemLevel);
  return lv.length ? Math.max(...lv) : cfg.minWeaponLevel;
}

/** Слотов камней на этом уровне оружия. */
/** Сколько ячеек камней может быть у оружия бота этого уровня (этап 8): не больше уровень − 1 и не больше максимума. */
export const gemSlotsAt = (level: number) => Math.max(0, Math.min(COMBAT.gemCells.max, level - 1));

/**
 * Раскладка кубов: главная стата — самая большая; Интеллект — только под ману артефактов;
 * требования предметов к статам (minStatRequired) выполняются всегда.
 */
export function distributeCubes(
  total: number,
  main: Stat,
  need: Partial<Record<Stat, number>>,
  d: DrawSource,
  cfg: OpponentsConfig = OPPONENTS,
): Record<Stat, number> {
  const counts = Object.fromEntries(STATS.map((s) => [s, 0])) as Record<Stat, number>;
  // доля статы — одна из 5 ступеней диапазона, из мешка (этап 6): за 5 ботов выпадут все ступени
  const share = (key: string, r: [number, number] | undefined) => (r ? d.pick(`bot.share.${key}`, [0, 1, 2, 3, 4].map((k) => r[0] + ((r[1] - r[0]) * k) / 4)) : 0);
  counts[main] = Math.round(total * share('main', cfg.statShares.main));
  for (const s of STATS) {
    if (s === main || s === 'Intelligence') continue;
    if (mainStats().includes(s)) continue; // вторая стата оружия не качается — иначе «силач с кинжалами»
    counts[s] = Math.round(total * share(s, cfg.statShares[s]));
  }
  for (const s of STATS) counts[s] = Math.max(counts[s], need[s] ?? 0);
  const sum = () => STATS.reduce((a, s) => a + counts[s], 0);
  // перебор — срезаем необязательное, начиная с удачи и брони
  for (const s of ['Luck', 'Armor', 'Stamina', main] as Stat[]) {
    while (sum() > total && counts[s] > (need[s] ?? 0)) counts[s]--;
  }
  // недобор — в главную стату
  counts[main] += Math.max(0, total - sum());
  // главная стата — строго самая большая
  for (;;) {
    const top = STATS.filter((s) => s !== main && counts[s] >= counts[main] && counts[s] > (need[s] ?? 0));
    if (!top.length) break;
    counts[top[0]]--;
    counts[main]++;
  }
  return counts;
}

/** Кубы по статам → стата каждого блока: слоями спереди назад по order (этап 5). */
function layBlocks(bp: CharacterBlueprint, counts: Record<Stat, number>, order: readonly Stat[]): Stat[] {
  const plan = layeredStats(bp.blocks, counts, order);
  return bp.blocks.map((_, i) => plan.get(i) ?? 'Stamina'); // недобор — выносливостью, как в пресетах
}

function withGems(base: EquipmentItem, level: number, d: DrawSource): { item: EquipmentItem; gems: GemItem[] } {
  const pool = ITEMS.filter((i): i is GemItem => i.kind === 'gem');
  // ячеек у оружия бота — из мешка, 0 … уровень − 1 (у игрока ячейки создаёт ювелирный набор)
  const cells = drawInt(d, 'bot.cells', 0, gemSlotsAt(level));
  const gems = pool.length ? Array.from({ length: cells }, () => d.pick('bot.gem', pool, (g) => g.id)) : [];
  const ability = { ...base.ability, effects: [...base.ability.effects, ...gems.flatMap((g) => g.effects)] };
  // камни остаются в оружии: победитель забирает его вместе с ними
  const ids = [...new Set(gems.map((g) => g.id))];
  return { item: { ...base, name: weaponLevelName(base.name, level), itemLevel: level, gemSlots: gems.length, ability, ...(ids.length ? { gems: ids } : {}) }, gems };
}

export interface GenerateOpts {
  /** Уровень оружия игрока — бот получает его или ниже, до −weaponLevelSpread. */
  level?: number;
  /** Уровень оружия бота задан точно (серия арены: растёт от боя к бою) — без случайного снижения. */
  exactLevel?: boolean;
  /** Категория чертежа бойца игрока — бот той же категории (кубов столько же). */
  category?: number;
  /** presetId, который не повторять. */
  except?: string;
  cfg?: OpponentsConfig;
  /** Боец игрока — бот выбирает приоритет атаки под его сборку (этап 5). */
  player?: FighterInput;
  /**
   * Откуда броски (этап 6): мешки игрока (bagDraws) при выборе противника, повтор записи (replayDraws) на экранах.
   * По умолчанию — seed-рандом без мешков.
   */
  draws?: DrawSource;
}

/**
 * Приоритет атаки бота под сборку игрока (battle-rework, этап 5):
 * 1) стата, от которой скалируется оружие игрока (лучший выбор по симуляции — выбить урон);
 * 2) остальные статы игрока — от самых мелких (короче раскопка) к глубоким;
 * 3) статы, которых у игрока нет, — в конце.
 */
export function botTarget(player: FighterInput): Stat[] {
  const f = createFighter('player', player);
  const weaponStats = f.slots
    .map((s) => s.item)
    .filter((e): e is EquipmentItem => !!e && e.kind === 'weapon')
    .map((e) => e.scalingStat);
  const main = STATS.filter((s) => weaponStats.includes(s)).sort((a, b) => weaponStats.filter((x) => x === b).length - weaponStats.filter((x) => x === a).length);
  // глубина ближайшего куба статы: сколько живых кубов закрывает его в лучшем столбике
  const cost = (s: Stat) =>
    Math.min(...f.columns.map((col) => {
      const alive = col.filter((i) => f.blocks[i].alive);
      const k = alive.findIndex((i) => f.blocks[i].stat === s);
      return k < 0 ? Infinity : k;
    }));
  const rest = STATS.filter((s) => !main.includes(s)).sort((a, b) => cost(a) - cost(b) || STATS.indexOf(a) - STATS.indexOf(b));
  const order = [...main, ...rest];
  return digGoal(order, f) ? order : [...DEFAULT_TARGET];
}

/** Чертежи персонажей той же категории; если таких нет — ближайшей. */
export function blueprintsOfCategory(category?: number): CharacterBlueprint[] {
  const all = BLUEPRINTS.filter((b): b is CharacterBlueprint => b.kind === 'character');
  if (category === undefined || !all.length) return all;
  const best = Math.min(...all.map((b) => Math.abs(b.category - category)));
  return all.filter((b) => Math.abs(b.category - category) === best);
}

/** Собрать бота. Детерминирован: тот же seed, уровень и категория — тот же противник. */
export function buildOpponent(seed: number, playerLevel: number, category?: number, cfg: OpponentsConfig = OPPONENTS, d: DrawSource = rngDraws(createRng(seed)), player?: FighterInput, exactLevel = false): Opponent {
  const bp = d.pick('bot.blueprint', blueprintsOfCategory(category), (b) => b.id);
  const main = d.pick('bot.main', mainStats());
  // оружие бота никогда не сильнее, чем у игрока: тот же уровень или ниже на 0…spread
  const level = exactLevel
    ? Math.min(cfg.maxWeaponLevel, Math.max(cfg.minWeaponLevel, playerLevel))
    : Math.min(cfg.maxWeaponLevel, playerLevel, Math.max(cfg.minWeaponLevel, playerLevel - drawInt(d, 'bot.levelDrop', 0, cfg.weaponLevelSpread)));
  const mainWeapons = weapons().filter((w) => w.scalingStat === main);

  // снаряжение: оружие главной статы в каждую руку, артефакты — с шансом
  const equipment: Array<EquipmentItem | null> = bp.slots.map(() => null);
  const weaponLevels: Array<number | null> = bp.slots.map(() => null);
  const gemNotes: string[] = [];
  // артефакты с маной — только если включено (opponents.json → allowMana; пока выключено, 0.0.69)
  let arts = artifacts().filter((a) => cfg.allowMana !== false || a.ability.manaCost <= 0);
  bp.slots.forEach((slot, i) => {
    if (slot.type === 'Hand') {
      const { item, gems } = withGems(d.pick(`bot.weapon.${main}`, mainWeapons, (w) => w.id), level, d);
      equipment[i] = item;
      weaponLevels[i] = level;
      for (const g of gems) gemNotes.push(g.name.replace(/^камень\s+/i, '').toLowerCase());
    } else if (slot.type === 'Artifact' && arts.length && d.chance('bot.artifact', cfg.artifactChance)) {
      const a = d.pick('bot.artifactItem', arts, (x) => x.id);
      arts = arts.filter((x) => x !== a); // один артефакт — один раз
      equipment[i] = a;
    }
  });

  // требования к кубам: стата предмета (minStatRequired сверх базы) и мана на артефакты
  const need: Partial<Record<Stat, number>> = {};
  const raise = (s: Stat, n: number) => (need[s] = Math.max(need[s] ?? 0, Math.ceil(n)));
  let manaCost = 0;
  for (const e of equipment) {
    if (!e) continue;
    raise(e.scalingStat, e.minStatRequired - (bp.baseStats[e.scalingStat] ?? 0));
    manaCost = Math.max(manaCost, e.ability.manaCost);
  }
  if (manaCost > 0) raise('Intelligence', manaCost * cfg.manaCastsReserve - (bp.baseStats.Intelligence ?? 0));
  const counts = distributeCubes(bp.blocks.length, main, need, d, cfg);

  // рюкзак: зелья под свои статы, иногда запасное оружие
  // боты носят обычный рюкзак: большие — только у игрока (собираются по чертежу)
  const bags = ITEMS.filter((i): i is BagItem => i.kind === 'bag' && i.slot === 'Rucksack' && i.id === 'rucksack');
  let rucksack: string | null = null;
  const bag: OpponentBagEntry[] = [];
  if (bags.length && d.chance('bot.rucksack', cfg.rucksackChance)) {
    const r = d.pick('bot.rucksackItem', bags, (b) => b.id);
    rucksack = r.id;
    const n = Math.min(r.capacity, drawInt(d, 'bot.bagItems', cfg.bagItems[0], cfg.bagItems[1]));
    for (let k = 0; k < n; k++) {
      if (d.chance('bot.spareWeapon', cfg.spareWeaponChance)) bag.push({ itemId: d.pick(`bot.spare.${main}`, mainWeapons, (w) => w.id).id, count: 1 });
    }
  }

  // раскладка слоями: один из вариантов конфига (броня спереди, «стеклянная пушка» и т.д.)
  const layers = COMBAT.layout.bots.length ? d.pick('bot.layout', COMBAT.layout.bots, (v) => v.join('>')) : COMBAT.layout.autoBuild;
  const hasMana = equipment.some((e) => e && e.ability.manaCost > 0);
  const name = `${bp.name}-${MAIN_TITLE[main]}${hasMana ? '-маг' : ''}`;
  return {
    seed,
    presetId: `${bp.id}/${main}`,
    name: name[0].toUpperCase() + name.slice(1),
    pattern: [
      `${STAT_NAME[main]} · оружие ур. ${level}`,
      ...(gemNotes.length ? [`камни: ${[...new Set(gemNotes)].join(', ')}`] : []),
      rucksack ? `рюкзак: ${bag.length}` : 'без рюкзака',
    ].join(' · '),
    blueprintId: bp.id,
    blockStats: layBlocks(bp, counts, layers),
    equipment,
    target: player ? botTarget(player) : [...DEFAULT_TARGET],
    weaponLevels,
    rucksack,
    bag,
  };
}

/**
 * Противник для арены: бот из конфига — той же категории, что боец игрока, оружие под его уровень.
 * except — не повторять этот presetId, если есть из чего выбрать.
 */
export function generateOpponent(seed: number, opts: GenerateOpts = {}): Opponent {
  const { level = OPPONENTS.minWeaponLevel, category, except, cfg = OPPONENTS, player, draws = rngDraws(createRng(seed)), exactLevel = false } = opts;
  let o = buildOpponent(seed, level, category, cfg, draws, player, exactLevel);
  for (let k = 0; k < 8 && except && o.presetId === except; k++) o = buildOpponent(seed, level, category, cfg, draws, player, exactLevel);
  return o;
}

/**
 * Выбрать противника из мешков игрока и записать броски (этап 6). bags меняются на месте — вызывающий
 * сохраняет их; запись хранится в серии (ArenaOpponent.draws), и экраны собирают того же бота её повтором.
 */
export function recordOpponent(bags: Bags, seed: number, opts: Omit<GenerateOpts, 'draws' | 'player'> = {}): DrawLog {
  const log: DrawLog = [];
  generateOpponent(seed, { ...opts, draws: bagDraws(bags, createRng(seed), COMBAT.bagSize, log) });
  return log;
}
