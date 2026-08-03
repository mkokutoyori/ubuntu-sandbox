/**
 * `newgrp(1)` — change le groupe primaire de la session en cours.
 *
 * Le nom était déclaré dans `KNOWN_LINUX_COMMANDS` sans implémentation :
 * `which newgrp` rendait `/usr/bin/newgrp` et la commande répondait
 * `command not found` (audit 11, §2).
 *
 * Ce que fait le vrai, et qui explique la forme du refus : `newgrp`
 * n'est pas un réglage, c'est **un nouveau shell**. Le groupe primaire
 * ne peut pas changer dans le processus courant, alors `newgrp` en
 * lance un fils avec le nouveau GID ; on en sort par `exit`. C'est
 * pourquoi `id -g` change après, et pourquoi les variables non
 * exportées du shell d'avant ont disparu.
 *
 * Ici le changement s'applique à la session du simulateur — il n'y a pas
 * de vrai fork à faire — mais la règle d'autorisation est celle du vrai,
 * et c'est elle qui compte : on ne peut passer qu'à un groupe **dont on
 * est déjà membre**, sauf à être root. Un groupe dont on n'est pas
 * membre demande le mot de passe de groupe (`/etc/gshadow`) ; le
 * simulateur n'a pas de dialogue de mot de passe sur ce chemin, il
 * refuse donc, ce que fait aussi le vrai quand le groupe n'a pas de mot
 * de passe défini — le cas de très loin le plus courant.
 */

import type { LinuxCommand } from '../LinuxCommand';

export const newgrpCommand: LinuxCommand = {
  name: 'newgrp',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'newgrp [-] [group]',
  help: 'Log in to a new group — starts a subshell with a new primary group.',
  options: [
    { flag: '-', description: 'Re-initialize the environment as at login.' },
  ],
  runWithStatusSync: (ctx, args) => {
    const um = ctx.executor.userMgr;
    const noms = args.filter((a) => a !== '-');
    const courant = um.currentUser;
    const compte = um.getUser(courant);
    if (!compte) return { output: `newgrp: user ${courant} does not exist`, exitCode: 1 };

    // Sans argument, `newgrp` revient au groupe primaire de /etc/passwd.
    if (noms.length === 0) {
      um.currentGid = compte.gid;
      return { output: '', exitCode: 0 };
    }

    const cible = noms[0];
    const groupe = um.getGroup(cible);
    if (!groupe) return { output: `newgrp: group '${cible}' does not exist`, exitCode: 1 };

    const membre = groupe.members?.includes(courant) === true || compte.gid === groupe.gid;
    if (!membre && courant !== 'root') {
      // Le vrai demanderait le mot de passe du groupe ; sans mot de
      // passe défini — le cas ordinaire — il refuse exactement ainsi.
      return { output: 'newgrp: Permission denied.', exitCode: 1 };
    }

    um.currentGid = groupe.gid;
    return { output: '', exitCode: 0 };
  },
  run: (ctx, args) => (newgrpCommand.runWithStatusSync!(ctx, args)).output,
};
