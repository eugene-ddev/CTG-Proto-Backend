// Изменение готового персонажа (0.0.50): тот же вид, что у сборки по чертежу. Кубы можно перекрасить,
// убрать и поставить обратно — руками или ползунками. Кубы списываются при подтверждении:
// EDIT_COST за каждый куб, стата которого в итоге отличается от исходной (убрал и вернул тем же цветом — бесплатно).
// Разбитые кубы не меняются. Чистые функции без Phaser.
import { STATS, type Stat, type Vec3 } from '../data/types';
import { frontToBack, layeredStats } from './layout';
import { emptyCounts, type StatCounts } from './stats';
import { cubeCount, spendCubes, type PlayerState } from './state';

/** Цена одного изменённого куба. */
export const EDIT_COST = 1;

/** Стата каждого куба модели в редакторе; null — куб убран (пустое место). */
export type Cells = Array<Stat | null>;

/** Сколько кубов каждой статы стоит сейчас (пустые места не считаются). */
export function cellCounts(cells: readonly (Stat | null)[]): StatCounts {
  const out = emptyCounts();
  for (const s of cells) if (s) out[s]++;
  return out;
}

/** Сколько кубов изменено: поставлены и стата отличается от исходной. */
export function editChanges(orig: readonly Stat[], cells: readonly (Stat | null)[]): number {
  return cells.reduce((n, s, i) => (s && s !== orig[i] ? n + 1 : n), 0);
}

export const editCost = (orig: readonly Stat[], cells: readonly (Stat | null)[]) => editChanges(orig, cells) * EDIT_COST;

/** Разница по статам «стало − было» (только ненулевые). */
export function editDelta(orig: readonly Stat[], cells: readonly (Stat | null)[]): Array<[Stat, number]> {
  const a = cellCounts(orig);
  const b = cellCounts(cells);
  return STATS.map((s) => [s, b[s] - a[s]] as [Stat, number]).filter(([, d]) => d !== 0);
}

/**
 * Ползунки: привести модель к квотам target, меняя как можно меньше.
 * Лишние кубы статы убираются (сначала уже изменённые — так ползунок назад возвращает исходное, потом те, что
 * стоят не на своём месте по раскладке слоями, потом с тыла); недостающие ставятся в пустые места — сначала туда,
 * где эта стата была изначально, потом по раскладке слоями (order — combat.json → layout.autoBuild, броня спереди).
 * Сумма квот меньше числа кубов — остаются пустые места. locked (разбитые) не трогаются.
 */
export function rebalanceCells(
  blocks: ReadonlyArray<{ pos: Vec3 }>,
  orig: readonly Stat[],
  cells: readonly (Stat | null)[],
  locked: ReadonlySet<number>,
  target: StatCounts,
  order: readonly Stat[],
): Cells {
  const out: Cells = [...cells];
  const free = (i: number) => !locked.has(i);
  const ftb = frontToBack(blocks, free);
  const rank = new Map(ftb.map((i, k) => [i, k]));
  const lockedCounts = cellCounts([...locked].map((i) => cells[i]));
  const want = Object.fromEntries(STATS.map((s) => [s, Math.max(0, target[s] - lockedCounts[s])])) as StatCounts;
  const ideal = layeredStats(blocks, want, order, free);

  const cur = cellCounts(out);
  for (const s of STATS) {
    const extra = cur[s] - target[s];
    if (extra <= 0) continue;
    const group = (i: number) => (out[i] !== orig[i] ? 0 : ideal.get(i) !== s ? 1 : 2);
    ftb
      .filter((i) => out[i] === s)
      .sort((a, b) => group(a) - group(b) || rank.get(b)! - rank.get(a)!)
      .slice(0, extra)
      .forEach((i) => (out[i] = null));
  }

  const seq = [...order.filter((s) => STATS.includes(s)), ...STATS.filter((s) => !order.includes(s))];
  for (const s of seq) {
    const need = target[s] - cellCounts(out)[s];
    if (need <= 0) continue;
    const group = (i: number) => (orig[i] === s ? 0 : ideal.get(i) === s ? 1 : 2);
    ftb
      .filter((i) => out[i] === null)
      .sort((a, b) => group(a) - group(b) || rank.get(a)! - rank.get(b)!)
      .slice(0, need)
      .forEach((i) => (out[i] = s));
  }
  return out;
}

/**
 * Подтвердить изменения: все места заняты, разбитые кубы не тронуты, хватает кубов на цену.
 * Нельзя в серии арены после первой победы и во время боя (как снаряжение). null — изменений нет или нельзя.
 */
export function applyCharacterEdit(s: PlayerState, charUid: string, cells: readonly (Stat | null)[]): PlayerState | null {
  const c = s.characters.find((x) => x.uid === charUid);
  if (!c || editLocked(s, charUid)) return null;
  if (cells.length !== c.blockStats.length || cells.some((x) => !x)) return null;
  if (c.brokenBlocks.some((i) => cells[i] !== c.blockStats[i])) return null;
  const cost = editCost(c.blockStats, cells);
  if (cost === 0 || cubeCount(s) < cost) return null;
  const paid = spendCubes(s, cost);
  if (!paid) return null;
  const blockStats = cells as Stat[];
  return { ...paid, characters: paid.characters.map((x) => (x.uid === charUid ? { ...x, blockStats: [...blockStats] } : x)) };
}

/** Персонажа нельзя менять: идёт серия арены этим бойцом (после победы или в бою). */
export const editLocked = (s: PlayerState, charUid: string) => s.arenaRun?.charUid === charUid && (s.arenaRun.wins > 0 || s.arenaRun.inBattle);
