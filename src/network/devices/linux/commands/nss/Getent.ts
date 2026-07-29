/**
 * getent — interroge les bases du Name Service Switch.
 *
 * La commande vivait dans le `switch` synchrone du dispatcher, ce qui la
 * condamnait à ne jamais pouvoir attendre. Or `hosts` peut partir sur le
 * réseau, et une réponse validée (DNSSEC) ou chiffrée (DoT) demande des
 * allers-retours qui ne tiennent pas dans une pile d'appel : à froid,
 * `getent hosts` ne rendait rien (`docs/PRD-resolvectl.md` §7.1).
 *
 * Passée au registre, elle emprunte le chemin asynchrone du dispatcher.
 * `runWithStatusSync` reste le repli des appels imbriqués qui, eux, ne
 * peuvent toujours pas attendre.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const DATABASES = [
  'passwd', 'group', 'shadow', 'gshadow', 'hosts', 'ahosts', 'ahostsv4',
  'ahostsv6', 'services', 'protocols', 'networks', 'ethers', 'rpc',
  'netgroup', 'initgroups', 'aliases',
];

export const getentCommand: LinuxCommand = {
  name: 'getent',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'getent [OPTION...] database [key ...]',
  help:
    'Get entries from administrative databases.\n\n' +
    'Walks the sources declared for the database in /etc/nsswitch.conf.\n' +
    `Databases: ${DATABASES.join(' ')}`,
  complete: makeArgCompleter({
    flags: ['-i', '--no-idn', '-s', '--service', '-h', '--help', '-V', '--version'],
    firstWords: DATABASES,
  }),

  // Pas de `runWithStatusSync` : les deux ponts qui l'appellent le
  // préfèrent à `runWithStatus`, ce qui condamnerait la commande au
  // chemin synchrone jusque depuis l'invite. Les appels réellement
  // incapables d'attendre retombent sur le `case 'getent'` du dispatcher,
  // qui appelle `getentSync`.
  runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.getentAsync(args);
  },

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.getentAsync(args)).output;
  },
};
