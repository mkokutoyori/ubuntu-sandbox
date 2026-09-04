/**
 * `logging` — l'arbre de commandes, pour les DEUX plateformes Cisco.
 *
 * Il n'y en avait pas : `logging` était un unique nœud glouton dont le
 * `switch` interne avait un `default` muet. Trois conséquences, toutes
 * mesurées avant d'écrire une ligne ici.
 *
 * D'abord, TOUT était accepté — `logging nimportequoi`, `logging console
 * 9` alors que la sévérité maximale est 7, `logging facility nawak`.
 * L'opérateur croyait avoir configuré quelque chose.
 *
 * Ensuite, l'aide ne pouvait rien descendre : un nœud glouton sans
 * sous-arbre n'a rien à proposer, donc `logging console ?` répondait la
 * liste des mots-clés de `logging` — après avoir choisi `console`, l'aide
 * proposait de rechoisir `console`. Or c'est précisément là qu'IOS rend
 * son plus grand service : il donne les huit sévérités AVEC leur numéro,
 * ce qui dispense de retenir la table.
 *
 * Enfin, seuls six mots-clés sur une vingtaine étaient seulement visibles.
 *
 * Ce module déclare donc chaque sous-commande pour elle-même, avec la
 * description d'IOS et ses arguments typés. Ce qui n'y figure pas est
 * refusé dans les mots d'IOS pour une commande que la plateforme n'a pas
 * (`% Invalid input detected at '^' marker.`) plutôt qu'accepté en
 * silence : `logging persistent` suppose un système de fichiers de
 * journaux au démarrage et `logging discriminator` un moteur de filtrage,
 * dont ni l'un ni l'autre n'existe ici — et une commande acceptée qui ne
 * fait rien coûte plus cher qu'un refus.
 */

import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { scopedTrie, type ExecScope } from './CiscoExecScope';
import type { CommandTrie, ParamSpec } from '../CommandTrie';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';
import {
  FACILITY_NAMES, SEVERITY_NAMES, BUFFERED_SIZE_MIN, BUFFERED_SIZE_MAX,
  HISTORY_SIZE_MIN, HISTORY_SIZE_MAX, RATE_LIMIT_MIN, RATE_LIMIT_MAX,
} from '../../inspection/config/LoggingConfig';
import type { LoggingConfig } from '../../inspection/config/LoggingConfig';

export interface LoggingCommandContext {
  config(): LoggingConfig;
  /** Le routeur rattache sa configuration au bus avant d'y toucher. */
  beforeApply?(): void;
  /** Et reprovisionne son agent syslog après. */
  afterApply?(): void;
  /**
   * Ce que la plateforme ajoute à son propre `show logging` — le journal
   * de surveillance DHCP d'un commutateur, que rien d'autre ne rend.
   */
  showSuffix?(): string;
}

/**
 * Les huit sévérités, avec la phrase d'IOS ET son numéro.
 *
 * Cette annotation n'est pas décorative : c'est elle qui rend la table
 * inutile à mémoriser, et c'est le point d'ergonomie le plus rentable de
 * toute la famille.
 */
const SEVERITY_HELP: Record<string, string> = {
  emergencies: 'System is unusable',
  alerts: 'Immediate action needed',
  critical: 'Critical conditions',
  errors: 'Error conditions',
  warnings: 'Warning conditions',
  notifications: 'Normal but significant conditions',
  informational: 'Informational messages',
  debugging: 'Debugging messages',
};

export function severityValues(): Array<{ keyword: string; description: string }> {
  return [
    { keyword: '<0-7>', description: 'Logging severity level' },
    ...SEVERITY_NAMES.map((name, i) => ({
      keyword: name,
      description: `${SEVERITY_HELP[name]} (severity=${i})`,
    })),
  ];
}

const isSeverity = (v: string): boolean => {
  const t = v.toLowerCase();
  if ((SEVERITY_NAMES as readonly string[]).includes(t)) return true;
  return /^\d+$/.test(t) && Number(t) >= 0 && Number(t) <= 7;
};

function severityParam(optional: boolean): ParamSpec {
  return {
    name: 'level',
    type: 'ENUM',
    description: 'Logging severity level',
    optional,
    validator: isSeverity,
    values: severityValues(),
  };
}

/**
 * L'argument de `logging buffered` est AMBIGU par conception et résolu
 * par sa valeur : `0-7` est une sévérité, `4096-2147483647` une taille.
 * L'aide doit donc proposer les deux.
 */
function bufferedParam(): ParamSpec {
  return {
    name: 'size-or-level',
    type: 'ENUM',
    description: 'Logging buffer size',
    optional: true,
    validator: (v) => isSeverity(v) || /^\d+$/.test(v),
    values: [
      { keyword: `<${BUFFERED_SIZE_MIN}-${BUFFERED_SIZE_MAX}>`, description: 'Logging buffer size' },
      ...severityValues(),
    ],
  };
}

/**
 * Un argument qui n'est qu'une suite de mots-clés.
 *
 * Déclarer un paramètre, même purement énumératif, est ce qui fait
 * ABSORBER la suite de la ligne par le nœud : sans lui la trie refuse le
 * premier mot avant que l'analyseur ne l'ait vu.
 */
function keywordParam(
  description: string,
  values: ReadonlyArray<[string, string]>,
): ParamSpec {
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

function apply(ctx: LoggingCommandContext, args: string[], negate: boolean): string {
  ctx.beforeApply?.();
  const err = ctx.config().applyLogging(args, negate);
  if (err) {
    if (err.kind === 'incomplete') throw new CliIncomplete();
    throw new CliInvalidInput({ token: err.token });
  }
  ctx.afterApply?.();
  return '';
}

interface Sub {
  keyword: string;
  description: string;
  params?: ParamSpec[];
  continuations?: Array<{ keyword: string; description: string }>;
}

const SUBCOMMANDS: readonly Sub[] = [
  {
    keyword: 'buffered',
    description: 'Set buffered logging parameters',
    params: [bufferedParam(), bufferedParam()],
    continuations: [{ keyword: 'discriminator', description: 'Establish MD-Buffer association' }],
  },
  {
    keyword: 'console', description: 'Set console logging parameters',
    params: [severityParam(true)],
    continuations: [{ keyword: 'discriminator', description: 'Establish MD-Console association' }],
  },
  { keyword: 'count', description: 'Count every log message and timestamp last occurrence' },
  {
    keyword: 'delimiter',
    description: 'Append delimiter to syslog messages',
    params: [{
      name: 'transport', type: 'ENUM', description: 'Transport the delimiter applies to',
      values: [{ keyword: 'tcp', description: 'Append delimiter to TCP syslog messages' }],
    }],
  },
  {
    keyword: 'discriminator',
    description: 'Create or modify a message discriminator',
    params: [{ name: 'name', type: 'WORD', description: 'Message discriminator name' }],
    continuations: [
      { keyword: 'severity', description: 'Set severity filter' },
      { keyword: 'facility', description: 'Set facility filter' },
      { keyword: 'mnemonics', description: 'Set mnemonic filter' },
      { keyword: 'msg-body', description: 'Set message body filter' },
      { keyword: 'rate-limit', description: 'Set rate limit for this discriminator' },
    ],
  },
  {
    keyword: 'exception',
    description: 'Limit size of exception flush output',
    params: [{
      name: 'size', type: 'INT', description: 'Size of exception flush output in bytes',
      range: [BUFFERED_SIZE_MIN, BUFFERED_SIZE_MAX],
    }],
  },
  {
    keyword: 'facility',
    description: 'Facility parameter for syslog messages',
    params: [{
      name: 'facility', type: 'ENUM', description: 'Syslog facility',
      validator: (v) => FACILITY_NAMES.includes(v.toLowerCase()),
      values: FACILITY_NAMES.map(f => ({ keyword: f, description: `${f} facility` })),
    }],
  },
  {
    keyword: 'history',
    description: 'Configure syslog history table',
    params: [severityParam(true)],
    continuations: [{ keyword: 'size', description: 'Set history table size' }],
  },
  {
    keyword: 'host',
    description: 'Set syslog server IP address and parameters',
    params: [{ name: 'ip', type: 'IP_ADDR', description: 'IP address of the syslog server' }],
    continuations: [
      { keyword: 'transport', description: 'Specify the transport protocol' },
      { keyword: 'discriminator', description: 'Establish MD-Host association' },
    ],
  },
  {
    keyword: 'message-counter',
    description: 'Configure log message counter',
    params: [{
      name: 'class', type: 'ENUM', description: 'Message class to count',
      values: [
        { keyword: 'debug', description: 'Count debug messages' },
        { keyword: 'log', description: 'Count log messages' },
        { keyword: 'syslog', description: 'Count syslog messages' },
      ],
    }],
  },
  {
    keyword: 'monitor', description: 'Set terminal line (monitor) logging parameters',
    params: [severityParam(true)],
    continuations: [{ keyword: 'discriminator', description: 'Establish MD-Monitor association' }],
  },
  { keyword: 'on', description: 'Enable logging to all supported destinations' },
  {
    keyword: 'origin-id',
    description: 'Add origin ID to syslog messages',
    params: [{
      name: 'mode', type: 'ENUM', description: 'Origin ID type',
      values: [
        { keyword: 'hostname', description: 'Use hostname as ID' },
        { keyword: 'ip', description: 'Use IP address as ID' },
        { keyword: 'ipv6', description: 'Use IPv6 address as ID' },
        { keyword: 'string', description: 'Use a user-defined string as ID' },
      ],
    }],
  },
  {
    keyword: 'persistent',
    description: 'Set persistent logging parameters',
    // Un nœud sans paramètre déclaré n'absorbe rien : la trie refusait
    // `logging persistent url …` sur le mot `url`, avant même que
    // l'analyseur ne le voie. Le paramètre rend les mots-clés visibles
    // dans l'aide ET laisse la suite passer jusqu'au gestionnaire.
    params: [keywordParam('Persistent logging parameter', [
      ['url', 'Location to store the persistent log'],
      ['size', 'Total size of the persistent log'],
      ['filesize', 'Size of an individual log file'],
      ['immediate', 'Write each message as it is logged'],
      ['batch', 'Write messages in batches of this size'],
      ['threshold', 'Percentage of the log that triggers a notice'],
    ])],
    continuations: [
      { keyword: 'url', description: 'Location to store the persistent log' },
      { keyword: 'size', description: 'Total size of the persistent log' },
      { keyword: 'filesize', description: 'Size of an individual log file' },
      { keyword: 'immediate', description: 'Write each message as it is logged' },
      { keyword: 'batch', description: 'Write messages in batches of this size' },
      { keyword: 'threshold', description: 'Percentage of the log that triggers a notice' },
    ],
  },
  {
    keyword: 'queue-limit',
    description: 'Set logger message queue size',
    params: [{
      name: 'size', type: 'ENUM', description: 'Number of messages the queue holds',
      validator: (v) => /^\d+$/.test(v) || ['esm', 'trap'].includes(v.toLowerCase()),
      values: [
        { keyword: '<1-2147483647>', description: 'Number of messages the queue holds' },
        { keyword: 'esm', description: 'Queue size for ESM filtered messages' },
        { keyword: 'trap', description: 'Queue size for messages sent to syslog servers' },
      ],
    }],
  },
  {
    keyword: 'rate-limit',
    description: 'Set messages per second limit',
    params: [{
      name: 'limit', type: 'ENUM', description: 'Messages per second',
      validator: (v) => /^\d+$/.test(v) || ['console', 'all'].includes(v.toLowerCase()),
      values: [
        { keyword: `<${RATE_LIMIT_MIN}-${RATE_LIMIT_MAX}>`, description: 'Message rate limit' },
        { keyword: 'all', description: 'Rate limit all messages' },
        { keyword: 'console', description: 'Rate limit console messages only' },
      ],
    }],
    continuations: [{ keyword: 'except', description: 'Messages of this severity or higher are not limited' }],
  },
  {
    keyword: 'reload',
    description: 'Set reload logging level',
    params: [severityParam(true)],
    continuations: [{ keyword: 'message-limit', description: 'Maximum messages kept across a reload' }],
  },
  { keyword: 'server-arp', description: 'Enable sending ARP requests for syslog servers when first message is sent' },
  { keyword: 'snmp-trap', description: 'Set syslog level for sending snmp trap', params: [severityParam(true)] },
  {
    keyword: 'source-interface',
    description: 'Specify interface for source address in logging transactions',
    params: [{ name: 'interface', type: 'INTERFACE', description: 'Source interface' }],
  },
  { keyword: 'trap', description: 'Set syslog server logging level', params: [severityParam(true)] },
  { keyword: 'userinfo', description: 'Enable logging of user info on privileged mode enabling' },
];

function buildTree(trie: CommandTrie, prefix: string, negate: boolean, ctx: LoggingCommandContext): void {
  const root = prefix ? `${prefix} logging` : 'logging';
  // Le nœud `logging` lui-même est exécutable : c'est la forme héritée
  // `logging <ip>`, qu'IOS normalise en `logging host <ip>` dans la
  // configuration — et c'est aussi ce qui attrape un mot-clé inconnu
  // pour le refuser en le nommant.
  trie.register(root, 'Modify message logging facilities',
    (args) => apply(ctx, args, negate),
    [{ name: 'ip', type: 'IP_ADDR', description: 'IP address of the syslog server', optional: true }]);

  for (const sub of SUBCOMMANDS) {
    trie.register(`${root} ${sub.keyword}`, sub.description,
      (args) => apply(ctx, [sub.keyword, ...args], negate), sub.params ?? []);
    if (sub.continuations) trie.addCompletionKeywords(`${root} ${sub.keyword}`, sub.continuations);
  }

  trie.register(`${root} history size`, 'Set history table size',
    (args) => apply(ctx, ['history', 'size', ...args], negate),
    [{
      name: 'entries', type: 'INT', description: 'Number of messages to keep',
      range: [HISTORY_SIZE_MIN, HISTORY_SIZE_MAX],
    }]);
}

export function registerLoggingConfigCommands(trie: CommandTrie, ctx: LoggingCommandContext): void {
  buildTree(trie, '', false, ctx);
  buildTree(trie, 'no', true, ctx);
}

/**
 * `service sequence-numbers` numérote pour de vrai.
 *
 * La commande tombait dans le gestionnaire générique `service`, qui la
 * rangeait parmi les drapeaux du routeur : `LoggingConfig.sequenceNumbers`
 * n'était écrit par personne, `show logging` répondait donc
 * `Sequence numbers: disabled` à qui venait de l'activer, et aucune ligne
 * ne portait de numéro. Elle est enregistrée pour elle-même ici, ce qui
 * la fait aussi apparaître dans `service ?` — où elle manquait.
 */
export function registerSequenceNumbersCommand(trie: CommandTrie, ctx: LoggingCommandContext): void {
  const set = (on: boolean) => (): string => {
    ctx.beforeApply?.();
    ctx.config().sequenceNumbers = on;
    return '';
  };
  trie.register('service sequence-numbers', 'Stamp logger messages with a sequence number', set(true));
  trie.register('no service sequence-numbers', 'Stop stamping logger messages', set(false));
}

export interface LoggingShowView {
  readonly path: readonly (string | ArgumentSpec)[];
  readonly description: string;
  render(args: Record<string, string>): string;
}

export function loggingShowViews(ctx: LoggingCommandContext): LoggingShowView[] {
  const avecSuffixe = (base: string): string => {
    const suffix = ctx.showSuffix?.() ?? '';
    return suffix ? `${base}\n\n${suffix}` : base;
  };

  return [
    {
      path: ['show', 'logging'],
      description: 'Show the contents of logging buffers',
      render: () => { ctx.beforeApply?.(); return avecSuffixe(ctx.config().render()); },
    },
    {
      // `show logging last <n>` — les N dernieres lignes du tampon. Le
      // `show logging` nu recrache tout, et ce qu'on cherche est en bas.
      // L'en-tete reste affiche : IOS ne le supprime pas.
      path: ['show', 'logging', 'last', {
        name: 'lignes', type: 'INT', range: [1, 2147483647],
        description: 'Number of lines to show from the end',
      }],
      description: 'Show last <n> lines of the logging buffer',
      render: (args) => {
        ctx.beforeApply?.();
        return avecSuffixe(ctx.config().render({ last: parseInt(args.lignes, 10) }));
      },
    },
    {
      path: ['show', 'logging', 'count'],
      description: 'Show occurrence count of each message',
      render: () => { ctx.beforeApply?.(); return ctx.config().renderCount(); },
    },
    {
      // Une table a PART, celle qu'alimente `logging history` et que le
      // SNMP releve : la rendre identique a `show logging` faisait croire
      // a une seule vue la ou IOS en a deux.
      path: ['show', 'logging', 'history'],
      description: 'Show the contents of the logging history table',
      render: () => { ctx.beforeApply?.(); return ctx.config().renderHistory(); },
    },
    {
      path: ['show', 'logging', 'persistent'],
      description: 'Show the contents of the persistent log files',
      render: () => { ctx.beforeApply?.(); return ctx.config().renderPersistent(); },
    },
  ];
}

/**
 * `clear logging persistent` efface les FICHIERS, pas le tampon
 * mémoire : ce sont deux journaux distincts, et vider l'un en croyant
 * vider l'autre est précisément l'erreur que cette commande existe pour
 * éviter.
 */
