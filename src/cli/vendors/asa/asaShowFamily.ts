import type { CommandSpec } from '../../CommandTable';

/**
 * Ce que la machine sait montrer, declare UNE fois.
 *
 * `ASA_VOCABULARY` disait quelles vues existent, `ASA_COMMAND_HELP` ce
 * qu'elles font, et le `switch` de `AsaShell.execCommand` decidait
 * vraiment — trois magasins pour un seul fait, qu'aucune regle ne tenait
 * ensemble. Ici la declaration porte le chemin, la phrase d'aide et le
 * corps ensemble, donc l'aide ne peut plus annoncer une vue que
 * l'execution refuse, ni taire une vue qui marche.
 */
export interface AsaShowHost {
  showView(view: AsaShowView, argument?: string): string;
}

export type AsaShowView =
  | 'nameif' | 'conn' | 'conn-count' | 'xlate' | 'version'
  | 'running-config' | 'access-list' | 'nat' | 'logging';

interface Row {
  readonly path: readonly string[];
  readonly description: string;
  readonly view: AsaShowView;
}

const ROWS: readonly Row[] = [
  { path: ['show', 'nameif'], view: 'nameif', description: 'Display interface names and security levels' },
  { path: ['show', 'conn'], view: 'conn', description: 'Display the connection table' },
  { path: ['show', 'conn', 'count'], view: 'conn-count', description: 'Display the number of connections in use' },
  { path: ['show', 'xlate'], view: 'xlate', description: 'Display the translation table' },
  { path: ['show', 'version'], view: 'version', description: 'Display software version' },
  { path: ['show', 'running-config'], view: 'running-config', description: 'Display the running configuration' },
  { path: ['show', 'access-list'], view: 'access-list', description: 'Display access lists and their hit counts' },
  { path: ['show', 'nat'], view: 'nat', description: 'Display NAT policies in evaluation order' },
  { path: ['show', 'logging'], view: 'logging', description: 'Display the syslog buffer and settings' },
];

/**
 * Un ASA accepte en mode superieur toute commande d'un mode inferieur —
 * c'est la difference avec IOS, ou il faut prefixer par `do`. Une vue
 * est donc atteignable depuis les six modes, et non depuis l'EXEC seul.
 */
const ASA_ALL_MODES = Object.freeze([
  'privileged', 'config', 'config-if', 'config-object', 'config-group',
]);

export function asaShowFamily(host: () => AsaShowHost): CommandSpec[] {
  return ROWS.map(row => ({
    id: row.path.join('-'),
    path: [...row.path],
    description: row.description,
    modes: ASA_ALL_MODES,
    minPrivilege: 1,
    run: () => host().showView(row.view),
  }));
}

export const ASA_SHOW_FAMILY: readonly CommandSpec[] =
  asaShowFamily(() => ({ showView: () => '' }));

export const ASA_SOCLE_PATHS: readonly string[] =
  ROWS.map(row => row.path.join(' '));
