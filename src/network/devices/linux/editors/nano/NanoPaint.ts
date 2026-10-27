import type { Paint, ScreenStyle } from '../screen/EditorScreen';

export type NanoElement =
  | 'title' | 'number' | 'stripe' | 'scroller' | 'selected' | 'spotlight'
  | 'mini' | 'prompt' | 'status' | 'error' | 'key' | 'function';

export const ELEMENT_OPTIONS: Readonly<Record<string, NanoElement>> = {
  titlecolor: 'title', numbercolor: 'number', stripecolor: 'stripe', scrollercolor: 'scroller',
  selectedcolor: 'selected', spotlightcolor: 'spotlight', minicolor: 'mini', promptcolor: 'prompt',
  statuscolor: 'status', errorcolor: 'error', keycolor: 'key', functioncolor: 'function',
};

export interface ColorCombination {
  readonly fg: number | null;
  readonly bg: number | null;
  readonly bold: boolean;
  readonly italic: boolean;
}

export type CombinationOutcome =
  | { readonly combination: ColorCombination }
  | { readonly error: string };

export interface SpanLook {
  readonly style: ScreenStyle;
  readonly paint?: Paint;
}

export interface InterfacePaints {
  readonly title: SpanLook;
  readonly number: SpanLook;
  readonly stripe: SpanLook;
  readonly scroller: SpanLook | null;
  readonly scrollerLit: SpanLook;
  readonly selected: SpanLook;
  readonly spotlight: SpanLook;
  readonly mini: SpanLook;
  readonly prompt: SpanLook;
  readonly status: SpanLook;
  readonly error: SpanLook;
  readonly key: SpanLook;
  readonly tag: SpanLook | null;
}

const TERMINAL_COLORS = 256;
const BAD_COLOR = -2;
const THE_DEFAULT = -1;

const HUES: ReadonlyArray<readonly [string, number]> = [
  ['red', 1], ['green', 2], ['blue', 4], ['yellow', 3], ['cyan', 6], ['magenta', 5], ['white', 7], ['black', 0],
  ['normal', THE_DEFAULT], ['pink', 204], ['purple', 163], ['mauve', 134], ['lagoon', 38], ['mint', 48],
  ['lime', 148], ['peach', 215], ['orange', 208], ['latte', 137], ['rosy', 175], ['beet', 127], ['plum', 98],
  ['sea', 32], ['sky', 111], ['slate', 66], ['teal', 35], ['sage', 107], ['brown', 100], ['ocher', 142],
  ['sand', 186], ['tawny', 136], ['brick', 166], ['crimson', 161], ['grey', 8], ['gray', 8],
];

const CUBE_LEVEL = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];

interface ShortColor {
  readonly value: number;
  readonly vivid: boolean;
  readonly thick: boolean;
  readonly error: string | null;
}

function colorToShort(name: string): ShortColor {
  let vivid = false;
  let thick = false;
  let rest = name;
  if (rest.startsWith('bright') && rest.length > 6) {
    vivid = true;
    thick = true;
    rest = rest.slice(6);
  } else if (rest.startsWith('light') && rest.length > 5) {
    vivid = true;
    rest = rest.slice(5);
  }
  const failure = (error: string): ShortColor => ({ value: BAD_COLOR, vivid, thick, error });
  if (rest[0] === '#' && rest.length === 4) {
    if (vivid) return failure(`Color '${rest}' takes no prefix`);
    const hexadecimal = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(rest);
    if (hexadecimal !== null) {
      const [red, green, blue] = [1, 2, 3].map((group) => Number.parseInt(hexadecimal[group], 16));
      return { value: 36 * CUBE_LEVEL[red] + 6 * CUBE_LEVEL[green] + CUBE_LEVEL[blue] + 16, vivid, thick, error: null };
    }
  }
  const index = HUES.findIndex(([hue]) => hue === rest);
  if (index < 0) return failure(`Color "${rest}" not understood`);
  if (index > 7 && vivid) return failure(`Color '${rest}' takes no prefix`);
  return { value: HUES[index][1], vivid, thick, error: null };
}

export function parseCombination(specification: string): CombinationOutcome {
  let rest = specification;
  let bold = false;
  let italic = false;
  if (rest.startsWith('bold')) {
    bold = true;
    if (rest[4] !== ',') return { error: 'An attribute requires a subsequent comma' };
    rest = rest.slice(5);
  }
  if (rest.startsWith('italic')) {
    italic = true;
    if (rest[6] !== ',') return { error: 'An attribute requires a subsequent comma' };
    rest = rest.slice(7);
  }
  const comma = rest.indexOf(',');
  const foregroundName = comma < 0 ? rest : rest.slice(0, comma);
  let fg = THE_DEFAULT;
  if (comma < 0 || comma > 0) {
    const named = colorToShort(foregroundName);
    if (named.error !== null) return { error: named.error };
    fg = named.value;
    if (named.vivid && !named.thick && TERMINAL_COLORS > 8) fg += 8;
    else if (named.vivid) bold = true;
  }
  let bg = THE_DEFAULT;
  if (comma >= 0) {
    const named = colorToShort(rest.slice(comma + 1));
    if (named.error !== null) return { error: named.error };
    bg = named.value;
    if (named.vivid && TERMINAL_COLORS > 8) bg += 8;
  }
  return { combination: { fg: fg === THE_DEFAULT ? null : fg, bg: bg === THE_DEFAULT ? null : bg, bold, italic } };
}

export function paintLook(combination: ColorCombination, reverse = false): SpanLook {
  return { style: 'paint', paint: { fg: combination.fg, bg: combination.bg, bold: combination.bold, italic: combination.italic, underline: false, reverse } };
}

export type ElementCombinations = Readonly<Partial<Record<NanoElement, ColorCombination | null>>>;

export function resolveInterfacePaints(combinations: ElementCombinations, boldtext: boolean, noColorRequested: boolean): InterfacePaints {
  const hilite: SpanLook = { style: boldtext ? 'bold' : 'reverse' };
  const configured = Object.values(combinations).some((combination) => combination !== null && combination !== undefined);
  const rescind = noColorRequested && !configured;
  const look = (element: NanoElement, fallback: SpanLook | null): SpanLook | null => {
    const combination = combinations[element];
    return combination === null || combination === undefined ? fallback : paintLook(combination);
  };
  const title = look('title', hilite)!;
  const scrollerCombination = combinations.scroller;
  return {
    title,
    number: look('number', hilite)!,
    stripe: look('stripe', { style: 'reverse' })!,
    scroller: look('scroller', null),
    scrollerLit: scrollerCombination === null || scrollerCombination === undefined ? { style: 'reverse' } : paintLook(scrollerCombination, true),
    selected: look('selected', hilite)!,
    spotlight: look('spotlight', { style: rescind ? 'reverse' : 'search' })!,
    mini: look('mini', title)!,
    prompt: look('prompt', title)!,
    status: look('status', hilite)!,
    error: look('error', { style: rescind ? 'reverse' : 'alert' })!,
    key: look('key', hilite)!,
    tag: look('function', null),
  };
}
