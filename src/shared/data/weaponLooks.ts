// Оружие по уровням: названия. Модели уровней — в чертеже (levelBlocks), собираются в tools/models.py.

/** Приставка к названию оружия по уровню: [мужской, женский, средний род]. Ур. 1 — без приставки. */
const LEVEL_PREFIX: Record<number, [string, string, string]> = {
  2: ['Улучшенный', 'Улучшенная', 'Улучшенное'],
  3: ['Сияющий', 'Сияющая', 'Сияющее'],
};

/** Название оружия на уровне: «Меч» → «Улучшенный меч» → «Сияющий меч»; род — по окончанию («Булава», «Копьё»). */
export function weaponLevelName(baseName: string, level: number): string {
  const prefix = LEVEL_PREFIX[Math.min(level, 3)];
  if (!prefix) return baseName;
  const noun = baseName.split(' ')[0].toLowerCase();
  const gender = /[ая]$/.test(noun) ? 1 : /[оеё]$/.test(noun) ? 2 : 0;
  return `${prefix[gender]} ${baseName.charAt(0).toLowerCase()}${baseName.slice(1)}`;
}
