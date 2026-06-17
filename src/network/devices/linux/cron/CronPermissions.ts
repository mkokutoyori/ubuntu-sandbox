interface CronFsView {
  readFile(path: string): string | null;
}

function readList(vfs: CronFsView, path: string): Set<string> | null {
  const content = vfs.readFile(path);
  if (content === null) return null;
  const users = content.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  return new Set(users);
}

export function cronAllowed(user: string, vfs: CronFsView): boolean {
  if (user === 'root') return true;
  const allow = readList(vfs, '/etc/cron.allow');
  if (allow) return allow.has(user);
  const deny = readList(vfs, '/etc/cron.deny');
  if (deny) return !deny.has(user);
  return true;
}
