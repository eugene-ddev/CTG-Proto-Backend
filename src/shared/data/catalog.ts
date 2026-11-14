import blueprintsJson from './config/blueprints.json';
import itemsJson from './config/items.json';
import effectsJson from './config/effects.json';
import startJson from './config/start.json';
import opponentsJson from './config/opponents.json';
import resourcesJson from './config/resources.json';
import combatJson from './config/combat.json';
import arenaJson from './config/arena.json';
import type { BlockGeometry, Blueprint, BlueprintKind, EffectDef, EffectId, Item, ItemBlueprint, ItemModel, OpponentsConfig, StartConfig, CombatConfig, ArenaConfig, WeaponPerk } from './types';

// Конфиги генерирует tools/build-config.py из выгрузки Unity.
export const BLUEPRINTS = blueprintsJson as Blueprint[];
// ресурсы (кубы, осколки, точильный камень, пергамент) — свой конфиг, build-config.py его не трогает
export const ITEMS = [...(itemsJson as Item[]), ...(resourcesJson as Item[])];
export const EFFECTS = effectsJson as Record<EffectId, EffectDef>;
export const START = startJson as StartConfig;
/** Генерация ботов арены — правится руками, build-config.py её не трогает. */
export const OPPONENTS = opponentsJson as OpponentsConfig;
/** Настройки боя — правятся руками. */
export const COMBAT = combatJson as CombatConfig;
/** Серия арены: длина и награда за прохождение — правится руками. */
export const ARENA = arenaJson as ArenaConfig;

const blueprintById = new Map(BLUEPRINTS.map((b) => [b.id, b]));
const itemById = new Map(ITEMS.map((i) => [i.id, i]));

export function getBlueprint(id: string): Blueprint {
  const bp = blueprintById.get(id);
  if (!bp) throw new Error(`Нет чертежа ${id}`);
  return bp;
}

export function getItem(id: string): Item {
  const item = itemById.get(id);
  if (!item) throw new Error(`Нет предмета ${id}`);
  return item;
}

export const hasItem = (id: string) => itemById.has(id);

/** Сколько штук предмета лежит в одной стопке (снаряжение — по одному). */
export function maxStackOf(itemOrId: Item | string): number {
  const it = typeof itemOrId === 'string' ? (itemById.get(itemOrId) ?? null) : itemOrId;
  return it && 'maxStack' in it ? it.maxStack : 1;
}
export const hasBlueprint = (id: string) => blueprintById.has(id);

/** Стоимость крафта — число блоков в чертеже. */
export const blueprintCost = (bp: Blueprint) => bp.blocks.length;

export const BLUEPRINT_KIND_LABEL: Record<BlueprintKind, string> = {
  character: 'Персонажи',
  weapon: 'Оружие',
  gem: 'Камни',
  artifact: 'Артефакты',
  bag: 'Сумки',
  potion: 'Зелья',
};

/** Свойства уровня оружия (этап 8): ур. 1 — ничего, ур. 2–3 — из combat.json → weaponLevels.perks. */
export function weaponPerk(item: { id: string; itemLevel: number } | null | undefined): WeaponPerk {
  if (!item) return {};
  const lvl = Math.min(item.itemLevel, COMBAT.weaponLevels.max);
  return lvl >= 2 ? COMBAT.weaponLevels.perks[item.id]?.[lvl - 2] ?? {} : {};
}

/** Удар оружия с учётом свойства уровня: сколько ударов за ход и множитель урона одного удара (кинжал ур. 2–3: три удара слабее). */
export function weaponStrike(item: { id: string; itemLevel: number; ability: { hits?: number } }): { hits: number; multiplier: number } {
  const perk = weaponPerk(item);
  return { hits: Math.max(1, perk.hits ?? item.ability.hits ?? 1), multiplier: perk.damageMultiplier ?? 1 };
}

/** Предмет вне ротации (combat.json → outOfRotation): ботам не выдаётся, чертёж скрыт. */
export const outOfRotation = (itemId: string | undefined) => !!itemId && (COMBAT.outOfRotation ?? []).includes(itemId);
const bpItems = (b: Blueprint) => ('variants' in b ? b.variants.map((v) => v.itemId) : 'itemId' in b ? [b.itemId] : []);
/** Чертёж в ротации: хотя бы один его предмет не выведен. */
export const inRotation = (b: Blueprint) => { const ids = bpItems(b); return !(COMBAT.hiddenBlueprints ?? []).includes(b.id) && (!ids.length || ids.some((id) => !outOfRotation(id))); };
/** Чертежи в ротации — для списка «Чертежи». */
export const ROTATION_BLUEPRINTS = () => BLUEPRINTS.filter(inRotation);
export const blueprintsByKind = (kind: BlueprintKind) => BLUEPRINTS.filter((b) => b.kind === kind && inRotation(b));

/** Модель предмета (блоки его чертежа) — для показа в слоте персонажа. */
const modelByItem = new Map<string, ItemModel>(
  BLUEPRINTS.filter((b): b is ItemBlueprint => b.kind === 'weapon' || b.kind === 'artifact' || b.kind === 'bag').map((b) => [
    b.itemId,
    { blocks: b.blocks, scale: b.modelScale ?? 1, kind: b.kind },
  ]),
);
/** Модели уровней 2 и 3 по предмету. */
const levelBlocksByItem = new Map<string, BlockGeometry[][]>(
  BLUEPRINTS.filter((b): b is ItemBlueprint => b.kind === 'weapon' && 'levelBlocks' in b && !!b.levelBlocks).map((b) => [b.itemId, b.levelBlocks!]),
);
const leveledModels = new Map<string, ItemModel>();
/** Модель предмета; у оружия — своя на каждом уровне (обычное, улучшенное, сияющее). */
export function itemModel(itemId: string | undefined | null, level = 1): ItemModel | null {
  const base = itemId ? modelByItem.get(itemId) ?? null : null;
  if (!base || !itemId || base.kind !== 'weapon' || level <= 1) return base;
  const key = `${itemId}:${Math.min(level, 3)}`;
  let model = leveledModels.get(key);
  if (!model) leveledModels.set(key, (model = { ...base, blocks: levelBlocksByItem.get(itemId)?.[Math.min(level, 3) - 2] ?? base.blocks }));
  return model;
}
