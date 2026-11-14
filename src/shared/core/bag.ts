// Марбл-бэг — вместо чистого рандома везде, где есть шанс (battle-rework, этап 1).
// В мешке size шариков, выигрышных — chance·size. Тянем без возврата; пустой мешок наполняется заново
// по текущему шансу. Дробная часть chance·size переносится в следующий мешок, поэтому в долгую шанс точный:
// 10% → ровно 1 из каждых 10 попыток; 13.7% → 1, 1, 2, 1, … выигрышных на мешок из 10.
// Стартовый перенос — от seed-а: иначе шанс меньше 1/size в первом мешке давал бы 0 срабатываний
// (крит 8% в коротком бою не выпадал бы никогда); с ним 8% дают крит в первом мешке в 8 случаях из 10.
// Порядок шариков — от seed-а (Rng), поэтому один seed даёт один исход.
import type { Rng } from './rng';

export interface MarbleBag {
  /** Шариков в полном мешке. */
  size: number;
  /** Оставшиеся шарики: true — срабатывание. Тянется с конца. */
  marbles: boolean[];
  /** Перенос дробной части выигрышных шариков в следующий мешок, [0, 1); null — ещё не наполнялся. */
  carry: number | null;
}

export function createBag(size = 10): MarbleBag {
  return { size: Math.max(1, Math.floor(size)), marbles: [], carry: null };
}

/** Наполнить мешок под шанс chance. */
export function refillBag(bag: MarbleBag, chance: number, rng: Rng): void {
  const carry = bag.carry ?? rng.next();
  const exact = Math.min(1, Math.max(0, chance)) * bag.size + carry;
  const hits = Math.min(bag.size, Math.floor(exact + 1e-9));
  bag.carry = Math.min(0.999999, Math.max(0, exact - hits));
  bag.marbles = rng.shuffle(Array.from({ length: bag.size }, (_, i) => i < hits));
}

/**
 * Попытка с шансом chance. Шанс 0 — всегда мимо (мешок не трогается), 1 — всегда срабатывает.
 * Шанс, изменившийся посреди мешка, действует со следующего наполнения.
 */
export function drawBag(bag: MarbleBag, chance: number, rng: Rng): boolean {
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  if (!bag.marbles.length) refillBag(bag, chance, rng);
  return bag.marbles.pop()!;
}

// ───────────── мешки вне боя (этап 6) ─────────────
// Выбор из вариантов — тот же марбл-бэг, только шарики — id вариантов: каждый вариант лежит в мешке
// пропорционально весу (без весов — по одному), тянется без возврата. 90/10 → из 10 бросков ровно 1 редкий;
// выбор без весов — без повторов, пока не выпадут все. Мешки живут в сейве (PlayerState.bags) между боями и сериями.

/** Колода вариантов: оставшиеся шарики-id, тянутся с конца. */
export interface DeckBag {
  deck: string[];
}

/** Мешки игрока по ключам («reward.drop», «bot.main», …) — в сейве. */
export type Bags = Record<string, MarbleBag | DeckBag>;

/** Источник случайности для генерации: шанс и выбор варианта по ключу мешка. */
export interface DrawSource {
  chance(key: string, p: number): boolean;
  /** Вариант из options; idOf — стабильный id варианта (для мешка и записи); weights — веса (по умолчанию равные). */
  pick<T>(key: string, options: readonly T[], idOf?: (o: T) => string, weights?: readonly number[]): T;
}

/** Запись бросков: true/false — шанс, строка — id выбранного варианта. Повтор даёт того же бота. */
export type DrawLog = Array<boolean | string>;

const defaultId = (o: unknown) => String(o);

/** Шарики колоды: каждый вариант × max(1, round(вес / сумма × size)), без весов — по одному. */
function deckOf(ids: string[], weights: readonly number[] | undefined, size: number): string[] {
  if (!weights) return [...ids];
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0) || 1;
  return ids.flatMap((id, i) => (weights[i] > 0 ? Array<string>(Math.max(1, Math.round((weights[i] / total) * size))).fill(id) : []));
}

/**
 * Броски из мешков bags (мешки меняются на месте — вызывающий сохраняет их в состояние).
 * log — куда записать броски, чтобы потом повторить их replayDraws.
 */
export function bagDraws(bags: Bags, rng: Rng, size = 10, log?: DrawLog): DrawSource {
  return {
    chance(key, p) {
      let bag = bags[key] as MarbleBag | undefined;
      if (!bag || !('marbles' in bag)) bag = bags[key] = createBag(size);
      const r = drawBag(bag, p, rng);
      log?.push(r);
      return r;
    },
    pick(key, options, idOf = defaultId, weights) {
      if (!options.length) throw new Error(`pick: пусто (${key})`);
      const ids = options.map(idOf);
      const live = ids.filter((_, i) => !weights || weights[i] > 0);
      let bag = bags[key] as DeckBag | undefined;
      if (!bag || !('deck' in bag)) bag = bags[key] = { deck: [] };
      // шарик варианта, которого сейчас нет (конфиг поменялся или вариант недоступен), — выбрасывается
      for (let guard = 0; guard < 1000; guard++) {
        if (!bag.deck.length) bag.deck = rng.shuffle(deckOf(ids, weights, size));
        const id = bag.deck.pop()!;
        if (live.includes(id)) {
          log?.push(id);
          return options[ids.indexOf(id)];
        }
      }
      throw new Error(`pick: не удалось вытянуть (${key})`);
    },
  };
}

/** Повтор записанных бросков по порядку; запись кончилась или не подходит — дальше из fallback. */
export function replayDraws(log: DrawLog, fallback: DrawSource): DrawSource {
  let k = 0;
  return {
    chance(key, p) {
      const v = log[k];
      if (typeof v === 'boolean') {
        k++;
        return v;
      }
      k = log.length;
      return fallback.chance(key, p);
    },
    pick(key, options, idOf = defaultId, weights) {
      const v = log[k];
      const i = typeof v === 'string' ? options.map(idOf).indexOf(v) : -1;
      if (i >= 0) {
        k++;
        return options[i];
      }
      k = log.length;
      return fallback.pick(key, options, idOf, weights);
    },
  };
}

/** Броски чистым seed-рандомом без мешков — для тестов и запасной ветки старых сейвов. */
export function rngDraws(rng: Rng): DrawSource {
  return {
    chance: (_key, p) => rng.next() < p,
    pick(_key, options, _idOf, weights) {
      if (!weights) return rng.pick(options);
      const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
      let r = rng.next() * total;
      for (let i = 0; i < options.length; i++) if ((r -= Math.max(0, weights[i])) < 0) return options[i];
      return options[options.length - 1];
    },
  };
}

/** Целое из [min, max] через pick — тоже мешок: каждое значение по разу за круг. */
export const drawInt = (d: DrawSource, key: string, min: number, max: number) =>
  d.pick(key, Array.from({ length: Math.max(0, max - min) + 1 }, (_, i) => min + i));
