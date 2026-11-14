// Рейтинг игрока — Эло: победа над сильным даёт больше, поражение от слабого отнимает больше.
// Изменение симметрично: сколько получил один, столько потерял другой.
export const RATING_START = 1000;
export const RATING_K = 32;

/** Ожидаемая доля побед игрока с рейтингом mine против theirs. */
export const expectedScore = (mine: number, theirs: number) => 1 / (1 + Math.pow(10, (theirs - mine) / 400));

/** Изменение рейтинга за бой: win — сколько получит за победу (≥ 1), lose — сколько потеряет при поражении (≥ 1, со знаком минус). */
export function ratingDeltas(mine: number, theirs: number): { win: number; lose: number } {
  const e = expectedScore(mine, theirs);
  return { win: Math.max(1, Math.round(RATING_K * (1 - e))), lose: -Math.max(1, Math.round(RATING_K * e)) };
}

export const ratingAfter = (rating: number, delta: number) => Math.max(0, rating + delta);
