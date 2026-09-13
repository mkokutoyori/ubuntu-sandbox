import type { CommandSpec } from '@/cli/CommandTable';

export interface ShowDebuggingHost {
  debugFlags(): string;
  debugConditions(): string;
}

const PRIVILEGIE = Object.freeze(['privileged']);

/**
 * `show debugging` et sa forme conditionnelle, pour les DEUX plateformes.
 *
 * Elles etaient ecrites trois fois — deux fichiers du routeur et le
 * shell du Catalyst — avec la meme expression mot pour mot, et
 * `show debug` etait pose a la main a cote. Ce n'est pas une commande :
 * c'est l'ABREVIATION de `show debugging`, que l'analyseur du socle rend
 * sans qu'on l'ecrive.
 *
 * La forme `condition` n'existait que chez le routeur, alors que les
 * deux plateformes portent le meme service de debogage, de la meme
 * classe : la divergence etait le fait des constructeurs, pas du
 * moteur.
 */
export function showDebuggingSpecs(ctx: () => ShowDebuggingHost): CommandSpec[] {
  return [
    {
      id: 'show-debugging',
      path: ['show', 'debugging'],
      description: 'Display active debug flags',
      modes: PRIVILEGIE, minPrivilege: 15,
      run: () => ctx().debugFlags(),
    },
    {
      id: 'show-debugging-condition',
      path: ['show', 'debugging', 'condition'],
      description: 'Display standing debug conditions',
      modes: PRIVILEGIE, minPrivilege: 15,
      run: () => ctx().debugConditions(),
    },
  ];
}
