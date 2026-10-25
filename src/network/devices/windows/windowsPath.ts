export type DriveDirectoryResolver = (letter: string) => string;

export const driveLetterOf = (path: string): string | null =>
  /^([A-Za-z]):/.exec(path)?.[1].toUpperCase() ?? null;

export function parentPathOf(path: string): string {
  const trimmed = path.replace(/\//g, '\\').replace(/\\+$/, '');
  const cut = trimmed.lastIndexOf('\\');
  if (cut === -1) return '';
  if (cut === 0) return trimmed.slice(0, 1);
  const parent = trimmed.slice(0, cut);
  return /^[^\\:]+:$/.test(parent) ? `${parent}\\` : parent;
}

export function directoryOfDrive(letter: string, cwd: string, remembered: ReadonlyMap<string, string>): string {
  return driveLetterOf(cwd) === letter ? cwd : remembered.get(letter) ?? `${letter}:\\`;
}

export function normalizeWindowsPath(path: string, cwd: string, driveDirectory?: DriveDirectoryResolver): string {
  let p = path.replace(/\//g, '\\');

  const driveMatch = p.match(/^([A-Za-z]):\\/);
  if (!driveMatch) {
    const driveRelative = p.match(/^([A-Za-z]):(.*)$/);
    if (driveRelative) {
      const letter = driveRelative[1].toUpperCase();
      const base = driveDirectory?.(letter) ?? (driveLetterOf(cwd) === letter ? cwd : `${letter}:\\`);
      p = driveRelative[2] === '' ? base : `${base}\\${driveRelative[2]}`;
    } else if (p.startsWith('\\')) {
      const cwdDrive = cwd.match(/^([A-Za-z]):/);
      p = (cwdDrive ? cwdDrive[1].toUpperCase() : 'C') + ':' + p;
    } else {
      p = cwd + '\\' + p;
    }
  }

  const drive = p.substring(0, 2).toUpperCase();
  const rest = p.substring(2);

  const parts = rest.split('\\').filter(s => s !== '' && s !== '.');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  if (resolved.length === 0) return drive + '\\';
  return drive + '\\' + resolved.join('\\');
}
