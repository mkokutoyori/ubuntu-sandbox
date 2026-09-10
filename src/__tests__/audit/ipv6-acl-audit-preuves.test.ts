/*
 * AUDIT — les ACL IPv6. Non-regression des dix-huit constats.
 *
 * Ce fichier a commence comme un banc de mesure ; les constats corriges,
 * il assoit desormais le comportement JUSTE — un echec est une regression.
 *
 * LE CONSTAT QUI DOMINE LES AUTRES (V-01) : la configuration rendue
 * portait la LIAISON `ipv6 traffic-filter BLOQUE in` et JAMAIS la liste
 * `BLOQUE`. Or une configuration rendue est rejouee a l'import d'une
 * topologie, et une liste absente laisse tout passer. Un pare-feu se
 * rechargeait donc en `permit` universel, sans un mot. C'est l'inverse
 * du defaut du commutateur Huawei (S-01), qui gardait une regle
 * fantome : celui-la sur-bloquait, donc se voyait ; celui-ci OUVRE.
 *
 * REFERENCE ATTEINTE, ce qui n'allait pas de soi : le lot precedent
 * (`probe-socle-acl-tetes-deux-plateformes`) a note cisco.com comme
 * bloque par le mandataire de sortie. Il ne l'est plus. Les formes,
 * l'ordre des operandes, la numerotation automatique (10 puis +10), le
 * remplacement sur sequence en double — propre a IPv6, la ou IPv4
 * refuse — et le mnemonique `%IPV6_ACL-6-ACCESSLOGP` sont donc LUS chez
 * le constructeur, non tires de memoire.
 *
 * DISCRIMINATION (`git stash` des sept fichiers du lot) : 19 des 23 cas
 * tombent authentiquement. Les 4 restants sont nommes ici plutot que
 * laisses a decouvrir :
 *   - « une liaison dont la liste a disparu laisse tout passer » est le
 *     TEMOIN de V-01, pas un correctif : il doit passer des deux cotes,
 *     sans quoi il ne dirait pas pourquoi V-01 coute cher ;
 *   - la remarque qui n'ouvre pas la liste etait deja juste ;
 *   - la permission implicite de la decouverte de voisins etait deja
 *     juste, et son `deny` explicite aussi ;
 *   - le filtre pose sur un lien vivant coupait deja le ping — c'est
 *     l'acquis de `ipv6-traffic-filter-really-filters`, dont ce lot ne
 *     refait rien.
 *
 * Reference des identifiants V-xx : AUDIT-ACL-IPV6.md.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { Logger } from '@/network/core/Logger';
import { IPv6Address } from '@/network/core/types';
import type { IPv6Packet } from '@/network/core/types';
import { evaluateIpv6Acl } from '@/network/devices/router/Ipv6AclEngine';
import type { IPv6ACL } from '@/network/devices/Router';

const SRC = '2001:db8::1';
const DST = '2001:db8::2';

async function router(commands: string[]): Promise<{ device: CiscoRouter; out: string[] }> {
  const device = new CiscoRouter('R1');
  device.powerOn();
  const out: string[] = [];
  for (const command of commands) out.push(await device.executeCommand(command));
  return { device, out };
}

function listOf(device: CiscoRouter, name: string): IPv6ACL {
  return device.getIpv6AccessLists().find((a) => a.name === name)!;
}

function tcp6(
  source: string, destination: string, destinationPort: number,
  sourcePort = 1234, flags: Record<string, boolean> = { syn: true },
): IPv6Packet {
  return {
    version: 6, trafficClass: 0, flowLabel: 0, payloadLength: 20,
    nextHeader: 6, hopLimit: 64,
    sourceIP: new IPv6Address(source), destinationIP: new IPv6Address(destination),
    payload: { type: 'tcp', sourcePort, destinationPort, flags },
  } as unknown as IPv6Packet;
}

function icmp6(source: string, destination: string, icmpType: string, code = 0): IPv6Packet {
  return {
    version: 6, trafficClass: 0, flowLabel: 0, payloadLength: 8,
    nextHeader: 58, hopLimit: 64,
    sourceIP: new IPv6Address(source), destinationIP: new IPv6Address(destination),
    payload: { type: 'icmpv6', icmpType, code },
  } as unknown as IPv6Packet;
}

describe('IPv6 access lists — non-regression', () => {

  it('V-01 the running-config renders the LIST, not only its binding', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'ipv6 access-list BLOCK', 'deny icmp any any echo-request', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
      'ipv6 traffic-filter BLOCK in', 'exit', 'exit',
    ]);
    const config = await device.executeCommand('show running-config');
    expect(config).toContain('ipv6 traffic-filter BLOCK in');
    expect(config).toContain('ipv6 access-list BLOCK');
    expect(config).toContain('deny icmp any any echo-request');
    expect(config).toContain('permit ipv6 any any');
  });

  it('V-01 a binding whose list was lost would permit everything', () => {
    expect(evaluateIpv6Acl(undefined, tcp6(SRC, DST, 80))).toBe('permit');
  });

  it('V-02 `established` distinguishes a reply from an opening', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list EST',
      'permit tcp any any established', 'deny ipv6 any any',
    ]);
    const acl = listOf(device, 'EST');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 80, 1, { ack: true }))).toBe('permit');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 80, 1, { syn: true }))).toBe('deny');
  });

  it('V-03 a port given by NAME is evaluated', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list NAMES',
      'deny tcp any any eq telnet', 'permit ipv6 any any',
    ]);
    const acl = listOf(device, 'NAMES');
    expect(acl.entries[0].dstPortSpec).toEqual({ op: 'eq', port: 23 });
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 23))).toBe('deny');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 80))).toBe('permit');
  });

  it('V-04 a SOURCE port is read as a port, not as a destination prefix', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list SRCPORT',
      'deny tcp any eq 80 any', 'permit ipv6 any any',
    ]);
    const acl = listOf(device, 'SRCPORT');
    expect(acl.entries[0].srcPortSpec).toEqual({ op: 'eq', port: 80 });
    expect(acl.entries[0].dstPrefix).toBe('any');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 9999, 80))).toBe('deny');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 9999, 1234))).toBe('permit');
  });

  it('V-05 an unknown token is refused, and nothing is stored', async () => {
    const { device, out } = await router([
      'enable', 'configure terminal', 'ipv6 access-list TYPO',
      'permit tcp any any eq 80 estalbished',
    ]);
    expect(out[3]).toContain('Invalid input');
    expect(listOf(device, 'TYPO').entries).toHaveLength(0);
  });

  it('V-06 dscp / flow-label / fragments / routing / undetermined-transport are kept apart', async () => {
    const { device, out } = await router([
      'enable', 'configure terminal', 'ipv6 access-list QOS',
      'deny ipv6 any any dscp 46',
      'deny ipv6 any any flow-label 7',
      'deny ipv6 any any fragments',
      'deny ipv6 any any routing',
      'deny ipv6 any any undetermined-transport',
    ]);
    expect(out.slice(3).every((o) => o === '')).toBe(true);
    const entries = listOf(device, 'QOS').entries;
    expect(entries[0].dscp).toBe(46);
    expect(entries[1].flowLabel).toBe(7);
    expect(entries[2].fragments).toBe(true);
    expect(entries[3].routing).toBe(true);
    expect(entries[4].undeterminedTransport).toBe(true);
  });

  it('V-06 a dscp rule does not black-hole traffic that does not carry it', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list EF',
      'deny ipv6 any any dscp 46', 'permit ipv6 any any',
    ]);
    expect(evaluateIpv6Acl(listOf(device, 'EF'), tcp6(SRC, DST, 80))).toBe('permit');
  });

  it('V-07 `icmp-type` discriminates a request from a reply', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list ICMP',
      'deny icmp any any echo-request', 'permit ipv6 any any',
    ]);
    const acl = listOf(device, 'ICMP');
    expect(evaluateIpv6Acl(acl, icmp6(SRC, DST, 'echo-request'))).toBe('deny');
    expect(evaluateIpv6Acl(acl, icmp6(SRC, DST, 'echo-reply'))).toBe('permit');
  });

  it('V-08 a port operator other than `eq` is evaluated as itself', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list GT',
      'deny tcp any any gt 1000', 'permit ipv6 any any',
    ]);
    const acl = listOf(device, 'GT');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 2000))).toBe('deny');
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 500))).toBe('permit');
  });

  it('V-09 an entry can be removed, by text and by sequence', async () => {
    const { device, out } = await router([
      'enable', 'configure terminal', 'ipv6 access-list DEL',
      'permit tcp any any eq 22', 'permit udp any any',
      'no permit tcp any any eq 22',
    ]);
    expect(out[5]).toBe('');
    expect(listOf(device, 'DEL').entries).toHaveLength(1);
    expect(await device.executeCommand('no 20')).toBe('');
    expect(listOf(device, 'DEL').entries).toHaveLength(0);
    expect(await device.executeCommand('no 20')).toContain('does not exist');
  });

  it('V-10 VRP refuses `acl ipv6` and names the missing piece', async () => {
    const device = new HuaweiRouter('H1');
    device.powerOn();
    await device.executeCommand('system-view');
    const refusal = await device.executeCommand('acl ipv6 name V6');
    expect(refusal).toContain('not supported');
    expect(refusal).toContain('traffic-filter ipv6');
    expect(device.getIpv6AccessLists()).toHaveLength(0);
    expect(device.getPrompt()).not.toContain('V6');
  });

  it('V-11 evaluation follows the SEQUENCE, not the order typed', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list ORDER',
      'permit tcp any any eq 22 sequence 30',
      'deny ipv6 any any sequence 10',
    ]);
    const acl = listOf(device, 'ORDER');
    expect(acl.entries.map((e) => e.sequence)).toEqual([30, 10]);
    expect(evaluateIpv6Acl(acl, tcp6(SRC, DST, 22))).toBe('deny');
  });

  it('V-11 a duplicate sequence REPLACES the entry, as IOS does for IPv6', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list DUP',
      'deny ipv6 any any sequence 10',
      'permit udp any any sequence 10',
    ]);
    const entries = listOf(device, 'DUP').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('permit');
    expect(entries[0].protocol).toBe('udp');
  });

  it('V-12 a numeric protocol is kept and matched, and eats no operand', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list PROTO',
      'deny 89 any any', 'permit ipv6 any any',
    ]);
    const entry = listOf(device, 'PROTO').entries[0];
    expect(entry.protocol).toBe('89');
    expect(entry.srcPrefix).toBe('any');
    expect(entry.dstPrefix).toBe('any');
  });

  it('V-13 sequences are assigned automatically, first 10 then by 10', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list SEQ',
      'permit tcp any any eq 22', 'permit udp any any', 'deny ipv6 any any',
    ]);
    expect(listOf(device, 'SEQ').entries.map((e) => e.sequence)).toEqual([10, 20, 30]);
  });

  it('V-14 `log` really emits, with IOS\'s own IPv6 facility', async () => {
    const left = new CiscoRouter('RA');
    const right = new CiscoRouter('RB');
    left.powerOn(); right.powerOn();
    new Cable('c1').connect(left.getPort('GigabitEthernet0/0')!, right.getPort('GigabitEthernet0/0')!);
    const configure = async (device: CiscoRouter, lines: string[]) => {
      for (const command of ['enable', 'configure terminal', 'ipv6 unicast-routing', ...lines, 'end']) {
        await device.executeCommand(command);
      }
    };
    await configure(left, ['interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit']);
    await configure(right, [
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit',
      'ipv6 access-list LOGGED', 'deny icmp any any echo-request log', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter LOGGED in', 'exit',
    ]);

    const seen: string[] = [];
    Logger.subscribe((entry: { event?: string; message?: string }) => {
      if (entry.event === 'router:ipv6-acl-log') seen.push(String(entry.message));
    });
    await left.executeCommand('ping ipv6 2001:db8:1::2');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('list LOGGED denied icmp');
    const syslog = await right.executeCommand('show logging');
    expect(syslog).toContain('%IPV6_ACL-6-ACCESSLOGP');
    expect(syslog).not.toContain('%SEC-4-IPACCESSLOGP');
  }, 30000);

  it('V-15 `show ipv6 access-list` renders matches, sequence and the port name', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list SHOWN',
      'permit tcp any any eq 179', 'exit', 'exit',
    ]);
    const acl = listOf(device, 'SHOWN');
    evaluateIpv6Acl(acl, tcp6(SRC, DST, 179));
    evaluateIpv6Acl(acl, tcp6(SRC, DST, 179));
    const shown = await device.executeCommand('show ipv6 access-list');
    expect(shown).toContain('IPv6 access list SHOWN');
    expect(shown).toContain('permit tcp any any eq bgp (2 matches) sequence 10');
  });

  it('V-16 a malformed port or sequence is refused rather than stored', async () => {
    const { device, out } = await router([
      'enable', 'configure terminal', 'ipv6 access-list BAD',
      'permit tcp any any eq 99999',
      'permit ipv6 any any sequence zorglub',
      'permit tcp any any eq',
    ]);
    expect(out[3]).toContain('Invalid input');
    expect(out[4]).toContain('Invalid input');
    expect(out[5]).toContain('Incomplete');
    expect(listOf(device, 'BAD').entries).toHaveLength(0);
  });

  it('V-17 an entry with no protocol is refused', async () => {
    const { device, out } = await router([
      'enable', 'configure terminal', 'ipv6 access-list NOPROTO', 'permit any any',
    ]);
    expect(out[3]).toContain('Invalid input');
    expect(listOf(device, 'NOPROTO').entries).toHaveLength(0);
  });

  it('a remark does not open the list, and is rendered as a remark', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list MIX',
      'remark guest policy', 'exit', 'exit',
    ]);
    expect(evaluateIpv6Acl(listOf(device, 'MIX'), tcp6(SRC, DST, 80))).toBe('deny');
    expect(await device.executeCommand('show ipv6 access-list')).toContain('remark guest policy');
  });

  it('Neighbor Discovery is permitted implicitly, and an explicit deny still wins', async () => {
    const { device } = await router([
      'enable', 'configure terminal', 'ipv6 access-list NDP', 'permit tcp any any eq 22',
    ]);
    expect(evaluateIpv6Acl(listOf(device, 'NDP'), icmp6(SRC, DST, 'neighbor-solicitation'))).toBe('permit');

    const { device: strict } = await router([
      'enable', 'configure terminal', 'ipv6 access-list SHUT', 'deny ipv6 any any',
    ]);
    expect(evaluateIpv6Acl(listOf(strict, 'SHUT'), icmp6(SRC, DST, 'neighbor-solicitation'))).toBe('deny');
  });

  it('a filter applied to a live link really drops the ping', async () => {
    const left = new CiscoRouter('RA');
    const right = new CiscoRouter('RB');
    left.powerOn(); right.powerOn();
    new Cable('c2').connect(left.getPort('GigabitEthernet0/0')!, right.getPort('GigabitEthernet0/0')!);
    const configure = async (device: CiscoRouter, lines: string[]) => {
      for (const command of ['enable', 'configure terminal', 'ipv6 unicast-routing', ...lines, 'end']) {
        await device.executeCommand(command);
      }
    };
    await configure(left, ['interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit']);
    await configure(right, ['interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit']);
    expect(await left.executeCommand('ping ipv6 2001:db8:1::2')).toContain('100 percent');

    await configure(right, [
      'ipv6 access-list DROP', 'deny icmp any any echo-request', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter DROP in', 'exit',
    ]);
    expect(await left.executeCommand('ping ipv6 2001:db8:1::2')).toContain('0 percent');
  }, 30000);
});
