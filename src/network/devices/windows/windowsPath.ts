export function normalizeWindowsPath(path: string, cwd: string): string {
  let p = path.replace(/\//g, '\\');

  const driveMatch = p.match(/^([A-Za-z]):\\/);
  if (!driveMatch) {
    const justDrive = p.match(/^([A-Za-z]):$/);
    if (justDrive) {
      return justDrive[1].toUpperCase() + ':\\';
    }
    if (p.startsWith('\\')) {
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
