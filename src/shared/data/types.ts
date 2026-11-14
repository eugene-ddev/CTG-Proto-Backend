// Типы данных прототипа. Имена и значения enum — как в C#-моделях клиента
// (Core/Service/Network/Models), чтобы конфиги и формулы переносились один в один.

/** CharacterBlockType: стата блока персонажа. */
export const STATS = ['Armor', 'Strength', 'Dexterity', 'Intelligence', 'Stamina', 'Luck'] as const;
export type Stat = (typeof STATS)[number];

/** EquipmentSlotType */
export type SlotType = 'Hand' | 'Artifact' | 'Pouch' | 'Rucksack';

/** AbilityType */
export type AbilityType = 'Attack' | 'ProjectileAttack' | 'ApplyEffect';

/** BlockShape */
export type BlockShape = 'cube' | 'triangle';

export type Vec3 = [x: number, y: number, z: number];

/** BlockGeometry: позиция в сетке и поворот (эйлеры Unity, градусы, порядок ZXY). */
export interface BlockGeometry {
  shape: BlockShape;
  pos: Vec3;
  rot: Vec3;
  /**
   * Поворот кватернионом [x, y, z, w] — точнее эйлеров (у предметов из префабов при X = ±90°
   * эйлеры неоднозначны). Если задан, рендер берёт его, а не rot.
   */
  quat?: [number, number, number, number];
  /** Цвет у предметов задаёт чертёж (дерево, металл, камень); у персонажа — стата при сборке. */
  color?: string;
  /** Цвет задаёт выбранный вариант (жидкость зелья — цвет статы). */
  tinted?: boolean;
  /** Непрозрачность 0..1 — стекло флаконов 0.7. Прозрачный блок не закрывает грани соседей. */
  opacity?: number;
  /** Равномерный масштаб, если блок меньше единичного (нож). */
  scale?: number;
}

export type BlueprintKind = 'character' | 'weapon' | 'gem' | 'artifact' | 'bag' | 'potion';

interface BlueprintBase {
  id: string;
  kind: BlueprintKind;
  name: string;
  blocks: BlockGeometry[];
}

export interface CharacterBlueprintSlot {
  type: SlotType;
  pos: Vec3;
  isLeftHand: boolean;
  /** Масштаб предмета в слоте относительно персонажа (в чертежах клиента 0.8). */
  scale?: number;
}

/** BlueprintTemplateModel */
export interface CharacterBlueprint extends BlueprintBase {
  kind: 'character';
  /** CharacterCategory, 1–9: категория N ≈ 10·(N+1) кубов. */
  category: number;
  /** Очков стат на весь чертёж (бэкенд): очков за куб = statsPoints / кубов. */
  statsPoints: number;
  baseStats: Record<Stat, number>;
  slots: CharacterBlueprintSlot[];
}

export interface ItemBlueprint extends BlueprintBase {
  kind: 'weapon' | 'artifact' | 'bag';
  itemId: string;
  /** Масштаб корня префаба предмета (щит — 0.5). */
  modelScale?: number;
  /** Модели оружия на ур. 2 и 3 (улучшенное, сияющее); blocks — ур. 1. Собираются в tools/models.py. */
  levelBlocks?: BlockGeometry[][];
}

/** Модель предмета для показа в слоте персонажа. */
export interface ItemModel {
  blocks: BlockGeometry[];
  scale: number;
  kind: 'weapon' | 'artifact' | 'bag';
}

export interface BlueprintVariant {
  key: string;
  label: string;
  itemId: string;
  /** Цвет перекрашиваемых (tinted) блоков. */
  tint: string;
}

/**
 * Чертёж с выбором варианта при крафте: флакон зелья (стата) или камень (стихия).
 * Каждый вариант — свой предмет. Позже выбор может потребовать отдельный ресурс цвета.
 */
export interface VariantBlueprint extends BlueprintBase {
  kind: 'potion' | 'gem';
  /** Что выбирается: «Стата», «Стихия». */
  variantLabel: string;
  variants: BlueprintVariant[];
  /** У флаконов: сколько кубов чинит. */
  restoreAmount?: number;
}

export type Blueprint = CharacterBlueprint | ItemBlueprint | VariantBlueprint;

/** AbilityBaseModel. Кулдаун — в своих ходах. */
export interface Ability {
  type: AbilityType;
  cooldown: number;
  staminaCost: number;
  manaCost: number;
  range: number;
  /** Урон удара на 1-м уровне, без разброса (до скейлинга статой и уровнем). */
  damage: number;
  /** Ударов за одно использование (кинжал — 2); стамина и кулдаун — один раз. По умолчанию 1. */
  hits?: number;
  effects: EffectId[];
}

export type EffectId = 'burn' | 'poison' | 'freeze' | 'shield';

interface ItemBase {
  id: string;
  name: string;
  description: string;
  /** Чертёж, по которому предмет крафтится. */
  blueprintId?: string;
}

/** WeaponModel / ArtifactModel */
/**
 * Схема удара — куда идёт урон сверх прочности куба (battle-rework, этап 4):
 * carry — в следующий куб раскопки (кулак и оружие без схемы); precise — никуда, часть брони игнорируется;
 * cleave — передние кубы соседних столбиков по ряду (±X); pierce — вглубь столбика, до depth кубов;
 * split — куб за целью и передний куб соседнего столбика; crush — крест на передней грани и куб за целью.
 */
export type WeaponPattern = 'carry' | 'precise' | 'cleave' | 'pierce' | 'split' | 'crush';

/**
 * Свойства уровня оружия (этап 8) — поверх схемы удара; ур. 3 содержит и свойства ур. 2.
 * armorIgnore — доля брони, которая не действует (1 — вся); critMultiplier — множитель крита;
 * depth — сколько клеток позади цели достаёт остаток (точный — «пробивает вперёд», колющий — дальность);
 * sidesY — рубящий бьёт ещё соседей сверху и снизу; bothSides — раскалывающий бьёт вбок в обе стороны;
 * behind — клеток позади (рубящий, раскалывающий, дробящий);
 * diagonals — дробящий бьёт ещё диагонали (3×3); stun — шанс оглушить (марбл-бэг): противник пропускает ход;
 * extraShare — доля урона в клетки от свойств уровня (по умолчанию weaponLevels.extraShare); hits — ударов за ход;
 * damageMultiplier — множитель урона удара.
 */
export interface WeaponPerk {
  armorIgnore?: number;
  critMultiplier?: number;
  depth?: number;
  sidesY?: boolean;
  extraShare?: number;
  hits?: number;
  damageMultiplier?: number;
  bothSides?: boolean;
  behind?: number;
  diagonals?: boolean;
  stun?: number;
}

export interface EquipmentItem extends ItemBase {
  kind: 'weapon' | 'artifact';
  slot: 'Hand' | 'Artifact';
  /** Схема удара (оружие); нет — carry. */
  pattern?: WeaponPattern;
  scalingStat: Stat;
  minStatRequired: number;
  itemLevel: number;
  gemSlots: number;
  /** Камни, вставленные в этот экземпляр (id предметов-камней); их эффекты уже в ability.effects. */
  gems?: string[];
  ability: Ability;
}

/** GemModel */
export interface GemItem extends ItemBase {
  kind: 'gem';
  effects: EffectId[];
  /** Цвет камня (перекрашиваемых блоков чертежа). */
  tint: string;
}

/** Rucksack / Pouch */
export interface BagItem extends ItemBase {
  kind: 'bag';
  slot: 'Rucksack' | 'Pouch';
  capacity: number;
  /** Подсумок сейчас не используется, но остаётся в данных. */
  unused: boolean;
}

/** Зелье восстановления: чинит разбитые блоки своей статы. */
export interface PotionItem extends ItemBase {
  kind: 'potion';
  restoreStat: Stat;
  restoreAmount: number;
  maxStack: number;
  /** Цвет жидкости = цвет куба статы. */
  tint: string;
}

/** Ресурс: кубы, осколки, точильный камень, пергамент — лежат стопками, как зелья. */
export interface ResourceItem extends ItemBase {
  kind: 'resource';
  /** Какой значок рисовать (у ресурсов нет чертежа). */
  icon: 'cube' | 'shard' | 'whetstone' | 'parchment' | 'jeweler';
  tint: string;
  maxStack: number;
}

export type Item = EquipmentItem | GemItem | BagItem | PotionItem | ResourceItem;
export type ItemKind = Item['kind'];

export interface EffectDef {
  kind: 'Burn' | 'Poison' | 'Freeze' | 'Shield';
  name: string;
  damageType?: 'Fire' | 'Poison' | 'Ice';
  duration: number;
  interval?: number;
  damagePerTick?: number;
  spreadChance?: number;
  statMultiplier?: number;
  durabilityMultiplier?: number;
  statDisabled?: boolean;
  maxStacks?: number;
  removes?: EffectId[];
}

export interface StartConfig {
  cubes: number;
  unlockAllBlueprints: boolean;
  /** Чертежи, открытые с начала игры (если не unlockAllBlueprints); остальные открываются пергаментом. */
  blueprints?: string[];
  inventory: Array<{ itemId: string; count: number }>;
}

/** Настройки боя (config/combat.json). */
export interface CombatConfig {
  /** Прочность куба в бою (как в клиенте — 10; остаток урона уходит в следующий куб раскопки). */
  blockDurability: number;
  /** Предметы вне ротации (0.0.73): боты их не получают, чертежей в списке нет; собранные — работают. */
  outOfRotation?: string[];
  /** Чертежи, которых нет в списке «Чертежи» и которые нельзя собрать (камни — только из наград серии). */
  hiddenBlueprints?: string[];
  /** Шариков в марбл-бэге (крит, уворот, распространение горения): шанс 10% → 1 из bagSize. */
  bagSize: number;
  /**
   * Раскладка стат слоями спереди назад (этап 5): autoBuild — автосборка; bots — варианты для ботов
   * (бот берёт один). Статы, которых нет в списке, — в глубину, в порядке STATS.
   */
  layout: { autoBuild: Stat[]; bots: Stat[][] };
  /** Уровни оружия (этап 8): максимум, цена в точильных камнях (до ур. 2, до ур. 3) и свойства уровней по предметам. */
  /** extraShare — какую долю от доли клетки ур. 1 получает клетка, добавленная свойством уровня (0.0.76). */
  weaponLevels: { max: number; cost: number[]; extraShare: number; perks: Record<string, WeaponPerk[]> };
  /** Ячейки камней в оружии: максимум и предмет, который тратится на одну ячейку (ювелирный набор). */
  gemCells: { max: number; itemId: string };
  /** Реген выносливости за ход: regenBase + regenShare × максимум (1 — вся восстанавливается каждый ход, 0.0.70). */
  stamina: { regenBase: number; regenShare: number };
  /** Параметры схем удара. */
  patterns: { precise: { armorIgnore: number }; pierce: { depth: number } };
  /** Пороги стат: разбито больше share кубов статы — её функция отключается до конца боя. */
  statThresholds: StatThresholdConfig;
}

/**
 * Что отключается при пороге: Ловкость — уворот, Удача — крит, Интеллект — артефакты,
 * Выносливость — реген стамины падает до staminaRegen, Сила — урон силового оружия ×strengthWeaponMultiplier.
 */
export interface StatThresholdConfig {
  /** Доля разбитых кубов статы, после которой (строго больше) стата отключается. */
  share: number;
  /** Статы, у которых есть порог. */
  stats: Stat[];
  strengthWeaponMultiplier: number;
  staminaRegen: number;
}

/** Настройки генерации ботов арены (config/opponents.json). */
export interface OpponentsConfig {
  /** Боты с маной (артефакты с manaCost и кубы Интеллекта под них); false — пока артефакты не проработаны. */
  allowMana?: boolean;
  /** Уровень оружия бота = уровень оружия игрока минус 0…это значение (никогда не выше, чем у игрока). */
  weaponLevelSpread: number;
  minWeaponLevel: number;
  maxWeaponLevel: number;
  /** Уровни оружия, на которых открываются слоты камней (1, 2, 3 слота). */
  /** Шанс занять каждый слот артефакта. */
  artifactChance: number;
  /** Маны должно хватать на столько применений самого дорогого артефакта. */
  manaCastsReserve: number;
  /** Доля кубов [min, max]: main — стата оружия (Сила или Ловкость), остальное — по имени статы. */
  statShares: { main: [number, number] } & Partial<Record<Stat, [number, number]>>;
  /** Шанс, что у бота есть рюкзак. */
  rucksackChance: number;
  /** Сколько ячеек рюкзака занято [min, max] (не больше вместимости). */
  bagItems: [number, number];
  /** Шанс, что предмет в рюкзаке — запасное оружие (иначе зелье). */
  spareWeaponChance: number;
  /** Зелий в стопке [min, max]. */
  potionStack: [number, number];
}

/** Серия арены (config/arena.json). */
export interface ArenaConfig {
  /** Боёв в серии; награда — за победу в последнем. */
  seriesLength: number;
  /** Повторов проигранного боя на всю серию; кончились — поражение (оружие и рюкзак пропадают). */
  retries: number;
  reward: {
    /** Кубов за серию — всегда. */
    cubes: number;
    /** Один из вариантов по весу: предмет и количество [min, max]. */
    drops: Array<{ itemId: string; count: [number, number]; weight: number }>;
  };
}
