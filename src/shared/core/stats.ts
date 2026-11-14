// Распределение кубов персонажа по статам при крафте.
import { STATS, type CharacterBlueprint, type Stat } from '../data/types';

export type StatCounts = Record<Stat, number>;

export const emptyCounts = (): StatCounts => ({ Armor: 0, Strength: 0, Dexterity: 0, Intelligence: 0, Stamina: 0, Luck: 0 });

export const totalCount = (c: StatCounts) => STATS.reduce((n, s) => n + c[s], 0);

/**
 * Распределение по умолчанию — пропорционально baseStats чертежа (метод наибольших остатков),
 * сумма ровно равна числу блоков. Без baseStats — поровну.
 */
export function defaultCounts(bp: CharacterBlueprint): StatCounts {
  const n = bp.blocks.length;
  const weights = STATS.map((s) => Math.max(0, bp.baseStats[s] ?? 0));
  const sum = weights.reduce((a, b) => a + b, 0) || STATS.length;
  const w = sum === STATS.length && weights.every((x) => x === 0) ? STATS.map(() => 1) : weights;
  const exact = w.map((x) => (x / sum) * n);
  const base = exact.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((x, i) => [x - base[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    base[i]++;
    left--;
  }
  const out = emptyCounts();
  STATS.forEach((s, i) => (out[s] = base[i]));
  return out;
}

/** Сколько блоков уже поставлено каждой статой. */
export function usedCounts(assigned: ReadonlyMap<number, Stat>): StatCounts {
  const out = emptyCounts();
  for (const s of assigned.values()) out[s]++;
  return out;
}

/** Стата для следующего куба: выбранная, если её квота не исчерпана, иначе первая с остатком. */
export function nextStat(target: StatCounts, assigned: ReadonlyMap<number, Stat>, brush: Stat): Stat | null {
  const used = usedCounts(assigned);
  if (used[brush] < target[brush]) return brush;
  return STATS.find((s) => used[s] < target[s]) ?? null;
}

/**
 * Куб ставится выбранным вручную цветом — квоты подстраиваются: если у статы кисти квота
 * исчерпана, +1 ей, а взамен — из нераспределённых, иначе у статы с наибольшим запасом
 * (квота больше уже поставленного). null — забрать не у кого.
 */
export function countsAfterPaint(target: StatCounts, assigned: ReadonlyMap<number, Stat>, brush: Stat, total: number): StatCounts | null {
  const used = usedCounts(assigned);
  if (used[brush] < target[brush]) return target;
  const out = { ...target, [brush]: target[brush] + 1 };
  if (totalCount(target) < total) return out;
  let donor: Stat | null = null;
  let best = 0;
  for (const st of STATS) {
    if (st === brush) continue;
    const spare = target[st] - used[st];
    if (spare > best) [donor, best] = [st, spare];
  }
  if (!donor) return null;
  out[donor] -= 1;
  return out;
}

/** Перекрасить поставленный куб: одна единица квоты переходит от старой статы к новой. */
export function countsAfterRepaint(target: StatCounts, from: Stat, to: Stat): StatCounts {
  if (from === to) return target;
  return { ...target, [from]: target[from] - 1, [to]: target[to] + 1 };
}
