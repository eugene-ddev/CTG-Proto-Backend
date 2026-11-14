// Детерминированный генератор случайных чисел: один seed — один исход боя.
// mulberry32 — быстрый и достаточный для игровой логики.

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Целое в [min, max] включительно. */
  int(min: number, max: number): number;
  /** Вещественное в [min, max]. */
  range(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Текущее внутреннее состояние — чтобы продолжить тот же поток. */
  readonly state: number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    get state() {
      return a;
    },
  };
}

/** Новый seed из текущего времени — для «другой противник» и нового боя. */
export const randomSeed = () => (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
