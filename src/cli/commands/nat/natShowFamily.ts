import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import {
  showNATStatistics, showNATTranslations, showNATTranslationsVerbose,
} from '@/network/devices/shells/cisco/CiscoNATCommands';
import { words, type NatHost } from './natHost';

const SHOW: readonly string[] = Object.freeze(['user', 'privileged']);

const VRF: ArgumentSpec = { name: 'vrf', type: 'WORD', description: 'VRF name' };

const VERBOSE_FILTER: ArgumentSpec = {
  name: 'filtre', type: 'REST', optional: true, description: 'Optional filter',
};

function vrfTranslations(host: NatHost, vrf: string): string {
  if (!host.vrfExists(vrf)) return `% VRF ${vrf} does not exist.`;
  const entries = host.engine().getStaticEntries().filter(entry => entry.vrf === vrf);
  if (entries.length === 0) return 'No NAT entries.';
  return [
    'Pro  Inside global          Inside local           Outside local          Outside global',
    ...entries.map(entry =>
      `---  ${padToWidth(entry.globalIP, 23)}${padToWidth(entry.localIP, 23)}---                    ---`),
  ].join('\n');
}

function timeouts(host: NatHost): string {
  const t = host.engine().getTimeouts();
  return [
    `timeout: ${t.simple / 1000}`,
    `tcp-timeout: ${t.tcp / 1000}`,
    `udp-timeout: ${t.udp / 1000}`,
    `icmp-timeout: ${t.icmp / 1000}`,
    `dns-timeout: ${t.dns / 1000}`,
    `syn-timeout: ${t.tcpHalfOpen / 1000}`,
    `finrst-timeout: ${t.finrst / 1000}`,
  ].join('\n');
}

export function natShowFamily(host: () => NatHost): CommandSpec[] {
  const spec = (
    id: string, path: readonly (string | ArgumentSpec)[], description: string,
    run: (h: NatHost, args: Readonly<Record<string, string>>) => string,
  ): CommandSpec => ({
    id: `show-ip-nat-${id}`, path: [...path], description,
    modes: SHOW, minPrivilege: 1,
    run: (_session, args) => run(host(), args),
  });

  return [
    spec('nvi-translations', ['show', 'ip', 'nat', 'nvi', 'translations'],
      'Show NVI NAT translations', h => showNATTranslations(h.router())),
    spec('translations', ['show', 'ip', 'nat', 'translations'],
      'Display NAT translation table', h => showNATTranslations(h.router())),
    spec('translations-vrf', ['show', 'ip', 'nat', 'translations', 'vrf', VRF],
      'Display NAT translations in VRF', (h, args) => vrfTranslations(h, args.vrf)),
    spec('translations-timeout', ['show', 'ip', 'nat', 'translations', 'timeout'],
      'Display configured NAT timeouts', h => timeouts(h)),
    spec('translations-verbose', ['show', 'ip', 'nat', 'translations', 'verbose', VERBOSE_FILTER],
      'Display detailed NAT translations',
      (h, args) => showNATTranslationsVerbose(h.router(), words(args.filtre))),
    spec('translations-verbose-vrf',
      ['show', 'ip', 'nat', 'translations', 'verbose', 'vrf', VRF, VERBOSE_FILTER],
      'Display NAT translations in VRF',
      (h, args) => h.vrfExists(args.vrf)
        ? showNATTranslationsVerbose(h.router(), words(args.filtre))
        : `% VRF ${args.vrf} does not exist.`),
    spec('statistics', ['show', 'ip', 'nat', 'statistics'],
      'Display NAT statistics', h => showNATStatistics(h.router())),
    spec('statistics-vrf', ['show', 'ip', 'nat', 'statistics', 'vrf', VRF],
      'Display NAT statistics in VRF',
      (h, args) => h.vrfExists(args.vrf)
        ? showNATStatistics(h.router())
        : `% VRF ${args.vrf} does not exist.`),
  ];
}
