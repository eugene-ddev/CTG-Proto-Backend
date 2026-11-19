import { COMBAT, EFFECTS, getItem, weaponStrike } from './catalog';
import type { Blueprint, BlueprintVariant, EffectId, Item, Stat, WeaponPattern, WeaponPerk } from './types';

export const STAT_LABEL: Record<Stat, string> = {
  Armor: 'Броня',
  Strength: 'Сила',
  Dexterity: 'Ловкость',
  Intelligence: 'Интеллект',
  Stamina: 'Выносливость',
  Luck: 'Удача',
};

/** Родительный падеж — «скейлится от силы». */
export const STAT_LABEL_GEN: Record<Stat, string> = {
  Armor: 'брони',
  Strength: 'силы',
  Dexterity: 'ловкости',
  Intelligence: 'интеллекта',
  Stamina: 'выносливости',
  Luck: 'удачи',
};

export const turns = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'ход' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'хода' : 'ходов'}`;

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Короткая строка под названием: главное о предмете. */
export function itemSummary(item: Item): string {
  switch (item.kind) {
    case 'weapon': {
      const strike = weaponStrike(item);
      return `урон ${round1(item.ability.damage * strike.multiplier)}${strike.hits > 1 ? ` ×${strike.hits}` : ''} · КД ${item.ability.cooldown}`;
    }
    case 'artifact':
      return `${item.ability.effects.map((e) => EFFECTS[e].name.toLowerCase()).join(', ')} · ${item.ability.manaCost} маны`;
    case 'gem':
      return item.effects.map((e) => EFFECTS[e].name.toLowerCase()).join(', ');
    case 'bag':
      return item.unused ? 'не используется' : `${item.capacity} слотов`;
    case 'potion':
      return `+${item.restoreAmount} ${STAT_LABEL_GEN[item.restoreStat]}`;
    case 'resource':
      return `ресурс · стопка до ${item.maxStack}`;
  }
}

export function blueprintSummary(bp: Blueprint): string {
  if (bp.kind === 'character') {
    const hands = bp.slots.filter((s) => s.type === 'Hand').length;
    const arts = bp.slots.filter((s) => s.type === 'Artifact').length;
    return `категория ${bp.category} · ${hands} руки, ${arts} арт.`;
  }
  if ('variants' in bp) {
    return bp.restoreAmount ? `+${bp.restoreAmount} · стата на выбор` : `${bp.variants.map((v) => v.label.toLowerCase()).join(', ')} — на выбор`;
  }
  return itemSummary(getItem(bp.itemId));
}

export interface StatRow {
  label: string;
  value: string;
  color?: string;
}

/** Что делает эффект — по частям: урон, распространение, ослабление, стаки, что снимает. */
export function effectParts(id: EffectId): string[] {
  const e = EFFECTS[id];
  const parts: string[] = [];
  if (e.damagePerTick) parts.push(`${e.damagePerTick} урона за ход, ${turns(e.duration)}`);
  else if (e.kind !== 'Shield') parts.push(turns(e.duration));
  if (e.spreadChance) parts.push(`${Math.round(e.spreadChance * 100)}% за ход перекинуться на соседний куб`);
  if (e.statMultiplier) parts.push(`стата отравленного куба ×${e.statMultiplier}`);
  if (e.durabilityMultiplier) parts.push(`прочность куба ×${e.durabilityMultiplier}`);
  if (e.statDisabled) parts.push('стата замёрзшего куба не учитывается');
  if (e.removes?.length) parts.push(`снимает ${e.removes.map((r) => EFFECTS[r].name.toLowerCase()).join(', ')}`);
  if ((e.maxStacks ?? 1) > 1) parts.push(`стакается до\u00a0${e.maxStacks}`);
  return parts;
}

/** Одна строка-описание эффекта: «Горение: 6 урона за ход, 3 хода; …». */
export const effectDescription = (id: EffectId) => `${EFFECTS[id].name}: ${effectParts(id).join('; ')}.`;

/** Строки тултипа по эффекту: название — урон и длительность, дальше — по одному свойству. */
function effectRows(id: EffectId): StatRow[] {
  const e = EFFECTS[id];
  const rows: StatRow[] = [{ label: e.name, value: e.damagePerTick ? `${e.damagePerTick}/ход × ${turns(e.duration)}` : turns(e.duration), color: '#c0281e' }];
  if (e.spreadChance) rows.push({ label: 'Перекидывается', value: `${Math.round(e.spreadChance * 100)}% за ход` });
  if (e.statMultiplier) rows.push({ label: 'Стата куба', value: `×${e.statMultiplier}` });
  if (e.durabilityMultiplier) rows.push({ label: 'Прочность куба', value: `×${e.durabilityMultiplier}` });
  if (e.statDisabled) rows.push({ label: 'Стата куба', value: 'не учитывается' });
  if ((e.maxStacks ?? 1) > 1) rows.push({ label: 'Стаки', value: `до ${e.maxStacks}` });
  if (e.removes?.length) rows.push({ label: 'Снимает', value: e.removes.map((r) => EFFECTS[r].name.toLowerCase()).join(', ') });
  return rows;
}

/** Описание предмета для подсказок и карточки: у камня — что делает эффект, у остального — из конфига. */
export function itemDescription(item: Item): string {
  if (item.kind === 'gem') return `Вставляется в оружие — удар накладывает эффект на куб цели. ${item.effects.map(effectDescription).join(' ')}`;
  return item.description;
}

/** Строки «метка — значение» для тултипа «Статы слота». */
export function itemRows(item: Item): StatRow[] {
  switch (item.kind) {
    case 'weapon':
    case 'artifact': {
      const a = item.ability;
      const lvl = Math.min(item.itemLevel, COMBAT.weaponLevels.max);
      const rows: StatRow[] = [{ label: 'Уровень', value: item.kind === 'weapon' ? `${lvl} / ${COMBAT.weaponLevels.max}` : String(item.itemLevel) }];
      if (item.kind === 'weapon' && lvl >= 2) rows.push({ label: 'Свойства', value: weaponPerkText(item.id, item.pattern ?? 'carry', lvl) });
      if (item.kind === 'weapon') rows.push({ label: 'Ячейки камней', value: `${item.gemSlots} / ${COMBAT.gemCells.max}` });
      // урон и число ударов — с учётом свойства уровня, как в бою
      const strike = weaponStrike(item);
      if (a.damage > 0 && a.type !== 'ApplyEffect') rows.push({ label: 'Урон', value: `${round1(a.damage * strike.multiplier)}${strike.hits > 1 ? ` × ${strike.hits} удара за ход` : ''}`, color: '#c0281e' });
      if (item.kind === 'weapon') rows.push({ label: 'Удар', value: `${PATTERN_LABEL[item.pattern ?? 'carry']}: ${patternDescription(item.pattern ?? 'carry')}` });
      rows.push({ label: 'Кулдаун', value: turns(Math.max(1, a.cooldown)) });
      if (a.staminaCost) rows.push({ label: 'Выносливость', value: String(a.staminaCost) });
      if (a.manaCost) rows.push({ label: 'Мана', value: String(a.manaCost) });
      rows.push({ label: 'Скейлится от', value: STAT_LABEL_GEN[item.scalingStat] });
      if (item.minStatRequired) rows.push({ label: 'Нужно', value: `${item.minStatRequired} ${STAT_LABEL_GEN[item.scalingStat]}` });
      for (const e of a.effects) rows.push(...(e === 'shield' ? [{ label: 'Эффект', value: EFFECTS[e].name }] : effectRows(e)));
      return rows;
    }
    case 'gem':
      return item.effects.flatMap(effectRows);
    case 'bag':
      return [{ label: 'Слотов', value: String(item.capacity) }];
    case 'potion':
      return [
        { label: 'Чинит', value: `${item.restoreAmount} ${STAT_LABEL_GEN[item.restoreStat]}` },
        { label: 'Стак', value: `до ${item.maxStack}` },
      ];
    case 'resource':
      return [{ label: 'Стопка', value: `до ${item.maxStack}` }];
  }
}

/** Что делает выбранный вариант: камень со стихией или флакон со статой. */
export function variantDescription(v: BlueprintVariant): string {
  const item = getItem(v.itemId);
  if (item.kind === 'gem') return itemDescription(item);
  if (item.kind === 'potion') {
    return `Встроенное зелье персонажа. Один заряд чинит ${item.restoreAmount} разбит${item.restoreAmount === 1 ? 'ый куб' : item.restoreAmount === 5 ? 'ых кубов' : 'ых куба'} ${STAT_LABEL_GEN[item.restoreStat]}. Заряды восстанавливаются при возвращении с арены в лобби.`;
  }
  return item.description;
}

/** Название схемы удара оружия (battle-rework, этап 4). */
export const PATTERN_LABEL: Record<WeaponPattern, string> = {
  carry: 'Сквозной',
  precise: 'Точный',
  cleave: 'Рубящий',
  pierce: 'Колющий',
  split: 'Раскалывающий',
  crush: 'Дробящий',
};

/** Куда идёт урон сверх прочности куба — одной строкой для подсказки. */
export function patternDescription(p: WeaponPattern): string {
  const c = COMBAT.patterns;
  switch (p) {
    case 'precise':
      return `броня действует на ${Math.round((1 - c.precise.armorIgnore) * 100)}%; остаток — вглубь столбика, до конца`;
    case 'cleave':
      return 'остаток — передним кубам соседних столбиков по ряду';
    case 'pierce':
      return `остаток — вглубь столбика, до ${c.pierce.depth} кубов`;
    case 'split':
      return 'остаток — в куб за целью и в соседний столбик';
    case 'crush':
      return 'остаток — крестом по передней грани и в куб за целью';
    default:
      return 'остаток — в следующий куб по фокусу атаки';
  }
}

/** Свойства уровня оружия одной строкой: «броня не действует, пробивает на 1 клетку вглубь». */
export function perkDescription(perk: WeaponPerk, pattern: WeaponPattern): string {
  const parts: string[] = [];
  if (perk.armorIgnore !== undefined) parts.push(perk.armorIgnore >= 1 ? 'броня не действует' : `броня действует на ${Math.round((1 - perk.armorIgnore) * 100)}%`);
  if (perk.depth) parts.push(pattern === 'pierce' ? `дальность ${perk.depth} клетки` : `пробивает на ${perk.depth} клетку вглубь`);
  if (perk.critMultiplier) parts.push(`крит ×${perk.critMultiplier}`);
  if (perk.hits) parts.push(`${perk.hits} удара за ход`);
  if (perk.damageMultiplier) parts.push(`урон удара ×${perk.damageMultiplier}`);
  if (perk.sidesY) parts.push('соседи сверху и снизу тоже');
  if (perk.bothSides) parts.push('вбок в обе стороны');
  if (perk.diagonals) parts.push('крест и диагонали (3×3)');
  if (perk.behind && (perk.behind > 1 || pattern === 'cleave')) parts.push(perk.behind > 1 ? `${perk.behind} клетки позади` : 'и куб позади');
  if (perk.stun) parts.push(`оглушение ${Math.round(perk.stun * 100)}%`);
  return parts.join(', ') || '—';
}

/** Свойства уровня level у оружия itemId (ур. 1 — без свойств). */
export function weaponPerkText(itemId: string, pattern: WeaponPattern, level: number): string {
  const p = level >= 2 ? COMBAT.weaponLevels.perks[itemId]?.[level - 2] : undefined;
  return p ? perkDescription(p, pattern) : 'без свойств';
}

/** «Ловкость отключена», «Интеллект отключён» — стата перешла порог в бою. */
export const statDisabledTitle = (s: Stat) => `${STAT_LABEL[s]} ${s === 'Intelligence' ? 'отключён' : 'отключена'}`;

/** Что теряет боец, когда стата отключена порогом (config/combat.json → statThresholds). */
export function disabledEffect(s: Stat): string {
  const t = COMBAT.statThresholds;
  switch (s) {
    case 'Strength':
      return `силовое оружие бьёт ×${t.strengthWeaponMultiplier}`;
    case 'Dexterity':
      return 'уворота нет';
    case 'Luck':
      return 'крита нет';
    case 'Stamina':
      return `выносливость восстанавливается только ${t.staminaRegen} за ход`;
    case 'Intelligence':
      return 'артефакты не работают';
    default:
      return 'без эффекта';
  }
}

/** Короткие подписи стат для плашек приоритета атаки (BlockTypeLabel). */
export const STAT_SHORT: Record<Stat, string> = {
  Armor: 'БРН',
  Strength: 'СИЛ',
  Dexterity: 'ЛВК',
  Intelligence: 'ИНТ',
  Stamina: 'ВЫН',
  Luck: 'УДЧ',
};
