/**
 * FileDescriptorTable — les descripteurs ouverts d'un processus, calculés
 * à UN seul endroit (docs/PRD-Pannes.md §F9.3).
 *
 * Un processus a une table de descripteurs, et tout ce qui en parle doit
 * la lire au même endroit : `/proc/<pid>/fd`, `lsof`, et le contrôle de
 * `RLIMIT_NOFILE` qui décide si un `open()` de plus est possible. Avant ce
 * module, la numérotation vivait dans `materializeProcFd` — elle était
 * donc RENDUE mais jamais COMPTÉE, et un second lecteur aurait dû la
 * réinventer. Deux numérotations d'une même table finiraient par diverger,
 * et une machine où `ls /proc/<pid>/fd` et `lsof` ne s'accordent pas est
 * pire qu'une machine où les deux se trompent : rien dans le diagnostic ne
 * tomberait juste.
 *
 * Les trois sources sont celles d'un vrai processus, dans l'ordre où le
 * noyau les attribue : 0/1/2 d'abord (le shell les a ouverts avant
 * l'exec), puis les fichiers, puis les sockets.
 */

/** Un descripteur ouvert : son numéro et ce vers quoi il pointe. */
export interface OpenDescriptor {
  readonly fd: number;
  /** La cible que `/proc/<pid>/fd/<n>` montre — un chemin ou `socket:[id]`. */
  readonly target: string;
}

/** Ce dont le calcul a besoin, et rien de plus. */
export interface DescriptorSources {
  /** `/dev/pts/0` pour un processus attaché à un terminal. */
  readonly tty?: string;
  readonly pid: number;
  readonly openFiles?: ReadonlyArray<{ fd: number; path: string }>;
  readonly socketIds?: readonly number[];
}

/**
 * La table de descripteurs du processus, dans l'ordre des numéros.
 *
 * Un processus sans terminal voit ses 0/1/2 pointer sur une socket, comme
 * un démon lancé par systemd — c'est ce que `/proc/<pid>/fd` montre sur une
 * vraie machine, pas `/dev/null`.
 */
export function openDescriptors(p: DescriptorSources): OpenDescriptor[] {
  const out: OpenDescriptor[] = [];
  const stdTarget = p.tty && p.tty !== '?' ? `/dev/${p.tty}` : `socket:[${10000 + p.pid}]`;
  for (const n of [0, 1, 2]) out.push({ fd: n, target: stdTarget });

  let nextFd = 3;
  for (const f of p.openFiles ?? []) {
    out.push({ fd: f.fd, target: f.path });
    nextFd = Math.max(nextFd, f.fd + 1);
  }
  for (const id of p.socketIds ?? []) {
    out.push({ fd: nextFd, target: `socket:[${id}]` });
    nextFd++;
  }
  return out;
}

/**
 * Combien de descripteurs ce processus tient ouverts — le nombre que
 * `RLIMIT_NOFILE` plafonne et que `lsof | wc -l` compte.
 */
export function descriptorCount(p: DescriptorSources): number {
  return openDescriptors(p).length;
}
