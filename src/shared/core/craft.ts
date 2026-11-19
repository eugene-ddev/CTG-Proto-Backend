// Крафт и разборка. Чистые функции над PlayerState.
import { getBlueprint, inRotation } from '../data/catalog';
import type { Blueprint, Stat } from '../data/types';
import { PARCHMENT_ID, addCubes, addItem, cubeCount, newCharacterPotions, removeItem, spendCubes, takeItems, type CharacterState, type PlayerState } from './state';
import { returnGems } from './upgrade';

export const craftCost = (bp: Blueprint) => bp.blocks.length;

/** Разборка возвращает половину кубов, с округлением вниз. */
export const disassemblyRefund = (blocks: number) => Math.floor(blocks / 2);

export type CraftResult = { kind: 'character'; blueprintId: string; charUid?: string } | { kind: 'item'; itemId: string };

/** Что получится из чертежа. У зелий и камней нужен выбранный вариант. */
export function craftResult(bp: Blueprint, variantKey?: string): CraftResult | null {
  if (bp.kind === 'character') return { kind: 'character', blueprintId: bp.id };
  if ('variants' in bp) {
    const v = bp.variants.find((x) => x.key === variantKey);
    return v ? { kind: 'item', itemId: v.itemId } : null;
  }
  return { kind: 'item', itemId: bp.itemId };
}

/** Автосборка открывается после первой ручной сборки этого чертежа. */
export const canAutoCraft = (s: PlayerState, blueprintId: string) => s.manuallyCrafted.includes(blueprintId);

export interface CompleteCraftOpts {
  variantKey?: string;
  /** true — собрано вручную: открывает автосборку. */
  manual: boolean;
  /** Сколько штук кладётся в стопку. */
  maxStack: (itemId: string) => number;
  /** У персонажа: стата каждого блока по индексу в чертеже. */
  blockStats?: Stat[];
}

/**
 * Завершить крафт: списать кубы целиком и выдать результат. Пока сборка не закончена,
 * кубы не тратятся — выход из сцены посередине ничего не стоит.
 * null — не хватает кубов, чертёж закрыт или не выбран вариант.
 */
/** Есть ли блок без статы (undefined или дыра в массиве — some() дыры пропускает). */
const hasGap = (stats: readonly (string | undefined)[]) => {
  for (let i = 0; i < stats.length; i++) if (!stats[i]) return true;
  return false;
};

/** Почему completeCraft вернёт null — текст для игрока; null, если собрать можно. */
export function craftFailure(s: PlayerState, bp: Blueprint, opts: CompleteCraftOpts): string | null {
  if (!inRotation(bp)) return 'Этот чертёж недоступен для сборки.';
  if (!s.unlockedBlueprints.includes(bp.id)) return 'Чертёж не открыт.';
  const result = craftResult(bp, opts.variantKey);
  if (!result) return 'Не выбран вариант (стата или стихия).';
  if (!opts.manual && !canAutoCraft(s, bp.id)) return 'Автосборка откроется после первой ручной сборки.';
  if (cubeCount(s) < craftCost(bp)) return `Не хватает ${craftCost(bp) - cubeCount(s)} куб.`;
  if (result.kind === 'character' && (!opts.blockStats || opts.blockStats.length !== bp.blocks.length || hasGap(opts.blockStats)))
    return 'Не у всех кубов назначена стата.';
  return null;
}

export function completeCraft(s: PlayerState, bp: Blueprint, opts: CompleteCraftOpts): { state: PlayerState; result: CraftResult } | null {
  if (!inRotation(bp) || !s.unlockedBlueprints.includes(bp.id)) return null;
  const result = craftResult(bp, opts.variantKey);
  if (!result) return null;
  if (!opts.manual && !canAutoCraft(s, bp.id)) return null;
  let next = spendCubes(s, craftCost(bp));
  if (!next) return null;
  let out: CraftResult = result;
  if (result.kind === 'character') {
    const stats = opts.blockStats;
    if (!stats || stats.length !== bp.blocks.length || hasGap(stats)) return null; // статы назначаются при крафте персонажа
    const uid = `c${next.nextUid}`;
    const character: CharacterState = {
      uid,
      name: defaultCharacterName(next, bp),
      blueprintId: bp.id,
      blockStats: [...stats],
      brokenBlocks: [],
      equipment: bp.kind === 'character' ? bp.slots.map(() => null) : [],
      rucksackLevel: 1,
      potions: newCharacterPotions(),
      bag: [],
    };
    next = { ...next, characters: [...next.characters, character], nextUid: next.nextUid + 1 };
    out = { ...result, charUid: uid };
  } else {
    next = addItem(next, result.itemId, 1, opts.maxStack(result.itemId));
  }
  if (opts.manual && !next.manuallyCrafted.includes(bp.id)) next = { ...next, manuallyCrafted: [...next.manuallyCrafted, bp.id] };
  return { state: next, result: out };
}

/** Разобрать одну штуку из записи инвентаря: половина кубов её чертежа. */
export function disassembleItem(s: PlayerState, entryUid: string, blueprintOf: (itemId: string) => Blueprint | undefined): PlayerState | null {
  const entry = s.inventory.find((e) => e.uid === entryUid);
  if (!entry) return null;
  const bp = blueprintOf(entry.itemId);
  if (!bp) return null;
  // вставленные камни при разборке возвращаются в инвентарь
  const next = returnGems(removeItem(s, entryUid, 1), entry.gems);
  return addCubes(next, disassemblyRefund(craftCost(bp)));
}

/** Сколько кубов вернёт разборка записей целиком (стопки — все штуки); без чертежа — 0. */
export function disassemblyRefundOf(s: PlayerState, entryUids: Iterable<string>, blueprintOf: (itemId: string) => Blueprint | undefined): number {
  const ids = new Set(entryUids);
  return s.inventory.reduce((sum, e) => {
    const bp = ids.has(e.uid) ? blueprintOf(e.itemId) : undefined;
    return bp ? sum + disassemblyRefund(craftCost(bp)) * e.count : sum;
  }, 0);
}

/** Разобрать несколько записей инвентаря целиком (стопки — все штуки). Без чертежа — пропускаются. null — разбирать нечего. */
export function disassembleMany(s: PlayerState, entryUids: Iterable<string>, blueprintOf: (itemId: string) => Blueprint | undefined): PlayerState | null {
  const ids = new Set([...entryUids].filter((uid) => {
    const e = s.inventory.find((x) => x.uid === uid);
    return !!e && !!blueprintOf(e.itemId);
  }));
  if (!ids.size) return null;
  const refund = disassemblyRefundOf(s, ids, blueprintOf);
  let next: PlayerState = { ...s, inventory: s.inventory.filter((e) => !ids.has(e.uid)) };
  for (const e of s.inventory) if (ids.has(e.uid)) next = returnGems(next, e.gems);
  return addCubes(next, refund);
}

/** Чистых пергаментов за открытие одного чертежа. */
export const UNLOCK_COST = 1;

export const isUnlocked = (s: PlayerState, blueprintId: string) => s.unlockedBlueprints.includes(blueprintId);

/** Открыть чертёж за чистый пергамент. null — уже открыт или пергамента не хватает. */
export function unlockBlueprint(s: PlayerState, blueprintId: string): PlayerState | null {
  if (!inRotation(getBlueprint(blueprintId)) || isUnlocked(s, blueprintId)) return null;
  const paid = takeItems(s, PARCHMENT_ID, UNLOCK_COST);
  return paid ? { ...paid, unlockedBlueprints: [...paid.unlockedBlueprints, blueprintId] } : null;
}

/** Имя по умолчанию: «Лобстер 1», «Лобстер 2»… — первое свободное. */
export function defaultCharacterName(s: PlayerState, bp: Blueprint): string {
  const taken = new Set(s.characters.map((c) => c.name));
  for (let n = 1; ; n++) if (!taken.has(`${bp.name} ${n}`)) return `${bp.name} ${n}`;
}
