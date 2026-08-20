/**
 * `/etc/at.allow` et `/etc/at.deny` — la même règle que cron, avec un mot
 * de refus différent et une nuance d'usine qui compte.
 *
 * Relevé sur le vrai, cas négatif compris : un `at.allow` qui ne nomme
 * pas l'utilisateur le refuse, un `at.deny` qui le nomme aussi, et
 * `at.allow` l'emporte quand les deux existent. Root passe dans tous les
 * cas — mesuré avec un `at.allow` qui ne contient pas `root`.
 *
 * La nuance d'usine : contrairement à cron, dont aucun des deux fichiers
 * n'existe sur un Ubuntu neuf, le paquet `at` **livre** un
 * `/etc/at.deny` qui nomme les comptes de service. Un système sans
 * aucun des deux fichiers autorise tout le monde ; c'est bien ce que
 * `at.deny` sert à corriger.
 */

interface AtFsView {
  readFile(path: string): string | null;
}

function lireListe(vfs: AtFsView, path: string): Set<string> | null {
  const content = vfs.readFile(path);
  if (content === null) return null;
  const users = content.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return new Set(users);
}

export function atAllowed(user: string, vfs: AtFsView): boolean {
  if (user === 'root') return true;
  const allow = lireListe(vfs, '/etc/at.allow');
  if (allow) return allow.has(user);
  const deny = lireListe(vfs, '/etc/at.deny');
  if (deny) return !deny.has(user);
  return true;
}

/**
 * Le refus, mot pour mot. Le vrai nomme la commande appelée — `at`,
 * `atq` ou `atrm` — et non le binaire ; c'est la même exécutable sous
 * trois noms.
 */
export function atDenialMessage(commande: string): string {
  return `You do not have permission to use ${commande}.`;
}

/**
 * Les comptes que le paquet `at` d'Ubuntu inscrit dans `/etc/at.deny` à
 * l'installation. Recopiés, pas inventés : ce sont les comptes de
 * service du système, qui n'ont aucune raison de poser des tâches.
 */
export const AT_DENY_USINE = [
  'alias', 'backup', 'bin', 'daemon', 'ftp', 'games', 'gnats', 'guest',
  'irc', 'lp', 'mail', 'man', 'nobody', 'operator', 'proxy', 'qmaild',
  'qmaill', 'qmailp', 'qmailq', 'qmailr', 'qmails', 'sync', 'sys', 'www-data',
].join('\n') + '\n';
