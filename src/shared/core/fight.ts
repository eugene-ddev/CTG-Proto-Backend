// Бой серии по данным из состояния — одинаково считается в браузере (показ) и на сервере (итог).
// Противник и зерно боя лежат в arenaRun (их выбирает сервер), боец — в characters; от игрока в бой попадает
// только ввод: когда он нажал артефакт и на каком ходу сдался. Итог боя клиент не присылает — его даёт пересчёт.
import { getBlueprint, hasItem } from '../data/catalog';
import type { CharacterBlueprint, EquipmentItem } from '../data/types';
import { enemyLoot, finishFight, opponentDraws, type FightOutcome, type FightResult, type LootEntry, type RivalInfo } from './arena';
import { createBattle, step, useArtifact, MAX_TURNS, type BattleState, type FighterInput } from './battle';
import { itemOf } from './character';
import { generateOpponent, playerWeaponLevel, type Opponent } from './opponent';
import type { CharacterState, PlayerState } from './state';

/** Ввод игрока за бой. */
export interface FightInputs {
  /** Артефакты: slot нажат после after ходов (step) с начала боя. */
  artifacts?: Array<{ after: number; slot: number }>;
  /** Сдался или вышел после стольких ходов; нет — бой до конца. */
  stopAfter?: number;
}

/** Боец игрока для боя. */
export function fighterInputOf(c: CharacterState): FighterInput {
  return {
    name: c.name,
    blueprintId: c.blueprintId,
    skinId: c.skinId,
    blockStats: c.blockStats,
    brokenBlocks: c.brokenBlocks,
    equipment: c.equipment.map((e) => (e && hasItem(e.itemId) ? (itemOf(e) as EquipmentItem) : null)),
    target: c.target,
  };
}

/** Противник-игрок из снимка его бойца: кубы целые, оружие и приоритет атаки — как у хозяина. */
export function rivalOpponent(rival: RivalInfo, seed: number): Opponent {
  const snap = rival.snapshot;
  const equipment = snap.equipment.map((e) => (e && hasItem(e.itemId) ? (itemOf(e) as EquipmentItem) : null));
  return {
    name: rival.name,
    blueprintId: snap.blueprintId,
    skinId: snap.skinId,
    blockStats: snap.blockStats,
    brokenBlocks: [],
    equipment,
    target: snap.target,
    seed,
    presetId: `player:${rival.userId}`,
    pattern: `${snap.charName} · рейтинг ${rival.rating}`,
    weaponLevels: equipment.map((e) => (e && 'itemLevel' in e ? e.itemLevel : null)),
    rucksack: snap.rucksack,
    bag: snap.bag.filter((e) => hasItem(e.itemId) && e.count > 0),
  };
}

export interface FightSetup {
  char: CharacterState;
  me: FighterInput;
  opp: Opponent;
}

/** Боец серии и его противник (зафиксирован в arenaRun.opp). null — серии нет или противник ещё не выбран. */
export function fightSetup(s: PlayerState): FightSetup | null {
  const run = s.arenaRun;
  const char = run && s.characters.find((c) => c.uid === run.charUid);
  if (!run || !char || !run.opp) return null;
  const me = fighterInputOf(char);
  if (run.opp.player) return { char, me, opp: rivalOpponent(run.opp.player, run.opp.seed) };
  const category = (getBlueprint(char.blueprintId) as CharacterBlueprint).category;
  const opp = generateOpponent(run.opp.seed, {
    level: run.opp.level ?? playerWeaponLevel(me.equipment),
    exactLevel: !!run.opp.exact,
    category,
    player: me,
    draws: opponentDraws(run.opp),
  });
  return { char, me, opp };
}

/** Начатый бой: зерно выдано (startFight). null — бой не начат. */
export function createRunBattle(s: PlayerState): { setup: FightSetup; battle: BattleState } | null {
  const run = s.arenaRun;
  const setup = fightSetup(s);
  if (!run || !setup || !run.inBattle || run.battleSeed === undefined) return null;
  return { setup, battle: createBattle(run.battleSeed, setup.me, setup.opp) };
}

/**
 * Пересчитать бой с вводом игрока. Порядок как в сцене боя: артефакт, нажатый после n ходов, срабатывает
 * перед ходом n + 1; ввод, который сейчас невозможен (кулдаун, мана), пропускается.
 */
export function replayFight(s: PlayerState, inputs: FightInputs): { setup: FightSetup; battle: BattleState; result: FightResult } | null {
  const made = createRunBattle(s);
  if (!made) return null;
  const b = made.battle;
  const uses = (inputs.artifacts ?? []).filter((u) => u && Number.isInteger(u.after) && Number.isInteger(u.slot)).slice(0, MAX_TURNS * 4);
  const stop = inputs.stopAfter === undefined ? Infinity : Math.max(0, Math.floor(inputs.stopAfter));
  let steps = 0;
  const useAt = (n: number) => {
    for (const u of uses) if (u.after === n) useArtifact(b, 'player', u.slot);
  };
  while (!b.over && steps < stop) {
    useAt(steps);
    if (b.over) break;
    step(b);
    steps++;
  }
  useAt(steps);
  // сдался или вышел до конца боя — поражение с теми кубами, что разбиты к этому ходу
  const win = !!b.over && b.over.winner === 'player' && steps <= stop;
  const result: FightResult = {
    win: b.over ? win : false,
    brokenBlocks: b.player.blocks.filter((x) => !x.alive).map((x) => x.index),
    enemyBroken: b.enemy.blocks.filter((x) => !x.alive).length,
    seed: b.seed,
  };
  return { setup: made.setup, battle: b, result };
}

export interface ResolvedFight extends FightOutcome {
  result: FightResult;
  /** Лут побеждённого (при победе) — лежит в состоянии, забирается действием lootTake. */
  loot: LootEntry[];
}

/** Итог начатого боя серии: пересчёт по вводу, последствия (finishFight), лут врага — в состояние. */
export function resolveFight(s: PlayerState, inputs: FightInputs): ResolvedFight | null {
  const played = replayFight(s, inputs);
  if (!played) return null;
  const out = finishFight(s, played.result);
  if (!out) return null;
  const loot = played.result.win ? enemyLoot(played.setup.opp.equipment, played.setup.opp.bag, played.result.enemyBroken) : [];
  const state: PlayerState = { ...out.state, loot: played.result.win ? { charUid: played.setup.char.uid, entries: loot } : null };
  return { ...out, state, result: played.result, loot };
}
