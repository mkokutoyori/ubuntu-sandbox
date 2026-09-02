/**
 * `ethtool` — les réglages et les compteurs d'une carte réseau.
 *
 * `docs/PRD-Link-State.md` §5 la déclarait hors périmètre, et pour une
 * bonne raison : sa ligne la plus lue, `Link detected:`, n'est rien
 * d'autre que la porteuse, et la porteuse n'existait pas. Elle existe
 * depuis le §6 — et elle tient compte de l'émetteur d'en face —, si
 * bien que la commande n'a plus rien à inventer : vitesse, duplex,
 * auto-négociation, MTU et compteurs sont tous des champs réels de
 * `Port`.
 *
 * Trois formes sont rendues, celles que les transcripts de debug
 * réclamaient : la vue par défaut, `-i` (pilote) et `-S` (statistiques).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { Port } from '../../../../hardware/Port';

const HELP =
  'ethtool - query or control network driver and hardware settings\n\n'
  + 'Displays link settings, driver information and NIC statistics for an\n'
  + 'interface. Only the read-only forms are available on this host.';

const OPTIONS = [
  { flag: '-i', description: 'Show driver information', aliases: ['--driver'] },
  { flag: '-S', description: 'Show NIC statistics', aliases: ['--statistics'] },
  { flag: '--help', description: 'Show this help' },
];

/** `ethtool` speaks in Mb/s and spells an unknown rate `Unknown!`. */
function speedLine(port: Port): string {
  return port.hasCarrier() ? `${port.getNegotiatedSpeed()}Mb/s` : 'Unknown!';
}

function duplexLine(port: Port): string {
  if (!port.hasCarrier()) return 'Unknown! (255)';
  return port.getNegotiatedDuplex() === 'full' ? 'Full' : 'Half';
}

function settings(name: string, port: Port): string {
  const advertised = [
    '10baseT/Half 10baseT/Full',
    '100baseT/Half 100baseT/Full',
    '1000baseT/Full',
  ];
  return [
    `Settings for ${name}:`,
    '\tSupported ports: [ TP ]',
    `\tSupported link modes:   ${advertised[0]}`,
    `\t                        ${advertised[1]}`,
    `\t                        ${advertised[2]}`,
    '\tSupported pause frame use: No',
    '\tSupports auto-negotiation: Yes',
    '\tSupported FEC modes: Not reported',
    `\tAdvertised link modes:  ${advertised[0]}`,
    `\t                        ${advertised[1]}`,
    `\t                        ${advertised[2]}`,
    '\tAdvertised pause frame use: No',
    `\tAdvertised auto-negotiation: ${port.isAutoNegotiation() ? 'Yes' : 'No'}`,
    '\tAdvertised FEC modes: Not reported',
    `\tSpeed: ${speedLine(port)}`,
    `\tDuplex: ${duplexLine(port)}`,
    '\tPort: Twisted Pair',
    '\tPHYAD: 0',
    '\tTransceiver: internal',
    `\tAuto-negotiation: ${port.isAutoNegotiation() ? 'on' : 'off'}`,
    '\tMDI-X: off (auto)',
    '\tSupports Wake-on: pumbg',
    '\tWake-on: d',
    '\tCurrent message level: 0x00000007 (7)',
    '\t\t\t       drv probe link',
    // La ligne pour laquelle on tape la commande.
    `\tLink detected: ${port.hasCarrier() ? 'yes' : 'no'}`,
  ].join('\n');
}

function driverInfo(name: string, port: Port): string {
  return [
    `driver: e1000`,
    `version: 7.3.21-k8-NAPI`,
    `firmware-version: N/A`,
    `expansion-rom-version:`,
    `bus-info: 0000:00:03.0`,
    `supports-statistics: yes`,
    `supports-test: yes`,
    `supports-eeprom-access: yes`,
    `supports-register-dump: yes`,
    `supports-priv-flags: no`,
    // Le nom n'est pas décoratif : il vient du port interrogé.
    `interface: ${name}`,
    `mtu: ${port.getMTU()}`,
  ].join('\n');
}

function statistics(name: string, port: Port): string {
  const c = port.getCounters();
  const rows: Array<[string, number]> = [
    ['rx_packets', c.framesIn],
    ['tx_packets', c.framesOut],
    ['rx_bytes', c.bytesIn],
    ['tx_bytes', c.bytesOut],
    ['rx_errors', c.errorsIn],
    ['tx_errors', c.errorsOut],
    ['rx_dropped', c.dropsIn],
    ['tx_dropped', c.dropsOut],
    ['rx_crc_errors', c.crcErrorsIn ?? 0],
    ['collisions', 0],
  ];
  return [
    `NIC statistics (${name}):`,
    ...rows.map(([k, v]) => `     ${k}: ${v}`),
  ].join('\n');
}

function execute(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  if (args.includes('--help') || args.includes('-h')) return { output: HELP, exitCode: 0 };

  const flags = args.filter(a => a.startsWith('-'));
  const positional = args.filter(a => !a.startsWith('-'));
  const name = positional[0];
  if (!name) {
    return { output: 'ethtool: bad command line argument(s)\nFor more information run ethtool -h', exitCode: 1 };
  }

  const port = ctx.net.getPorts().get(name);
  if (!port) {
    return { output: `netlink error: No such device\nethtool: cannot get device settings: No such device`, exitCode: 1 };
  }

  const unknown = flags.find(f => !['-i', '--driver', '-S', '--statistics'].includes(f));
  if (unknown) {
    // Les formes d'écriture (`-s`, `-K`, `-G`…) changeraient un matériel
    // que ce simulateur ne modélise pas ; les refuser vaut mieux que
    // répondre OK sans rien faire.
    return {
      output: `ethtool: ${unknown} is not supported on this host: only the read-only forms `
        + `(default, -i, -S) are available.`,
      exitCode: 1,
    };
  }

  if (flags.includes('-i') || flags.includes('--driver')) {
    return { output: driverInfo(name, port), exitCode: 0 };
  }
  if (flags.includes('-S') || flags.includes('--statistics')) {
    return { output: statistics(name, port), exitCode: 0 };
  }
  return { output: settings(name, port), exitCode: 0 };
}

export const ethtoolCommand: LinuxCommand = {
  name: 'ethtool',
  package: 'ethtool',
  needsNetworkContext: true,
  complete: (ctx, args) => {
    const partial = args[args.length - 1] ?? '';
    if (partial.startsWith('-')) {
      return ['-i', '-S', '--driver', '--statistics', '--help'].filter(f => f.startsWith(partial));
    }
    return Array.from(ctx.net.getPorts().keys()).filter(n => n.startsWith(partial));
  },
  manSection: 8,
  usage: 'ethtool [-i|-S] DEVNAME',
  help: HELP,
  options: OPTIONS,
  run(ctx: LinuxCommandContext, args: string[]): string {
    return execute(ctx, args).output;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return execute(ctx, args);
  },
};
