interface CronFsView {
  readFile(path: string): string | null;
}

function readList(vfs: CronFsView, path: string): Set<string> | null {
  const content = vfs.readFile(path);
  if (content === null) return null;
  const users = content.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  return new Set(users);
}

/**
 * Le refus, mot pour mot. Relevé sur le vrai `crontab` avec un
 * `/etc/cron.deny` nommant l'utilisateur : deux lignes, et la seconde
 * **sans point final**.
 */
export function cronDenialMessage(user: string): string {
  return `You (${user}) are not allowed to use this program (crontab)\n`
    + 'See crontab(1) for more information';
}

/**
 * Vérifié sur le vrai binaire, y compris le cas négatif qui manquait :
 * un `cron.allow` qui ne nomme pas l'utilisateur le refuse, un
 * `cron.deny` qui le nomme aussi, et `cron.allow` l'emporte quand les
 * deux existent. Root passe dans tous les cas — mesuré : un
 * `cron.allow` sans `root`, et un `cron.deny` **avec** `root`, laissent
 * l'un comme l'autre root travailler.
 */
export function cronAllowed(user: string, vfs: CronFsView): boolean {
  if (user === 'root') return true;
  const allow = readList(vfs, '/etc/cron.allow');
  if (allow) return allow.has(user);
  const deny = readList(vfs, '/etc/cron.deny');
  if (deny) return !deny.has(user);
  return true;
}
