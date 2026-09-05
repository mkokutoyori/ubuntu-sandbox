export const FILE_ATTRIBUTE_NAMES = [
  'archive', 'hidden', 'system', 'readonly', 'directory', 'normal',
] as const;

export type FileAttributeName = typeof FILE_ATTRIBUTE_NAMES[number];

const DIR_LETTERS: Record<string, FileAttributeName> = {
  d: 'directory', h: 'hidden', s: 'system', r: 'readonly', a: 'archive',
};

export interface AttributeSelection {
  required: FileAttributeName[];
  forbidden: FileAttributeName[];
}

export function isDefaultVisible(attrs: ReadonlySet<string>): boolean {
  return !attrs.has('hidden') && !attrs.has('system');
}

export function parseAttributeNames(spec: string): FileAttributeName[] | null {
  const asked = spec.split(/[,+]/).map(a => a.trim().toLowerCase()).filter(a => a !== '');
  const known: FileAttributeName[] = [];
  for (const name of asked) {
    const match = FILE_ATTRIBUTE_NAMES.find(a => a === name);
    if (match === undefined) return null;
    known.push(match);
  }
  return known;
}

export function parseDirAttributeSpec(spec: string): AttributeSelection | null {
  const selection: AttributeSelection = { required: [], forbidden: [] };
  let negate = false;
  for (const raw of spec.toLowerCase()) {
    if (raw === '-') { negate = true; continue; }
    if (raw === ':' || raw === ' ') continue;
    const name = DIR_LETTERS[raw];
    if (name === undefined) return null;
    (negate ? selection.forbidden : selection.required).push(name);
    negate = false;
  }
  return selection;
}

export function selectionAccepts(
  selection: AttributeSelection, attrs: ReadonlySet<string>, isDirectory: boolean,
): boolean {
  const effective = new Set<string>(attrs);
  if (isDirectory) effective.add('directory');
  return selection.required.every(a => effective.has(a))
    && !selection.forbidden.some(a => effective.has(a));
}
