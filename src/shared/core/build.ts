// Порядок сборки: начинаем с одного куба, дальше слоями снизу вверх — доступны только блоки
// нижнего недостроенного слоя, примыкающие к уже поставленным. Так не бывает «висящих» блоков, до которых не дотянуться.
import type { BlockGeometry } from '../data/types';

const dist = (a: BlockGeometry, b: BlockGeometry) =>
  Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);

/** Соседи по граням: центры на расстоянии одного блока (с учётом масштаба, у ножа 0.55). */
export function adjacency(blocks: BlockGeometry[]): number[][] {
  return blocks.map((a, i) =>
    blocks.flatMap((b, j) => {
      if (i === j) return [];
      const step = Math.max(a.scale ?? 1, b.scale ?? 1);
      return dist(a, b) <= step * 1.05 ? [j] : [];
    }),
  );
}

const AXES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Соседи блока по 6 направлениям (индекс или -1, если клетка пуста). */
export function faceNeighbours(blocks: BlockGeometry[], i: number, adj = adjacency(blocks)): number[] {
  const a = blocks[i];
  const step = a.scale ?? 1;
  return AXES.map(([x, y, z]) => {
    const j = adj[i].find((k) => {
      const b = blocks[k].pos;
      return Math.abs(b[0] - a.pos[0] - x * step) < 0.05 && Math.abs(b[1] - a.pos[1] - y * step) < 0.05 && Math.abs(b[2] - a.pos[2] - z * step) < 0.05;
    });
    return j ?? -1;
  });
}

/** Первый куб: самый нижний, при равенстве — ближе всех к оси модели. */
export function seedBlock(blocks: BlockGeometry[]): number {
  let best = 0;
  blocks.forEach((b, i) => {
    const c = blocks[best];
    const by = b.pos[1] - c.pos[1];
    if (by < -1e-6 || (Math.abs(by) < 1e-6 && Math.hypot(b.pos[0], b.pos[2]) < Math.hypot(c.pos[0], c.pos[2]))) best = i;
  });
  return best;
}

const LAYER_EPS = 0.01;

/**
 * Блоки, которые можно поставить сейчас. Ничего не поставлено — только первый куб.
 * Сборка идёт слоями снизу вверх: доступен самый нижний недостроенный слой, и в нём —
 * блоки, примыкающие к уже поставленным. Выше слоя ничего не стоит, поэтому верх у каждого
 * доступного блока открыт и его видно камерой сверху — ни один куб не окажется замурован
 * (центр камня, блок под панцирем лобстера).
 * Если в слое нет блоков рядом с собранным (слой распался на части), доступен ближайший.
 */
export function frontier(blocks: BlockGeometry[], placed: ReadonlySet<number>, adj = adjacency(blocks)): number[] {
  if (placed.size === 0) return blocks.length ? [seedBlock(blocks)] : [];
  if (placed.size === blocks.length) return [];
  let yMin = Infinity;
  blocks.forEach((b, j) => {
    if (!placed.has(j)) yMin = Math.min(yMin, b.pos[1]);
  });
  const layer = blocks.map((_, j) => j).filter((j) => !placed.has(j) && blocks[j].pos[1] <= yMin + LAYER_EPS);
  const near = layer.filter((j) => adj[j].some((k) => placed.has(k)));
  if (near.length) return near;
  // мост к оторванной части слоя: ближайший к собранному блок слоя
  let best = -1;
  let bestD = Infinity;
  for (const j of layer) {
    for (const i of placed) {
      const d = dist(blocks[i], blocks[j]);
      if (d < bestD) [best, bestD] = [j, d];
    }
  }
  return best >= 0 ? [best] : [];
}

/** Полный порядок сборки (для автосборки): обход в ширину от уже поставленных, снизу вверх. */
export function buildOrder(blocks: BlockGeometry[], placed: ReadonlySet<number> = new Set()): number[] {
  const adj = adjacency(blocks);
  const done = new Set(placed);
  const order: number[] = [];
  while (done.size < blocks.length) {
    const next = frontier(blocks, done, adj).sort((a, b) => blocks[a].pos[1] - blocks[b].pos[1]);
    if (!next.length) break;
    for (const i of next) {
      done.add(i);
      order.push(i);
    }
  }
  return order;
}
