/**
 * `info-center` — l'arbre de commandes de VRP.
 *
 * Il n'y en avait pas : un unique nœud glouton dirigeait tout vers un
 * `if/else` qui ne validait rien, et le SEUL mot-clé que l'aide
 * proposait — `enable` — venait d'une boucle générique de bascules
 * partagée avec `telnet server enable`. D'où la réponse absurde relevée
 * dans le PRD : après avoir tapé `loghost`, l'aide proposait `enable`,
 * décrit `Toggle: info-center enable`, un libellé interne qu'aucun
 * équipement n'imprime.
 *
 * Chaque sous-commande est déclarée pour elle-même, avec les mots de
 * VRP, et les huit sévérités sont annotées de leur numéro — le même
 * service rendu à l'opérateur que du côté IOS.
 */

import type { CommandTrie, ParamSpec } from '../CommandTrie';
import {
  VRP_SEVERITIES, VRP_FACILITIES, VRP_MODULES, VRP_TIMESTAMP_FORMATS,
  LOGBUFFER_SIZE_MAX, TRAPBUFFER_SIZE_MAX, normVrpSeverity,
} from '../../router/management/InfoCenterConfig';
import type { InfoCenterConfig, InfoCenterError } from '../../router/management/InfoCenterConfig';

export interface InfoCenterContext {
  config(): InfoCenterConfig | undefined;
  /** Appelé après une commande acceptée, pour reprovisionner l'agent syslog. */
  afterApply?(): void;
}

/**
 * VRP décrit ses sévérités comme IOS décrit les siennes. L'annotation
 * numérique est ce qui dispense l'opérateur de retenir la table.
 */
const SEVERITY_HELP: Record<string, string> = {
  emergencies: 'Emergency error',
  alert: 'Alert error',
  critical: 'Critical error',
  error: 'Common error',
  warning: 'Warning',
  notification: 'Normal but significant',
  informational: 'Informational',
  debugging: 'Debug information',
};

function severityParam(optional = false): ParamSpec {
  return {
    name: 'level',
    type: 'ENUM',
    description: 'Severity level',
    optional,
    validator: (v) => normVrpSeverity(v) !== null,
    values: VRP_SEVERITIES.map((s, i) => ({
      keyword: s,
      description: `${SEVERITY_HELP[s]} (severity=${i})`,
    })),
  };
}

function keywordParam(description: string, values: ReadonlyArray<[string, string]>): ParamSpec {
  const mots = values.map(([keyword, d]) => ({ keyword, description: d }));
  return {
    name: 'option',
    type: 'ENUM',
    description,
    optional: true,
    validator: (v) => mots.some(m => m.keyword === v.toLowerCase()),
    values: mots,
  };
}

/**
 * Le message de VRP, avec le curseur sous le mot fautif. Deux libellés
 * distincts, et la distinction est réelle : une VALEUR hors bornes n'est
 * pas un mot-clé inconnu.
 */
function renderError(err: InfoCenterError, line: string): string {
  if (err.kind === 'incomplete') return 'Error: Incomplete command found at \'^\' position.';
  const mot = err.token;
  const pos = mot ? Math.max(0, line.toLowerCase().indexOf(mot.toLowerCase())) : line.trimEnd().length;
  const marker = ' '.repeat(pos) + '^';
  const quoi = err.kind === 'wrong-parameter' ? 'Wrong parameter' : 'Unrecognized command';
  return `${marker}\nError: ${quoi} found at '^' position.`;
}

function apply(ctx: InfoCenterContext, args: string[], undo: boolean, raw: string): string {
  const cfg = ctx.config();
  if (!cfg) return '';
  const err = cfg.apply(args, undo);
  if (err) return renderError(err, raw);
  ctx.afterApply?.();
  return '';
}

interface Sub {
  keyword: string;
  description: string;
  params?: ParamSpec[];
  continuations?: Array<{ keyword: string; description: string }>;
}

const DESTINATIONS: ReadonlyArray<[string, string]> = [
  ['console', 'Configure the console channel'],
  ['monitor', 'Configure the monitor (terminal) channel'],
  ['logbuffer', 'Configure the log buffer'],
  ['trapbuffer', 'Configure the trap buffer'],
  ['snmpagent', 'Configure the SNMP agent channel'],
];

const SUBCOMMANDS: readonly Sub[] = [
  { keyword: 'enable', description: 'Enable the information center' },
  {
    keyword: 'channel',
    description: 'Configure a channel',
    params: [{
      name: 'channel', type: 'INT', description: 'Channel number',
      range: [0, 9],
    }],
    continuations: [{ keyword: 'name', description: 'Rename the channel' }],
  },
  {
    keyword: 'loghost',
    description: 'Configure a log host',
    params: [{
      name: 'host', type: 'ENUM', description: 'IP address of the log host',
      validator: (v) => v.toLowerCase() === 'source' || /^\d{1,3}(\.\d{1,3}){3}$/.test(v),
      values: [
        { keyword: 'A.B.C.D', description: 'IP address of the log host' },
        { keyword: 'source', description: 'Source interface of syslog packets' },
      ],
    }],
    continuations: [
      { keyword: 'channel', description: 'Channel the log host subscribes to' },
      { keyword: 'facility', description: 'Syslog facility' },
      { keyword: 'level', description: 'Lowest severity sent to this log host' },
      { keyword: 'port', description: 'UDP or TCP port of the log host' },
      { keyword: 'source-ip', description: 'Source IP address of syslog packets' },
      { keyword: 'transport', description: 'Transport protocol' },
    ],
  },
  {
    keyword: 'source',
    description: 'Configure the rules for outputting information',
    params: [{
      name: 'module', type: 'ENUM', description: 'Module name',
      validator: (v) => VRP_MODULES.some(m => m.toLowerCase() === v.toLowerCase()),
      values: VRP_MODULES.map(m => ({
        keyword: m,
        description: m === 'default' ? 'All modules' : `${m} module`,
      })),
    }],
    continuations: [
      { keyword: 'channel', description: 'Channel this rule applies to' },
      { keyword: 'log', description: 'Log information' },
      { keyword: 'trap', description: 'Trap information' },
      { keyword: 'debug', description: 'Debug information' },
      { keyword: 'state', description: 'Enable or disable this rule' },
      { keyword: 'level', description: 'Severity threshold' },
    ],
  },
  {
    keyword: 'timestamp',
    description: 'Configure the timestamp format',
    params: [
      keywordParam('Information type', [
        ['log', 'Log information'],
        ['trap', 'Trap information'],
        ['debug', 'Debug information'],
      ]),
      keywordParam('Timestamp format',
        VRP_TIMESTAMP_FORMATS.map(f => [f, `Use the ${f} format`] as [string, string])),
    ],
    continuations: [{ keyword: 'precision-time', description: 'Timestamp precision' }],
  },
];

export function registerInfoCenterCommands(trie: CommandTrie, ctx: InfoCenterContext): void {
  const build = (prefix: string, undo: boolean): void => {
    const root = prefix ? `${prefix} info-center` : 'info-center';
    trie.register(root, 'Information center configuration',
      (args, raw) => apply(ctx, args, undo, raw ?? root));

    for (const sub of SUBCOMMANDS) {
      if (sub.keyword === 'source') continue;
      trie.register(`${root} ${sub.keyword}`, sub.description,
        (args, raw) => apply(ctx, [sub.keyword, ...args], undo, raw ?? ''), sub.params ?? []);
      if (sub.continuations) {
        trie.addCompletionKeywords(`${root} ${sub.keyword}`, sub.continuations);
      }
    }

    // Les destinations partagent leur grammaire : un canal, et pour les
    // deux tampons une taille. Les déclarer ensemble évite cinq copies
    // qui finiraient par diverger.
    for (const [dest, description] of DESTINATIONS) {
      const tampon = dest === 'logbuffer' || dest === 'trapbuffer';
      trie.register(`${root} ${dest}`, description,
        (args, raw) => apply(ctx, [dest, ...args], undo, raw ?? ''), [
          keywordParam('Destination parameter', tampon
            ? [['channel', 'Channel this destination subscribes to'],
               ['size', 'Number of messages the buffer holds']]
            : [['channel', 'Channel this destination subscribes to']]),
        ]);
      if (tampon) {
        trie.register(`${root} ${dest} size`, 'Number of messages the buffer holds',
          (args, raw) => apply(ctx, [dest, 'size', ...args], undo, raw ?? ''), [{
            name: 'size', type: 'INT', description: 'Number of messages',
            range: [0, dest === 'logbuffer' ? LOGBUFFER_SIZE_MAX : TRAPBUFFER_SIZE_MAX],
          }]);
      }
      trie.register(`${root} ${dest} channel`, 'Channel this destination subscribes to',
        (args, raw) => apply(ctx, [dest, 'channel', ...args], undo, raw ?? ''), [{
          name: 'channel', type: 'INT', description: 'Channel number', range: [0, 9],
        }]);
    }

    // `source` absorbe sa ligne — module, canal, type, état, niveau —
    // parce que ses mots-clés viennent APRÈS un argument, ce que des
    // nœuds enfants ne savent pas exprimer. Le seul endroit où l'aide
    // doit vraiment descendre est `level`, et c'est un nœud purement
    // indicatif : l'exécution continue de passer par le parent.
    trie.registerGreedy(`${root} source`, 'Configure the rules for outputting information',
      (args, raw) => apply(ctx, ['source', ...args], undo, raw ?? ''));
    trie.describeArgs(`${root} source`, [SUBCOMMANDS.find(s => s.keyword === 'source')!.params![0]]);
    trie.describeArgs(`${root} source level`, [severityParam()]);
    trie.addCompletionKeywords(`${root} source`,
      SUBCOMMANDS.find(s => s.keyword === 'source')!.continuations!);
  };
  build('', false);
  build('undo', true);
}

export function registerInfoCenterDisplayCommands(
  trie: CommandTrie, ctx: InfoCenterContext,
): void {
  trie.registerGreedy('display channel', 'Display information channels', (args) => {
    const cfg = ctx.config();
    if (!cfg) return '';
    if (args[0] !== undefined && cfg.resolveChannel(args[0]) === null) {
      return renderError({ kind: 'wrong-parameter', token: args[0] }, `display channel ${args[0]}`);
    }
    return cfg.renderChannels(args[0]).join('\n');
  });
}

export { renderError as renderInfoCenterError };
