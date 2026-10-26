import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';
import { isValidIPv4 } from '@/network/core/ip';
import { IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';
import { vrfNamed, words, type NatHost } from './natHost';

const EXEC: readonly string[] = Object.freeze(['privileged']);

const FILTER = (description: string): ArgumentSpec =>
  ({ name: 'filtre', type: 'REST', optional: true, description });

const FLOW = (): ArgumentSpec => ({
  name: 'traduction', type: 'REST',
  description: 'Local address and port, then global address and port',
});

function vrfRefusal(host: NatHost, tokens: readonly string[]): string | null {
  const at = tokens.findIndex(token => token.toLowerCase() === 'vrf');
  if (at < 0) return null;
  const name = tokens[at + 1];
  if (!name) return '% Missing VRF name.';
  return host.vrfExists(name) ? null : `% VRF ${name} does not exist.`;
}

function clearFlow(host: NatHost, protocol: 'tcp' | 'udp', tokens: string[]): string {
  if (tokens.length === 1 && tokens[0] === '*') {
    host.engine().clearTranslations();
    return '';
  }
  if (tokens.length < 4) return '% Incomplete command.';
  if (tokens.some(token => /\*/.test(token) && token !== '*')) {
    return `% Invalid wildcard syntax for clear ip nat translation ${protocol}.`;
  }
  if (tokens.some(token => token === '*')) return '% Invalid mixed wildcard syntax.';
  for (let at = 0; at < tokens.length; at++) {
    if (at % 2 === 0 && !isValidIPv4(tokens[at])) return `% Invalid IP address ${tokens[at]}.`;
    if (at % 2 === 1) {
      const port = parseInt(tokens[at], 10);
      if (isNaN(port) || port < 1 || port > 65535) return `% Invalid port number ${tokens[at]}.`;
    }
  }
  host.engine().clearTranslation(
    protocol === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP, tokens[2], parseInt(tokens[3], 10));
  return '';
}

export function natClearFamily(host: () => NatHost): CommandSpec[] {
  const spec = (
    id: string, path: readonly (string | ArgumentSpec)[], description: string,
    run: (h: NatHost, tokens: string[]) => string, argument?: ArgumentSpec,
  ): CommandSpec => ({
    id: `clear-ip-nat-${id}`,
    path: [...path],
    description, modes: EXEC, minPrivilege: 15,
    run: (_session, args) => run(host(), argument ? words(args[argument.name]) : []),
  });

  const filtered = (direction: 'inside' | 'outside'): CommandSpec => {
    const argument = FILTER(direction === 'inside'
      ? 'Inside local address, or `vrf` then its name'
      : 'Outside global address, or `vrf` then its name');
    return spec(direction, ['clear', 'ip', 'nat', 'translation', direction, argument],
      `Clear ${direction} NAT translation entries`,
      (h, tokens) => {
        const refusal = vrfRefusal(h, tokens);
        if (refusal) return refusal;
        const address = tokens[0];
        if (address && isValidIPv4(address)) {
          const vrf = vrfNamed(tokens);
          h.engine().clearTranslationsFiltered({
            ...(direction === 'inside' ? { insideIP: address } : { outsideIP: address }),
            ifaces: vrf ? h.vrfInterfaces(vrf) : undefined,
          });
        } else {
          h.engine().clearTranslations();
        }
        return '';
      }, argument);
  };

  const flow = (protocol: 'tcp' | 'udp'): CommandSpec => {
    const argument = FLOW();
    return spec(protocol, ['clear', 'ip', 'nat', 'translation', protocol, argument],
      `Clear ${protocol.toUpperCase()} NAT translation entries`,
      (h, tokens) => clearFlow(h, protocol, tokens), argument);
  };

  const vrfName: ArgumentSpec = { name: 'nom', type: 'WORD', description: 'VRF name' };
  const poolName: ArgumentSpec = { name: 'nom', type: 'WORD', description: 'Pool name' };

  return [
    spec('all', ['clear', 'ip', 'nat', 'translation', '*'],
      'Clear all dynamic NAT translations',
      (h) => { h.engine().clearTranslations(); return ''; }),
    filtered('inside'),
    filtered('outside'),
    flow('tcp'),
    flow('udp'),
    spec('vrf', ['clear', 'ip', 'nat', 'translation', 'vrf', vrfName],
      'Clear NAT translations in VRF',
      (h, tokens) => {
        const interfaces = h.vrfInterfaces(tokens[0]);
        if (!h.vrfExists(tokens[0]) || !interfaces) return `% VRF ${tokens[0]} does not exist.`;
        h.engine().clearTranslationsFiltered({ ifaces: interfaces });
        return '';
      }, vrfName),
    spec('pool', ['clear', 'ip', 'nat', 'translation', 'pool', poolName],
      'Clear NAT translations for pool',
      (h, tokens) => {
        if (!h.engine().getPool(tokens[0])) return `% Pool ${tokens[0]} does not exist.`;
        h.engine().clearTranslationsFiltered({ poolName: tokens[0] });
        return '';
      }, poolName),
    spec('statistics', ['clear', 'ip', 'nat', 'statistics'],
      'Clear NAT statistics counters',
      (h) => { h.engine().resetCounters(); return ''; }),
  ];
}
