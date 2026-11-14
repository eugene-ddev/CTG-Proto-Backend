// Раскладка стат по кубам слоями спереди назад (battle-rework, этап 5).
// Перёд модели — +Z (смотрит на противника), бьют только передний живой куб столбика (раскопка, этап 3),
// поэтому «слой» — глубина куба в своём столбике (x, y): 0 — передний, 1 — за ним и т.д.
// Автосборка и боты кладут статы по списку слоёв: первая стата — на самые передние кубы, последняя — в глубину.
import { STATS, type Stat, type Vec3 } from '../data/types';

/** Глубина каждого куба в его столбике вдоль +Z: 0 — передний. */
export function columnDepths(blocks: ReadonlyArray<{ pos: Vec3 }>): number[] {
  const cols = new Map<string, number[]>();
  blocks.forEach((b, i) => {
    const k = `${Math.round(b.pos[0])},${Math.round(b.pos[1])}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k)!.push(i);
  });
  const depth: number[] = [];
  for (const idx of cols.values()) idx.sort((a, b) => blocks[b].pos[2] - blocks[a].pos[2]).forEach((i, d) => (depth[i] = d));
  return depth;
}

/** Порядок кубов спереди назад: глубина в столбике, потом z (дальше вперёд — раньше), потом центр по X, верх, индекс. */
export function frontToBack(blocks: ReadonlyArray<{ pos: Vec3 }>, only: (i: number) => boolean = () => true): number[] {
  const depth = columnDepths(blocks);
  return blocks
    .map((_, i) => i)
    .filter(only)
    .sort((a, b) => {
      const pa = blocks[a].pos, pb = blocks[b].pos;
      return depth[a] - depth[b] || pb[2] - pa[2] || Math.abs(pa[0]) - Math.abs(pb[0]) || pb[1] - pa[1] || a - b;
    });
}

/**
 * Разложить counts по кубам слоями: статы из order — спереди назад, остальные статы — после них в порядке STATS.
 * only — какие кубы раскладывать (автосборка — ещё не поставленные). Кубов больше, чем counts, — лишние не получают статы.
 */
export function layeredStats(blocks: ReadonlyArray<{ pos: Vec3 }>, counts: Partial<Record<Stat, number>>, order: readonly Stat[], only?: (i: number) => boolean): Map<number, Stat> {
  const seq = [...order.filter((s) => STATS.includes(s)), ...STATS.filter((s) => !order.includes(s))];
  const queue = frontToBack(blocks, only);
  const out = new Map<number, Stat>();
  let k = 0;
  for (const s of seq) for (let n = 0; n < (counts[s] ?? 0) && k < queue.length; n++) out.set(queue[k++], s);
  return out;
}
