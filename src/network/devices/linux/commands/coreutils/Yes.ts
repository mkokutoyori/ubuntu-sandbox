/**
 * `yes` — répéter une chaîne indéfiniment.
 *
 * Le vrai `yes` ne s'arrête jamais : c'est le consommateur d'en face qui
 * ferme le tube, et `yes | head -3` termine parce que `head` s'en va après
 * trois lignes. Cette simultanéité n'existe pas ici — le tube du
 * simulateur est **séquentiel** (`BashInterpreter.runPipelineStages`
 * exécute chaque étage jusqu'au bout et passe sa sortie complète à
 * l'étage suivant), donc un producteur réellement infini ne rendrait
 * jamais la main et figerait l'onglet.
 *
 * La commande est donc **bornée**, et la borne est écrite ici plutôt que
 * subie : `YES_MAX_LINES` lignes, largement au-delà de ce qu'un `head -n`
 * ou un `sed -n '…p'` consomme dans un exercice. `yes | head -3` rend donc
 * les trois `y` attendus, ce qui est l'usage réel de la commande dans 99 %
 * des cas — le second étant `yes | apt install`, où seule la première
 * ligne compte.
 *
 * Ce qui est donc DIFFÉRENT du vrai, et assumé : `yes > fichier` écrit
 * un fichier fini au lieu de remplir le disque. Il n'y a pas de « bonne »
 * valeur finie à comparer à un flux qui ne termine pas ; borner est la
 * seule option honnête, et la borne est visible plutôt que devinée.
 */

import type { LinuxCommand } from '../LinuxCommand';

/**
 * Assez pour tout `head`/`sed`/`awk` d'exercice, assez peu pour que la
 * chaîne tienne sans peine en mémoire (~20 Ko pour la valeur par défaut).
 */
export const YES_MAX_LINES = 10000;

export function runYes(args: string[]): string {
  const operands = args.filter((a) => a !== '--');
  const line = operands.length > 0 ? operands.join(' ') : 'y';
  return Array.from({ length: YES_MAX_LINES }, () => line).join('\n');
}

export const yesCommand: LinuxCommand = {
  name: 'yes',
  needsNetworkContext: true,
  usage: 'yes [STRING]...',
  manSection: 1,
  help: 'Output a string repeatedly until killed.',
  run(_ctx, args) { return runYes(args); },
  runWithStatusSync(_ctx, args) { return { output: runYes(args), exitCode: 0 }; },
};
