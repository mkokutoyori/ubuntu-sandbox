/**
 * `logname` et `users` — qui est connecté, et sous quel nom.
 *
 * Les deux répondent à des questions différentes, et c'est exactement
 * pour ça qu'elles existent toutes les deux :
 *
 *   - `logname` rend le nom sous lequel la session s'est **ouverte**. Il
 *     survit à `su` et à `sudo` — après `sudo su -`, `whoami` dit `root`
 *     et `logname` dit toujours `user`. C'est la commande d'un script qui
 *     veut savoir qui l'a lancé, pas sous quelle identité il tourne.
 *   - `users` rend les noms des sessions **ouvertes**, séparés par un
 *     espace, un nom par session (donc répété si quelqu'un est connecté
 *     deux fois).
 *
 * Chacune lit ce qu'il faut : `logname` le fond de la pile `su` du shell
 * (la dérivation que l'audit utilise déjà pour `loginuid`), `users` le
 * registre de sessions qui alimente déjà `who` et `w`. Rien de neuf n'est
 * inventé — c'est la même vérité, sous un autre angle.
 *
 * Relevé sur la machine de référence : sans session enregistrée, `users`
 * n'affiche **rien** et sort en 0, et `logname` répond
 * `logname: no login name` avec une sortie 1. Les deux sont modélisés
 * ainsi ; c'est notamment ce qui arrive dans un conteneur sans utmp.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const lognameCommand: LinuxCommand = {
  name: 'logname',
  needsNetworkContext: true,
  usage: 'logname',
  manSection: 1,
  help: 'Print the user\'s login name.',
  runWithStatusSync(ctx: LinuxCommandContext) {
    const name = ctx.executor.loginName();
    if (!name) return { output: 'logname: no login name', exitCode: 1 };
    return { output: name, exitCode: 0 };
  },
  run(ctx: LinuxCommandContext): string {
    return this.runWithStatusSync!(ctx, []).output;
  },
};

export const usersCommand: LinuxCommand = {
  name: 'users',
  needsNetworkContext: true,
  usage: 'users',
  manSection: 1,
  help: 'Print the user names of users currently logged in.',
  runWithStatusSync(ctx: LinuxCommandContext) {
    const table = ctx.executor.getSessionTable();
    if (!table) return { output: '', exitCode: 0 };
    table.ensureConsoleSession(ctx.executor.userMgr.currentUser, ctx.executor.userMgr.currentUid);
    // Trié par nom, comme coreutils, et sans dédoublonnage : deux
    // sessions du même utilisateur donnent bien deux fois le nom.
    const names = table.list().map((s) => s.user).sort((a, b) => a.localeCompare(b));
    return { output: names.join(' '), exitCode: 0 };
  },
  run(ctx: LinuxCommandContext): string {
    return this.runWithStatusSync!(ctx, []).output;
  },
};
