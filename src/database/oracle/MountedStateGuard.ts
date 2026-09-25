export const ORA_01219 =
  'ORA-01219: database or pluggable database not open: queries allowed on fixed tables/views only';

const FIXED_PREFIXES = ['V$', 'GV$', 'X$', 'V_$', 'GV_$'];

function referencedObjects(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_$#][\w$#.]*)/gi)) {
    names.push(match[1].toUpperCase());
  }
  return names;
}

function isFixedView(name: string): boolean {
  const bare = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
  return FIXED_PREFIXES.some(p => bare.startsWith(p));
}

export function mountedRefusesQuery(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) return false;
  const objects = referencedObjects(upper);
  if (objects.length === 0) return false;
  return objects.some(name => !isFixedView(name));
}
