// Арена — серия из ARENA.seriesLength боёв (press-your-luck), таб «Арена» доки бэкенда:
// - победа в последнем бою серии — награда в инвентарь (кубы + точильные камни или пергамент), серия закрывается;
//   вышел раньше — лут остаётся, награды нет;
// - проигранный бой можно переиграть ARENA.retries раз за серию: тот же противник, боец — как до боя, ничего не пропадает;
//   повторы кончились (или игрок сдался) — поражение;
// - после победы игрок сам перетаскивает лут противника (оружие, артефакты, содержимое рюкзака, осколки) в свой рюкзак,
//   сколько влезет; дальше либо выходит, либо идёт дальше;
// - поражение с потерей: надетое оружие и содержимое рюкзака пропадают, уровень рюкзака остаётся;
// - пока боец на арене (идёт серия), разбитые кубы не чинятся — только встроенным зельем;
//   вне арены восстанавливаются со временем, в том числе при закрытой игре.
// Чистые функции над PlayerState, как и остальное ядро.
import { ARENA, COMBAT, ITEMS, OPPONENTS, getBlueprint, getItem, hasItem, maxStackOf } from '../data/catalog';
import { resolveSkin } from '../data/skins';
import type { ArenaConfig, CharacterBlueprint, EquipmentItem, Stat } from '../data/types';
import { bagSlots, characterStats, discardFromBag, itemOf, lv, requirementGap, rucksackItemId } from './character';
import { SHARD_ID, addCubes, addItem, itemCount, potionItemOf, refillCharacterPotions, spendCubes, takeItems, uid, type CharacterState, type PlayerState } from './state';
import { createRng, randomSeed } from './rng';
import { RATING_START, ratingDeltas } from './rating';
import { playerWeaponLevel, recordOpponent } from './opponent';
import { bagDraws, drawInt, replayDraws, rngDraws, type Bags, type DrawLog, type DrawSource } from './bag';

/** Осколков на один куб (в доке «6 осколков + 1 смола»; смолы в прототипе нет). */
export const SHARDS_PER_CUBE = 6;
/** В лобби разбитый куб восстанавливается за это время (одна штука), мс. */
export const LOBBY_REGEN_MS = 30_000;

/** Противник следующего боя: seed генерации и уровень оружия. Не меняется до боя. */
export interface ArenaOpponent {
  seed: number;
  /** С exact — уровень оружия бота; без него (старый сейв) — уровень оружия игрока, бот получал его или ниже. */
  level: number;
  /** Уровень бота задан номером боя серии (seriesBotLevel). */
  exact?: boolean;
  /** Броски из мешков игрока, которыми выбран бот (этап 6); нет — старый сейв, бот из seed. */
  draws?: DrawLog;
  /** Противник — игрок: снимок его активного бойца на момент вызова и рейтинги обоих. Нет — бот. */
  player?: RivalInfo;
}

/** Снимок бойца для боя с игроками: с ним дерутся, пока хозяина нет в игре. Кубы целые. */
export interface FighterSnapshot {
  charName: string;
  blueprintId: string;
  /** Скин владельца — визуальный, переносится со снимком для PvP. */
  skinId?: string;
  blockStats: Stat[];
  equipment: Array<{ itemId: string; level?: number; cells?: number; gems?: string[] } | null>;
  target?: Stat[];
  /** Надетая сумка и её содержимое — лут победителю (копии: хозяин ничего не теряет). */
  rucksack: string | null;
  bag: Array<{ itemId: string; count: number }>;
}

export interface RivalInfo {
  userId: string;
  name: string;
  /** Рейтинг соперника и свой на момент вызова — по ним считается изменение рейтинга за бой. */
  rating: number;
  myRating: number;
  snapshot: FighterSnapshot;
}

/** Итог боя с игроком для сервера: разнести сопернику рейтинг, награду и запись в журнал. */
export interface PvpPending {
  id: string;
  opponentId: string;
  /** Победил нападавший. */
  win: boolean;
  /** Изменение рейтинга нападавшего (со знаком); у защитника — обратное. */
  delta: number;
  seed: number;
}

/** Запись журнала защитника. */
export interface InboxEntry {
  at: number;
  attacker: string;
  /** Защитник отбился. */
  won: boolean;
  ratingDelta: number;
  /** Награда за отбитое нападение — ждёт, пока игрок заберёт её из журнала. */
  reward?: SeriesReward;
}

/**
 * Арена игрока вне его состояния: рейтинг (Эло), счёт боёв с игроками и журнал нападений. Отдельная запись на
 * сервере — её меняют и свои бои, и чужие нападения, состояние игрока при этом не трогается.
 */
export interface ArenaProfile {
  rating: number;
  wins: number;
  losses: number;
  inbox: InboxEntry[];
}

export const freshArenaProfile = (): ArenaProfile => ({ rating: RATING_START, wins: 0, losses: 0, inbox: [] });

/** Снимок бойца. */
export function snapshotOf(c: CharacterState): FighterSnapshot {
  const pick = (e: { itemId: string; level?: number; cells?: number; gems?: string[] }) => ({
    itemId: e.itemId, ...(e.level !== undefined ? { level: e.level } : {}), ...(e.cells !== undefined ? { cells: e.cells } : {}), ...(e.gems?.length ? { gems: [...e.gems] } : {}),
  });
  return {
    charName: c.name,
    blueprintId: c.blueprintId,
    skinId: resolveSkin(c.blueprintId, c.skinId)?.id,
    blockStats: [...c.blockStats],
    equipment: c.equipment.map((e) => (e && hasItem(e.itemId) ? pick(e) : null)),
    ...(c.target ? { target: [...c.target] } : {}),
    rucksack: rucksackItemId(c),
    bag: (c.bag ?? []).filter((e): e is NonNullable<typeof e> => !!e && hasItem(e.itemId)).map((e) => ({ itemId: e.itemId, count: e.count })),
  };
}

export interface ArenaRun {
  charUid: string;
  /** Противник следующего боя — зафиксирован (старые сейвы: нет, startRun добавит). */
  opp?: ArenaOpponent;
  /** Номер текущего (следующего) боя, с 1. */
  fight: number;
  wins: number;
  /** Бой начат и не закончен — перезагрузка посреди боя засчитывается поражением. */
  inBattle: boolean;
  /** Сколько повторов проигранного боя потрачено за серию (старые сейвы: нет — 0). */
  retriesUsed?: number;
  /** Зерно начатого боя (выдаёт сервер в startFight): по нему бой считают и клиент, и сервер. */
  battleSeed?: number;
  /** Вид серии: с ботами (по умолчанию) или с игроками (соперник выбирается перед каждым боем, повторов нет). */
  mode?: 'bots' | 'players';
}

export interface FightResult {
  win: boolean;
  /** Разбитые кубы бойца после боя (индексы блоков). */
  brokenBlocks: number[];
  /** Сколько кубов противника разбито — столько осколков. */
  enemyBroken: number;
  seed: number;
}

export interface FightOutcome {
  state: PlayerState;
  /** Что пропало при поражении. */
  lost: string[];
  /** Серия пройдена (победа в последнем бою) — награда уже в инвентаре, серия закрыта. */
  reward?: SeriesReward;
  /** Бой проигран, но потрачен повтор: серия идёт, тот же противник, боец как до боя. */
  retry?: boolean;
}

/** Награда за пройденную серию. */
export interface SeriesReward {
  cubes: number;
  items: Array<{ itemId: string; count: number }>;
}

/** Боёв в серии. */
export const SERIES_LENGTH = ARENA.seriesLength;
/** Повторов проигранного боя на серию — по конфигу (arena.json). */
export const SERIES_RETRIES = ARENA.retries;
/** Отладочное переопределение лимита повторов (вкладка Debug); null — из конфига. */
let retriesOverride: number | null = null;
/** Задать лимит повторов на серию (null — вернуть значение из конфига). */
export function setSeriesRetries(n: number | null) {
  retriesOverride = n === null ? null : Math.max(0, Math.floor(n));
}
/** Текущий лимит повторов на серию: отладочный, если задан, иначе из конфига. */
export const seriesRetries = () => retriesOverride ?? SERIES_RETRIES;
/** Сколько повторов осталось в серии. */
export const retriesLeft = (run: Pick<ArenaRun, 'retriesUsed'> | null | undefined) => Math.max(0, seriesRetries() - (run?.retriesUsed ?? 0));

/** Бросок награды за серию: кубы всегда, плюс один вариант из drops по весу. Детерминирован по seed. */
export function rollSeriesReward(seed: number, cfg: ArenaConfig = ARENA, d: DrawSource = rngDraws(createRng(seed))): SeriesReward {
  const drops = cfg.reward.drops.filter((x) => hasItem(x.itemId) && x.weight > 0);
  const items: SeriesReward['items'] = [];
  if (drops.length) {
    // марбл-бэг (этап 6): 90/10 → из каждых 10 наград ровно 1 редкая; количество — каждое значение по разу за круг
    const drop = d.pick('reward.drop', drops, (x) => x.itemId, drops.map((x) => x.weight));
    items.push({ itemId: drop.itemId, count: drawInt(d, `reward.count.${drop.itemId}`, drop.count[0], drop.count[1]) });
  }
  return { cubes: cfg.reward.cubes, items };
}

/** Броски, которыми собирается выбранный бот: повтор записи; без записи (старый сейв) — seed. */
export const opponentDraws = (opp: Pick<ArenaOpponent, 'seed' | 'draws'>): DrawSource =>
  opp.draws ? replayDraws(opp.draws, rngDraws(createRng(opp.seed))) : rngDraws(createRng(opp.seed));

/** Копия мешков игрока — броски меняют её, результат кладётся обратно в состояние. */
const cloneBags = (s: PlayerState): Bags => JSON.parse(JSON.stringify(s.bags ?? {})) as Bags;

/**
 * Уровень оружия бота в бою серии: к последнему бою — как у игрока, в каждом бою раньше — на уровень ниже
 * (не ниже минимума). Серия идёт от простого противника к сложному.
 */
export function seriesBotLevel(playerLevel: number, fight: number): number {
  const top = Math.min(OPPONENTS.maxWeaponLevel, playerLevel);
  return Math.max(OPPONENTS.minWeaponLevel, top - Math.max(0, SERIES_LENGTH - fight));
}

/** Выбрать противника боя серии из мешков игрока: seed, уровень оружия по номеру боя и запись бросков (этап 6). */
function chooseOpponent(s: PlayerState, c: CharacterState, seed: number, fight: number): { opp: ArenaOpponent; bags: Bags } {
  const bags = cloneBags(s);
  const level = seriesBotLevel(charWeaponLevel(c), fight);
  const category = (getBlueprint(c.blueprintId) as CharacterBlueprint).category;
  return { opp: { seed, level, exact: true, draws: recordOpponent(bags, seed, { level, category, exactLevel: true }) }, bags };
}

/** Положить награду в инвентарь. */
export function grantReward(s: PlayerState, r: SeriesReward): PlayerState {
  let next = addCubes(s, r.cubes);
  for (const e of r.items) next = addItem(next, e.itemId, e.count, maxStackOf(e.itemId));
  return next;
}

/** Предмет лута: снаряжение (с уровнем экземпляра) или стопка ресурсов. */
export interface LootEntry {
  itemId: string;
  count: number;
  level?: number;
  /** Ячеек камней у оружия бота (этап 8). */
  cells?: number;
  /** Камни в этих ячейках — достаются вместе с оружием. */
  gems?: string[];
}

/** Лут побеждённого: надетое оружие и артефакты, содержимое рюкзака и осколки разбитых кубов. */
export function enemyLoot(equipment: ReadonlyArray<{ id: string; itemLevel: number; gemSlots?: number; gems?: string[] } | null>, bag: ReadonlyArray<{ itemId: string; count: number }>, brokenCubes: number): LootEntry[] {
  const out: LootEntry[] = [];
  for (const e of equipment) if (e && hasItem(e.id) && getItem(e.id).kind !== 'bag' && getItem(e.id).kind !== 'potion') out.push({ itemId: e.id, count: 1, level: e.itemLevel, ...(e.gemSlots ? { cells: e.gemSlots } : {}), ...(e.gems?.length ? { gems: [...e.gems] } : {}) });
  for (const e of bag) if (hasItem(e.itemId) && getItem(e.itemId).kind !== 'bag' && getItem(e.itemId).kind !== 'potion' && e.count > 0) out.push({ itemId: e.itemId, count: e.count });
  if (brokenCubes > 0) out.push({ itemId: SHARD_ID, count: brokenCubes });
  return out;
}

/**
 * Забрать лут в рюкзак бойца. cell — в эту ячейку (пустую или с той же стопкой);
 * без cell — докладывается в такие же стопки, остаток — в свободные ячейки.
 * left — сколько не влезло. null — рюкзака нет или положить некуда.
 */
export function takeLoot(s: PlayerState, charUid: string, e: LootEntry, cell?: number): { state: PlayerState; left: number } | null {
  const c = charOf(s, charUid);
  if (!c || !hasItem(e.itemId) || e.count <= 0) return null;
  const slots = bagSlots(c);
  if (!slots.length) return null;
  const max = maxStackOf(e.itemId);
  let left = e.count;
  let next = s;
  const putInto = (k: number) => {
    const cur = slots[k];
    if (cur && (cur.itemId !== e.itemId || max <= 1)) return;
    const n = Math.min(max - (cur?.count ?? 0), left);
    if (n <= 0) return;
    if (cur) slots[k] = { ...cur, count: cur.count + n };
    else {
      let id: string;
      [id, next] = uid(next, 'i');
      slots[k] = { uid: id, itemId: e.itemId, count: n, ...lv(e) };
    }
    left -= n;
  };
  if (cell !== undefined) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= slots.length) return null;
    putInto(cell);
  } else {
    slots.forEach((x, k) => x && putInto(k));
    slots.forEach((x, k) => !x && putInto(k));
  }
  if (left === e.count) return null;
  return { state: withChar(next, { ...c, bag: slots }), left };
}

const runOf = (s: PlayerState) => s.arenaRun ?? null;
const charOf = (s: PlayerState, uid: string) => s.characters.find((c) => c.uid === uid) ?? null;
const withChar = (s: PlayerState, c: CharacterState): PlayerState => ({ ...s, characters: s.characters.map((x) => (x.uid === c.uid ? c : x)) });

/** Уровень оружия бойца в руках — от него генерируется противник. */
function charWeaponLevel(c: CharacterState): number {
  return playerWeaponLevel(c.equipment.map((e) => (e && hasItem(e.itemId) ? (itemOf(e) as EquipmentItem) : null)));
}

/**
 * Начать серию (или продолжить ту, что идёт за этого бойца). Противник выбирается сразу и фиксируется.
 * Пока серия идёт, другого бойца не взять и противника не сменить — только бой.
 */
export function startRun(s: PlayerState, charUid: string, oppSeed: number = randomSeed()): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c) return null;
  const run = runOf(s);
  if (run && (run.charUid !== charUid || run.mode === 'players')) return null;
  if (run?.opp) return s;
  const { opp, bags } = chooseOpponent(s, c, oppSeed, run?.fight ?? 1);
  if (run) return { ...s, bags, arenaRun: { ...run, opp } };
  return {
    ...s,
    bags,
    loot: null,
    lastArenaCharacterId: charUid,
    arenaRun: { charUid, fight: 1, wins: 0, inBattle: false, opp, mode: 'bots' },
  };
}

/**
 * Вызвать игрока: начать серию с игроками или выбрать соперника на следующий её бой.
 * Соперника (снимок бойца, рейтинги) и зерно даёт сервер. null — идёт другая серия или бой.
 */
export function startPvp(s: PlayerState, charUid: string, rival: RivalInfo, seed: number): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c || !getBlueprintOrNull(rival.snapshot.blueprintId)) return null;
  const run = runOf(s);
  const opp: ArenaOpponent = { seed: seed >>> 0, level: 0, exact: true, player: rival };
  if (!run) return { ...s, loot: null, pvpPending: null, lastArenaCharacterId: charUid, arenaRun: { charUid, fight: 1, wins: 0, inBattle: false, opp, mode: 'players' } };
  if (run.mode !== 'players' || run.charUid !== charUid || run.opp || run.inBattle) return null;
  return { ...s, loot: null, pvpPending: null, arenaRun: { ...run, opp } };
}

const getBlueprintOrNull = (id: string) => {
  try {
    return getBlueprint(id);
  } catch {
    return null;
  }
};

/** Итог боя с игроком — запись для сервера: он меняет рейтинг и счёт обоим (ArenaProfile) и пишет защитнику в журнал. */
function settlePvp(s: PlayerState, run: ArenaRun, win: boolean, seed: number): PlayerState {
  const rival = run.opp?.player;
  if (!rival) return s;
  const d = ratingDeltas(rival.myRating, rival.rating);
  const delta = win ? d.win : d.lose;
  return {
    ...s,
    pvpPending: { id: `${run.opp!.seed}:${run.fight}:${seed >>> 0}`, opponentId: rival.userId, win, delta, seed: seed >>> 0 },
  };
}

/** Начать бой с выбранным противником: зерно боя фиксируется; дальше выход или перезагрузка — поражение. */
export function startFight(s: PlayerState, seed: number): PlayerState | null {
  const run = runOf(s);
  if (!run || !run.opp || run.inBattle || !charOf(s, run.charUid)) return null;
  return { ...s, loot: null, arenaRun: { ...run, inBattle: true, battleSeed: seed >>> 0 } };
}

/** Забрать лут побеждённого (s.loot) в рюкзак бойца: запись index, в ячейку cell или куда влезет. */
export function lootTake(s: PlayerState, index: number, cell?: number): { state: PlayerState; left: number } | null {
  const loot = s.loot;
  const e = loot?.entries[index];
  if (!loot || !e) return null;
  const res = takeLoot(s, loot.charUid, e, cell);
  if (!res) return null;
  const entries = loot.entries.slice();
  if (res.left > 0) entries[index] = { ...e, count: res.left };
  else entries.splice(index, 1);
  return { state: { ...res.state, loot: { ...loot, entries } }, left: res.left };
}

/** Выложить вещь из рюкзака к луту врага (окно победы): пока окно открыто, её можно забрать обратно. */
export function lootDrop(s: PlayerState, cell: number): PlayerState | null {
  const loot = s.loot;
  if (!loot) return null;
  const res = discardFromBag(s, loot.charUid, cell);
  if (!res) return null;
  const e = res.entry;
  const entry: LootEntry = { itemId: e.itemId, count: e.count, ...(e.level !== undefined ? { level: e.level } : {}), ...(e.cells !== undefined ? { cells: e.cells } : {}), ...(e.gems?.length ? { gems: e.gems } : {}) };
  return { ...res.state, loot: { ...loot, entries: [...loot.entries, entry] } };
}

/** Закрыть окно лута: незабранное пропадает. */
export function lootClose(s: PlayerState): PlayerState {
  return s.loot ? { ...s, loot: null } : s;
}

/** Бой начат: дальше выход или перезагрузка — поражение. */
export function markInBattle(s: PlayerState): PlayerState | null {
  const run = runOf(s);
  return run ? { ...s, arenaRun: { ...run, inBattle: true } } : null;
}

/** Итог боя серии. */
export function finishFight(s: PlayerState, r: FightResult): FightOutcome | null {
  const run = runOf(s);
  const c0 = run && charOf(s, run.charUid);
  if (!run || !c0) return null;
  if (run.mode === 'players') return finishPvpFight(s, run, c0, r);
  if (!r.win) {
    // есть повтор — бой переигрывается: боец как до боя, ничего не пропадает
    if (retriesLeft(run) > 0) {
      return { state: { ...s, arenaRun: { ...run, inBattle: false, retriesUsed: (run.retriesUsed ?? 0) + 1 } }, lost: [], retry: true };
    }
    return applyLoss(s, run.charUid);
  }
  // лут не падает сам — игрок забирает его в окне победы (takeLoot), в том числе после конца серии
  if (run.fight >= SERIES_LENGTH) {
    const bags = cloneBags(s);
    const reward = rollSeriesReward(r.seed ^ 0x5e71e5, ARENA, bagDraws(bags, createRng(r.seed ^ 0x5e71e5), COMBAT.bagSize));
    return { state: grantReward(endRun({ ...s, bags }), reward), lost: [], reward };
  }
  const c: CharacterState = { ...c0, brokenBlocks: [...r.brokenBlocks].sort((a, b) => a - b) };
  // следующий противник выбирается сразу после победы — под оружие, с которым боец вышел из боя
  const next = chooseOpponent(withChar(s, c), c, createRng(r.seed ^ 0x0bb0).int(1, 0x7fffffff), run.fight + 1);
  return {
    state: {
      ...withChar(s, c),
      bags: next.bags,
      arenaRun: { ...run, fight: run.fight + 1, wins: run.wins + 1, inBattle: false, opp: next.opp },
    },
    lost: [],
  };
}

/** Бой серии с игроками: повторов нет; после победы соперник следующего боя выбирается заново (startPvp). */
function finishPvpFight(s0: PlayerState, run: ArenaRun, c0: CharacterState, r: FightResult): FightOutcome {
  const s = settlePvp(s0, run, r.win, r.seed);
  if (!r.win) return applyLoss(s, run.charUid);
  if (run.fight >= SERIES_LENGTH) {
    const bags = cloneBags(s);
    const reward = rollSeriesReward(r.seed ^ 0x5e71e5, ARENA, bagDraws(bags, createRng(r.seed ^ 0x5e71e5), COMBAT.bagSize));
    return { state: grantReward(endRun({ ...s, bags }), reward), lost: [], reward };
  }
  const c: CharacterState = { ...c0, brokenBlocks: [...r.brokenBlocks].sort((a, b) => a - b) };
  const { opp: _opp, ...rest } = run;
  return { state: { ...withChar(s, c), arenaRun: { ...rest, fight: run.fight + 1, wins: run.wins + 1, inBattle: false } }, lost: [] };
}

/** Что теряется при поражении в серии этого вида (arena.json → loss). */
let lossOverride: { bots: 'keep' | 'drop'; players: 'keep' | 'drop' } | null = null;
/** Переопределить правило поражения (тесты); null — из конфига. */
export const setLossRule = (rule: typeof lossOverride) => (lossOverride = rule);
export const lossRule = (mode: ArenaRun['mode']): 'keep' | 'drop' => (lossOverride ?? ARENA.loss ?? { bots: 'drop', players: 'drop' })[mode === 'players' ? 'players' : 'bots'];

function restoreAfterRun(c: CharacterState): CharacterState {
  return refillCharacterPotions({ ...c, brokenBlocks: [], lobbySince: undefined });
}

/**
 * Поражение в серии — серия закрыта. По правилу вида серии (lossRule): drop — пропадают надетое оружие и
 * содержимое рюкзака, артефакты и уровень рюкзака остаются; keep — всё остаётся у бойца.
 */
function applyLoss(s: PlayerState, charUid: string): FightOutcome {
  const c = charOf(s, charUid)!;
  if (lossRule(s.arenaRun?.mode) === 'keep') {
    return { state: { ...withChar(s, restoreAfterRun(c)), arenaRun: null }, lost: [] };
  }
  const bp = getBlueprint(c.blueprintId) as CharacterBlueprint;
  const lost: string[] = [];
  const equipment = c.equipment.map((e, i) => {
    if (e && bp.slots[i]?.type === 'Hand') {
      lost.push(e.itemId);
      return null;
    }
    return e;
  });
  for (const e of c.bag ?? []) if (e) lost.push(e.itemId);
  const restored = restoreAfterRun({ ...c, equipment, bag: [] });
  return { state: { ...withChar(s, restored), arenaRun: null }, lost };
}

/** Сдаться: принять поражение в серии, не тратя оставшиеся повторы. */
export function surrenderRun(s: PlayerState): FightOutcome | null {
  const run = runOf(s);
  if (!run || !charOf(s, run.charUid)) return null;
  return applyLoss(s, run.charUid);
}

/** Выйти из серии: лут остаётся в рюкзаке, боец возвращается в лобби. */
export function endRun(s: PlayerState): PlayerState {
  const run = runOf(s);
  if (!run) return s;
  const c = charOf(s, run.charUid);
  const next: PlayerState = { ...s, arenaRun: null, loot: null };
  return c ? withChar(next, restoreAfterRun(c)) : next;
}

/** Перезагрузка посреди боя — поражение. */
export function forfeitIfInBattle(s: PlayerState): PlayerState {
  const run = runOf(s);
  const c = run && charOf(s, run.charUid);
  if (!run?.inBattle || !c) return s;
  return finishFight(s, { win: false, brokenBlocks: c.brokenBlocks, enemyBroken: 0, seed: 0 })?.state ?? s;
}

/** Переработать осколки из инвентаря в кубы: SHARDS_PER_CUBE за куб, сколько хватает. */
export function convertShards(s: PlayerState): PlayerState | null {
  const n = Math.floor(itemCount(s, SHARD_ID) / SHARDS_PER_CUBE);
  if (n <= 0) return null;
  const paid = takeItems(s, SHARD_ID, n * SHARDS_PER_CUBE);
  return paid ? addCubes(paid, n) : null;
}

/** Боец в серии (после первой победы или в бою) — снаряжение меняется только из рюкзака. */
export const inRun = (s: PlayerState, charUid: string) => s.arenaRun?.charUid === charUid && (s.arenaRun.wins > 0 || s.arenaRun.inBattle);

// ───────────── зелья ─────────────

/** Сколько кубов встроенное зелье статы починит прямо сейчас (0 — нечего чинить). */
export function potionEffect(c: CharacterState, stat: Stat): number {
  const item = potionItemOf(c, stat);
  if (item.kind !== 'potion') return 0;
  const broken = c.brokenBlocks.filter((i) => c.blockStats[i] === stat).length;
  return Math.min(item.restoreAmount, broken);
}

/** Выпить встроенное зелье: один заряд чинит кубы его статы (prefer — сначала этот куб). */
export function drinkPotion(s: PlayerState, charUid: string, stat: Stat, prefer?: number): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c || !c.potions[stat] || c.potions[stat].charges <= 0) return null;
  const n = potionEffect(c, stat);
  if (n <= 0) return null;
  const pool = c.brokenBlocks.filter((i) => c.blockStats[i] === stat);
  if (prefer !== undefined && pool.includes(prefer)) pool.splice(pool.indexOf(prefer), 1), pool.unshift(prefer);
  const fix = new Set(pool.slice(0, n));
  const brokenBlocks = c.brokenBlocks.filter((i) => !fix.has(i));
  return withChar(s, {
    ...c,
    potions: { ...c.potions, [stat]: { ...c.potions[stat], charges: c.potions[stat].charges - 1 } },
    brokenBlocks,
    lobbySince: brokenBlocks.length ? c.lobbySince : undefined,
  });
}

/**
 * Взять оружие или артефакт из рюкзака в слот (между боями серии): то, что было в слоте,
 * встаёт в ту же ячейку рюкзака.
 */
export function equipFromBag(s: PlayerState, charUid: string, cell: number, slot: number): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c) return null;
  const bp = getBlueprint(c.blueprintId) as CharacterBlueprint;
  const slots = bagSlots(c);
  const e = slots[cell];
  const sl = bp.slots[slot];
  if (!e || !sl || !hasItem(e.itemId)) return null;
  const item = getItem(e.itemId);
  if (!(item.kind === 'weapon' && sl.type === 'Hand') && !(item.kind === 'artifact' && sl.type === 'Artifact')) return null;
  if (requirementGap(item, characterStats(bp, c.blockStats)) > 0) return null;
  const cur = c.equipment[slot];
  slots[cell] = cur ? { uid: cur.uid, itemId: cur.itemId, count: 1, ...lv(cur) } : null;
  const equipment = c.equipment.map((x, i) => (i === slot ? { uid: e.uid, itemId: e.itemId, ...lv(e) } : x));
  return withChar(s, { ...c, equipment, bag: slots });
}

/** Убрать предмет из слота в свободную ячейку рюкзака. */
export function stowToBag(s: PlayerState, charUid: string, slot: number): PlayerState | null {
  const c = charOf(s, charUid);
  const cur = c?.equipment[slot];
  if (!c || !cur) return null;
  const slots = bagSlots(c);
  const free = slots.findIndex((x) => !x);
  if (free < 0) return null;
  slots[free] = { uid: cur.uid, itemId: cur.itemId, count: 1, ...lv(cur) };
  return withChar(s, { ...c, bag: slots, equipment: c.equipment.map((x, i) => (i === slot ? null : x)) });
}

/**
 * Перетащить предмет из слота в конкретную ячейку рюкзака: в пустую — убрать; в ячейку с оружием или артефактом,
 * который подходит этому слоту, — поменять местами. null — нельзя.
 */
export function stowToBagCell(s: PlayerState, charUid: string, slot: number, cell: number): PlayerState | null {
  const c = charOf(s, charUid);
  const cur = c?.equipment[slot];
  if (!c || !cur) return null;
  const slots = bagSlots(c);
  if (cell < 0 || cell >= slots.length) return null;
  if (slots[cell]) return equipFromBag(s, charUid, cell, slot);
  slots[cell] = { uid: cur.uid, itemId: cur.itemId, count: 1, ...lv(cur) };
  return withChar(s, { ...c, bag: slots, equipment: c.equipment.map((x, i) => (i === slot ? null : x)) });
}

// ───────────── лобби ─────────────

/** Боец на арене (идёт его серия, в том числе до первого боя) — кубы сами не чинятся. */
const onArena = (s: PlayerState, charUid: string) => s.arenaRun?.charUid === charUid;

/**
 * Восстановление вне арены: по одному кубу за LOBBY_REGEN_MS с момента lobbySince.
 * Считается по времени, поэтому идёт и при закрытой игре (догоняется при загрузке).
 * Боец в серии не чинится. Возвращает то же состояние, если чинить нечего.
 */
export function lobbyRegen(s: PlayerState, now: number): PlayerState {
  let changed = false;
  const characters = s.characters.map((c) => {
    if (!c.brokenBlocks.length || onArena(s, c.uid)) return c;
    const since = c.lobbySince ?? now;
    const n = Math.floor((now - since) / LOBBY_REGEN_MS);
    if (c.lobbySince === undefined) {
      changed = true;
      return { ...c, lobbySince: now };
    }
    if (n <= 0) return c;
    changed = true;
    const left = c.brokenBlocks.slice(n);
    return { ...c, brokenBlocks: left, lobbySince: left.length ? since + n * LOBBY_REGEN_MS : undefined };
  });
  return changed ? { ...s, characters } : s;
}

/** Через сколько мс восстановится следующий куб (null — чинить нечего или боец на арене). */
export function nextRegenIn(s: PlayerState, c: CharacterState, now: number): number | null {
  if (!c.brokenBlocks.length || onArena(s, c.uid) || c.lobbySince === undefined) return null;
  return LOBBY_REGEN_MS - ((now - c.lobbySince) % LOBBY_REGEN_MS);
}

/** Через сколько мс восстановятся все разбитые кубы (null — чинить нечего или боец на арене). */
export function fullRegenIn(s: PlayerState, c: CharacterState, now: number): number | null {
  const next = nextRegenIn(s, c, now);
  return next === null ? null : next + (c.brokenBlocks.length - 1) * LOBBY_REGEN_MS;
}

/** Отладка: полностью вылечить бойца — все разбитые кубы целы, таймер восстановления сброшен. */
export function healFull(s: PlayerState, charUid: string): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c || !c.brokenBlocks.length) return null;
  return withChar(s, { ...c, brokenBlocks: [], lobbySince: undefined });
}

/** Активный боец: тот, что в серии; иначе последний выбранный для арены; иначе первый. */
export function activeCharacter(s: PlayerState): CharacterState | null {
  const byUid = (uid: string | null | undefined) => (uid ? s.characters.find((c) => c.uid === uid) ?? null : null);
  return byUid(s.arenaRun?.charUid) ?? byUid(s.lastArenaCharacterId) ?? s.characters[0] ?? null;
}

// ───────────── починка за кубы ─────────────

/**
 * Сколько кубов стоит починить n разбитых кубов статы — как если бы собрать для этого зелья:
 * самый дешёвый набор флаконов (малый чинит 3, большой — 5), что покрывает n.
 */
export function repairCostForStat(stat: Stat, n: number): number {
  if (n <= 0) return 0;
  const potions = ITEMS.filter((i) => i.kind === 'potion' && i.restoreStat === stat && i.blueprintId).map((i) => ({
    cost: getBlueprint(i.blueprintId!).blocks.length,
    amount: (i as { restoreAmount: number }).restoreAmount,
  }));
  if (!potions.length) return Infinity;
  const dp = [0];
  for (let k = 1; k <= n; k++) dp[k] = Math.min(...potions.map((p) => p.cost + dp[Math.max(0, k - p.amount)]));
  return dp[n];
}

/** Цена полной починки бойца за кубы (по статам разбитых кубов). */
export function repairCost(c: CharacterState): number {
  const by = new Map<Stat, number>();
  for (const i of c.brokenBlocks) by.set(c.blockStats[i], (by.get(c.blockStats[i]) ?? 0) + 1);
  let sum = 0;
  for (const [st, n] of by) sum += repairCostForStat(st, n);
  return sum;
}

/** Починить бойца полностью за кубы из инвентаря. На арене — нельзя (там только встроенные зелья). */
export function repairAll(s: PlayerState, charUid: string): PlayerState | null {
  const c = charOf(s, charUid);
  if (!c || !c.brokenBlocks.length || s.arenaRun?.charUid === charUid) return null;
  const cost = repairCost(c);
  if (!Number.isFinite(cost)) return null;
  const paid = spendCubes(s, cost);
  return paid ? withChar(paid, { ...c, brokenBlocks: [], lobbySince: undefined }) : null;
}
