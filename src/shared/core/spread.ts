// Схема удара на кубах (для подсказок): куда уходит остаток урона от цели — те же правила, что в applyOverflow
// (core/battle.ts), на ровной модели: перёд всех столбиков на z = 0, позади — z < 0. Чистые функции.
import { COMBAT } from '../data/catalog';
import type { WeaponPattern, WeaponPerk } from '../data/types';

export type SpreadKind = 'chain' | 'share' | 'next';

export interface SpreadCell {
  /** Смещение от цели: x — вбок, y — вверх, z — вглубь (отрицательное). */
  d: [number, number, number];
  /** chain — по цепочке вглубь, share — доля остатка (как на ур. 1), next — следующий куб раскопки. */
  kind: SpreadKind;
}

const behind = (n: number, kind: SpreadKind): SpreadCell[] => Array.from({ length: n }, (_, k) => ({ d: [0, 0, -(k + 1)], kind }));

/** Куда уходит остаток урона при схеме pattern и свойствах уровня perk. */
export function spreadCells(pattern: WeaponPattern, perk: WeaponPerk = {}): SpreadCell[] {
  switch (pattern) {
    case 'precise':
      // остаток — цепочкой вглубь столбика без ограничения (0.0.73); на схеме — вся глубина куба
      return behind(2, 'chain');
    case 'carry':
      return [{ d: [0, 0, -1], kind: 'next' }];
    case 'pierce':
      return behind(perk.depth ?? COMBAT.patterns.pierce.depth, 'chain');
    case 'cleave': {
      const out: SpreadCell[] = [{ d: [-1, 0, 0], kind: 'share' }, { d: [1, 0, 0], kind: 'share' }];
      if (perk.sidesY) out.push({ d: [0, -1, 0], kind: 'share' }, { d: [0, 1, 0], kind: 'share' });
      if (perk.behind) out.push(...behind(perk.behind, 'share'));
      return out;
    }
    case 'split': {
      const out = behind(perk.behind ?? 1, 'share');
      out.push({ d: [1, 0, 0], kind: 'share' });
      if (perk.bothSides) out.push({ d: [-1, 0, 0], kind: 'share' });
      return out;
    }
    case 'crush': {
      const out: SpreadCell[] = [
        { d: [-1, 0, 0], kind: 'share' }, { d: [1, 0, 0], kind: 'share' }, { d: [0, -1, 0], kind: 'share' }, { d: [0, 1, 0], kind: 'share' },
      ];
      if (perk.diagonals) for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push({ d: [x, y, 0], kind: 'share' });
      out.push(...behind(perk.behind ?? 1, 'share'));
      return out;
    }
  }
}
