import { getBlueprint, getItem, hasItem } from '../data/catalog';
import type { CharacterBlueprint, Item } from '../data/types';
import type { PlayerState } from './state';
import { bagAccepts, bagSlots, characterStats, equip, putInBag, requirementGap, slotAccepts, slotLabel, type SlotRef } from './character';

/**
 * Контекст сборки: пришли в «Чертежи» из ячейки бойца («+» → «К чертежам»).
 * После крафта подходящий предмет можно сразу надеть / положить в эту ячейку.
 */
export type CraftTarget = { charUid: string; slot: SlotRef } | { charUid: string; bagCell: number };

const charOf = (s: PlayerState, uid: string) => s.characters.find((c) => c.uid === uid);

/** «Имя · Правая рука» / «Имя · рюкзак, ячейка 2». null — бойца уже нет. */
export function targetLabel(s: PlayerState, t: CraftTarget): string | null {
  const c = charOf(s, t.charUid);
  if (!c) return null;
  if ('bagCell' in t) return `${c.name} · рюкзак, ячейка ${t.bagCell + 1}`;
  return `${c.name} · ${slotLabel(getBlueprint(c.blueprintId) as CharacterBlueprint, t.slot)}`;
}

/** Подходит ли предмет в ячейку: 'ok', причина отказа, или null — не для этой ячейки вовсе. */
export function targetFit(s: PlayerState, t: CraftTarget, item: Item): 'ok' | string | null {
  const c = charOf(s, t.charUid);
  if (!c) return null;
  if ('bagCell' in t) return bagAccepts(item) && t.bagCell < bagSlots(c).length ? 'ok' : null;
  const bp = getBlueprint(c.blueprintId) as CharacterBlueprint;
  if (!slotAccepts(bp, t.slot, item)) return null;
  return requirementGap(item, characterStats(bp, c.blockStats)) > 0 ? 'Не хватает статов, чтобы надеть' : 'ok';
}

/** Надеть / положить скрафченный предмет из инвентаря в ячейку цели (бо́льшая стопка). */
export function applyTarget(s: PlayerState, t: CraftTarget, itemId: string): PlayerState | null {
  if (!hasItem(itemId)) return null;
  const e = s.inventory.filter((x) => x.itemId === itemId).sort((a, b) => b.count - a.count)[0];
  if (!e || targetFit(s, t, getItem(itemId)) !== 'ok') return null;
  return 'bagCell' in t ? putInBag(s, t.charUid, t.bagCell, e.uid) : equip(s, t.charUid, t.slot, e.uid);
}
