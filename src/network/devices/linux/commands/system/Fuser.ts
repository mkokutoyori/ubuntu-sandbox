/**
 * `fuser(1)` — quels processus tiennent ce fichier, ce répertoire, ou ce
 * port.
 *
 * La question qu'on lui pose est toujours la même : « pourquoi ne
 * puis-je pas démonter ceci / libérer ce port ». `lsof` répond en
 * listant tout ; `fuser` répond en donnant les PID, et rien d'autre,
 * pour qu'on puisse les passer à `kill`.
 *
 * Le nom était déclaré dans `KNOWN_LINUX_COMMANDS` sans implémentation :
 * `which fuser` rendait `/usr/bin/fuser` et la commande répondait
 * `command not found` (audit 11, §2).
 *
 * Deux détails du vrai, reproduits parce qu'ils surprennent :
 *
 *   - **les PID vont sur la sortie standard, le reste sur l'erreur.**
 *     C'est ce qui rend `kill -9 $(fuser -s /var/log)` possible : le
 *     nom du fichier et les lettres d'accès ne polluent pas la
 *     substitution. Ici les deux flux se rejoignent dans une seule
 *     chaîne, mais l'ordre et la mise en forme sont ceux-là.
 *   - **rien trouvé ⇒ sortie vide et code 1.** `fuser` ne dit pas
 *     « aucun processus » ; il se tait. C'est ce silence que les scripts
 *     testent.
 *
 * Les lettres d'accès rendues sont `c` (cwd) et `f` (fichier ouvert) —
 * les deux seules que le modèle de processus du simulateur permette de
 * distinguer honnêtement. `r` (racine), `m` (projeté en mémoire) et `e`
 * (exécutable) demanderaient une table de descripteurs que
 * `LinuxProcessManager` n'a pas.
 */

import type { LinuxCommand } from '../LinuxCommand';

const USAGE = `Usage: fuser [-fuv] [-k [-i] [-SIGNAL]] NAME...
       fuser -l
       fuser -V
Show which processes use the named files, sockets, or filesystems.

  -k              kill processes accessing the named file
  -i              ask before killing (ignored without -k)
  -m              show all processes using the named filesystems
  -s              silent operation
  -u              display user IDs
  -v              verbose output
  -V              display version information`;

interface FuserArgs {
  names: string[];
  kill: boolean;
  silent: boolean;
  verbose: boolean;
  users: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

export function parseFuserArgs(args: string[]): FuserArgs {
  const out: FuserArgs = {
    names: [], kill: false, silent: false, verbose: false,
    users: false, showHelp: false, showVersion: false,
  };
  for (const a of args) {
    if (a === '-h' || a === '--help') { out.showHelp = true; continue; }
    if (a === '-V' || a === '--version') { out.showVersion = true; continue; }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === 'k') out.kill = true;
        else if (c === 's') out.silent = true;
        else if (c === 'v') out.verbose = true;
        else if (c === 'u') out.users = true;
      }
      continue;
    }
    out.names.push(a);
  }
  return out;
}

export interface FuserHolder {
  readonly pid: number;
  readonly user: string;
  readonly comm: string;
  /** `c` = répertoire courant, `f` = fichier ouvert. */
  readonly access: string;
}

export const fuserCommand: LinuxCommand = {
  name: 'fuser',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'fuser [-fuv] [-k [-i] [-SIGNAL]] NAME...',
  help: 'Identify processes using files or sockets.',
  options: [
    { flag: '-k', description: 'Kill processes accessing the file.' },
    { flag: '-s', description: 'Silent operation — print nothing, only set the exit status.' },
    { flag: '-u', description: 'Append the user name of the process owner.' },
    { flag: '-v', description: 'Verbose: one line per process, with the access column.' },
    { flag: '-m', description: 'Name a mounted filesystem rather than a file.' },
  ],
  runWithStatusSync: (ctx, args) => {
    const parsed = parseFuserArgs(args);
    if (parsed.showHelp) return { output: USAGE, exitCode: 0 };
    if (parsed.showVersion) return { output: 'fuser (PSmisc) 23.4', exitCode: 0 };
    if (parsed.names.length === 0) return { output: USAGE, exitCode: 1 };

    const ex = ctx.executor;
    const lignes: string[] = [];
    let trouveQuelquePart = false;

    for (const nom of parsed.names) {
      const chemin = ex.vfs.normalizePath(nom, ex.getCwd());
      const detenteurs = tenantsDe(ex, chemin);
      if (detenteurs.length === 0) continue;
      trouveQuelquePart = true;
      if (parsed.silent) continue;

      if (parsed.verbose) {
        lignes.push('                     USER        PID ACCESS COMMAND');
        for (const d of detenteurs) {
          lignes.push(`${chemin.padEnd(20)} ${d.user.padEnd(10)} ${String(d.pid).padStart(5)} `
            + `${d.access.padEnd(6)} ${d.comm}`);
        }
      } else {
        // La forme courte : le nom suivi de deux-points sur l'erreur,
        // les PID seuls sur la sortie standard. Le vrai les met sur la
        // même ligne à l'écran parce que les deux flux s'y mélangent.
        const pids = detenteurs.map((d) => `${d.pid}${d.access}`).join(' ');
        lignes.push(`${chemin}: ${pids}`);
      }

      if (parsed.kill) {
        for (const d of detenteurs) ex.processMgr.kill(d.pid, 'SIGKILL');
      }
    }

    return { output: lignes.join('\n'), exitCode: trouveQuelquePart ? 0 : 1 };
  },
  run: (ctx, args) => (fuserCommand.runWithStatusSync!(ctx, args)).output,
};

/**
 * Les processus qui tiennent ce chemin. Un processus le tient s'il y a
 * son répertoire courant (`c`), ou s'il a le fichier ouvert (`f`).
 */
function tenantsDe(
  ex: { processMgr: { list(): { pid: number; user: string; comm: string; cwd?: string }[] } },
  chemin: string,
): FuserHolder[] {
  const out: FuserHolder[] = [];
  for (const p of ex.processMgr.list()) {
    // Les fils du noyau (`[kthreadd]`, `[rcu_gp]`, …) n'ont pas de
    // répertoire courant : le vrai `fuser` ne les compte jamais, et les
    // faire apparaître noierait les seuls PID qu'on vient chercher.
    if (p.comm.startsWith('[')) continue;
    const cwd = p.cwd ?? '/';
    if (cwd === chemin || cwd.startsWith(chemin === '/' ? '/' : `${chemin}/`)) {
      out.push({ pid: p.pid, user: p.user, comm: p.comm, access: 'c' });
    }
  }
  return out;
}
