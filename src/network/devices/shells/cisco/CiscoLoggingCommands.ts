/**
 * `logging` — les vues et les commandes que le socle ne porte pas.
 *
 * L'arbre des sous-commandes a migre au socle (`loggingEntries` dans
 * `CiscoShellBase`, engendre par `loggingFamily`) : le declarer aussi
 * ici en faisait deux ecritures d'un meme fait, dont l'une etait
 * entierement elaguee au demarrage et ne servait donc plus qu'a
 * diverger en silence.
 *
 * Ce qui reste : les severites, que le socle LIT depuis ici pour ne pas
 * retaper les phrases d'IOS ; `service sequence-numbers` ; les vues
 * `show logging` ; et `clear logging`.
 */

import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandTrie } from '../CommandTrie';
import { SEVERITY_NAMES } from '../../inspection/config/LoggingConfig';
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
