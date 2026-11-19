// Скины персонажей: цвет каждого исходного блока по его индексу. Геометрия и боевые индексы не меняются.
export interface CharacterSkin {
  id: string;
  blueprintId: string;
  name: string;
  colors: readonly number[];
  /** Закрытый скин виден в галерее, но выбрать его нельзя. */
  locked?: boolean;
  /** Процедурный узор на поверхности каждого блока. */
  pattern?: 'spots';
}

const WARAN = {
  head: [0],
  neck: [1],
  body: [2, 3, 5, 7, 9],
  tail: [4, 6, 8],
  legs: [10, 11, 12, 13, 16, 17, 18, 19],
  feet: [14, 15, 20, 21],
};

function waranColors(body: number, head: number, neck: number, tail: readonly [number, number, number], legs: number, feet: number): number[] {
  const colors = Array(22).fill(body) as number[];
  const paint = (indices: readonly number[], color: number) => indices.forEach((i) => colors[i] = color);
  paint(WARAN.head, head);
  paint(WARAN.neck, neck);
  paint([WARAN.tail[0]], tail[0]);
  paint([WARAN.tail[1]], tail[1]);
  paint([WARAN.tail[2]], tail[2]);
  paint(WARAN.legs, legs);
  paint(WARAN.feet, feet);
  return colors;
}

export const CHARACTER_SKINS: CharacterSkin[] = [
  {
    id: 'waran-desert',
    blueprintId: 'bp-waran',
    name: 'Песчаный',
    locked: true,
    colors: waranColors(0xb98b52, 0xd0aa6d, 0xba9158, [0x9a6c3e, 0x795033, 0x593b28], 0x9c7043, 0x533824),
  },
  {
    id: 'waran-rock',
    blueprintId: 'bp-waran',
    name: 'Скальный',
    locked: true,
    colors: waranColors(0x687263, 0x7b8273, 0x606b5c, [0x505b4e, 0x414a40, 0x323a33], 0x596454, 0x30372f),
  },
  {
    id: 'waran-emerald',
    blueprintId: 'bp-waran',
    name: 'Изумрудный',
    locked: true,
    colors: waranColors(0x3f7861, 0x579477, 0x477e65, [0x35634f, 0x2b5041, 0x213d32], 0x376b55, 0x253d32),
  },
  {
    id: 'waran-sunset',
    blueprintId: 'bp-waran',
    name: 'Закатный',
    locked: true,
    colors: waranColors(0xb65f46, 0xd08255, 0xb96b49, [0x964b3b, 0x753a32, 0x4e2d29], 0x9c503e, 0x542f28),
  },
  {
    id: 'waran-ice',
    blueprintId: 'bp-waran',
    name: 'Ледяной',
    locked: true,
    colors: waranColors(0x6f9fb0, 0x93bdca, 0x7da9b7, [0x577f91, 0x436777, 0x324f5c], 0x5b899a, 0x344c56),
  },
  {
    id: 'waran-albino',
    blueprintId: 'bp-waran',
    name: 'Альбинос',
    colors: waranColors(0xe3dcc8, 0xf1ead8, 0xe7dfc9, [0xcbbda2, 0xb8a78c, 0x9c8d75], 0xcfc2a7, 0x99846b),
    locked: true,
  },
];

export const skinsFor = (blueprintId: string) => CHARACTER_SKINS.filter((s) => s.blueprintId === blueprintId);

export function resolveSkin(blueprintId: string, skinId?: string): CharacterSkin | undefined {
  return CHARACTER_SKINS.find((s) => s.blueprintId === blueprintId && s.id === skinId && !s.locked);
}

export function skinColorOf(blueprintId: string, skinId: string | undefined, block: number): number | undefined {
  return resolveSkin(blueprintId, skinId)?.colors[block];
}

export const skinPatternOf = (blueprintId: string, skinId?: string) => resolveSkin(blueprintId, skinId)?.pattern;
