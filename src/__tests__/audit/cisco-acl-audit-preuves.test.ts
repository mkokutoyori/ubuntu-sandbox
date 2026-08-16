/**
 * AUDIT ACL CISCO — banc de preuves.
 *
 * Deux blocs, deux régimes de lecture :
 *
 *   1. « PALIER 0 — CORRIGÉ » assoit le comportement JUSTE. Ce sont de
 *      vrais tests de non-régression : un échec est une régression.
 *
 *   2. « CONSTATS OUVERTS » assoit le comportement ACTUEL, donc fautif,
 *      des constats non encore traités (paliers 1 à 3). Un test qui
 *      PASSE = un défaut TOUJOURS PRÉSENT ; un test qui ÉCHOUE signale
 *      une correction : le déplacer vers le bloc 1 et rayer la ligne
 *      correspondante du rapport.
 *
 * Référence des identifiants F-xx : AUDIT-ACL-CISCO.md, tableau §3.
 */
import { describe, it, expect } from 'vitest';
import {
  IPAddress, SubnetMask, IPv4Packet,
  IP_PROTO_TCP, IP_PROTO_ICMP,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { ACLEngine } from '@/network/devices/router/ACLEngine';

async function cfg(r: CiscoRouter, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await r.executeCommand(c));
  return out;
}

const ANY = () => ({
  srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
  dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
});

function tcpPkt(src: string, dst: string, dport: number, flags?: Record<string, boolean>): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 40,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'tcp', sourcePort: 12345, destinationPort: dport, flags: flags ?? { syn: true } },
  } as unknown as IPv4Packet;
}

function icmpPkt(src: string, dst: string, icmpType: string): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 28,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'icmp', icmpType },
  } as unknown as IPv4Packet;
}

/** Un paquet TCP sans objet de couche 4 — le cas qui ouvrait les critères de port. */
function tcpPktSansL4(src: string, dst: string): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 20,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
  } as unknown as IPv4Packet;
}

// ════════════════════════════════════════════════════════════════════
describe('PALIER 0 — CORRIGÉ (non-régression)', () => {

  it('F-01 un remark ne filtre rien : la liste garde son sens', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended BLOCK',
      'remark bloque le VLAN invite',
      'deny ip 10.0.0.0 0.0.0.255 any',
      'permit ip any any',
    ]);
    expect(r.evaluateACLByName('BLOCK', tcpPkt('10.0.0.5', '8.8.8.8', 80))).toBe('deny');
    // et le reste du trafic passe toujours
    expect(r.evaluateACLByName('BLOCK', tcpPkt('192.168.1.5', '8.8.8.8', 80))).toBe('permit');
  });

  it('F-18 le remark reste rendu par show, mais sans compteur', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended CNT', 'remark hello', 'deny ip any any', 'exit', 'exit',
    ]);
    r.evaluateACLByName('CNT', tcpPkt('1.1.1.1', '2.2.2.2', 80));
    const show = await r.executeCommand('show access-lists');
    expect(show).toContain('remark hello');
    expect(show).not.toMatch(/remark hello \(\d+ match/);
  });

  it('F-02 evaluate sans table de sessions échoue fermé', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended OUT',
      'evaluate MIRROR',
      'deny ip any any',
    ]);
    expect(r.evaluateACLByName('OUT', tcpPkt('1.2.3.4', '5.6.7.8', 80))).toBe('deny');
  });

  it('F-03 match-any n\'attrape que les paquets portant le drapeau', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended FLAGS',
      'deny tcp any any match-any rst',
      'permit ip any any',
    ]);
    expect(r.evaluateACLByName('FLAGS', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true }))).toBe('permit');
    expect(r.evaluateACLByName('FLAGS', tcpPkt('1.1.1.1', '2.2.2.2', 80, { rst: true }))).toBe('deny');
  });

  it('F-03 match-all exige tous les drapeaux, et honore les préfixes + / -', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended SYNONLY',
      'permit tcp any any match-all +syn -ack',
      'deny ip any any',
    ]);
    // SYN seul → passe
    expect(r.evaluateACLByName('SYNONLY', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true, ack: false }))).toBe('permit');
    // SYN+ACK → la seconde condition tombe
    expect(r.evaluateACLByName('SYNONLY', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true, ack: true }))).toBe('deny');
    // ACK seul → la première condition tombe
    expect(r.evaluateACLByName('SYNONLY', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: false, ack: true }))).toBe('deny');
  });

  it('F-03 le mode match-all survit à show / running-config', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended M', 'permit tcp any any match-all +syn -ack', 'exit', 'exit',
    ]);
    expect(await r.executeCommand('show access-lists')).toContain('match-all +syn -ack');
  });

  it('F-03 un nom de drapeau inconnu ne correspond à rien', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('F', 'extended', 'permit', {
      protocol: 'tcp', ...ANY(), tcpFlags: ['flurb'], tcpFlagsMatch: 'any',
    });
    expect(e.evaluateACL('F', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('deny');
  });

  it('F-04 un mot-clé ICMP non évaluable ne correspond à rien', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('X', 'extended', 'deny', {
      protocol: 'icmp', ...ANY(), icmpType: 'administratively-prohibited',
    });
    e.addNamedAccessListEntry('X', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    expect(e.evaluateACL('X', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'))).toBe('permit');
  });

  it('F-04 un mot-clé ICMP connu discrimine toujours correctement', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Y', 'extended', 'deny', {
      protocol: 'icmp', ...ANY(), icmpType: 'echo',
    });
    e.addNamedAccessListEntry('Y', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    expect(e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'))).toBe('deny');
    expect(e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-reply'))).toBe('permit');
  });

  it('F-06 un mot-clé DSCP inconnu ne correspond à rien', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Z', 'extended', 'deny', { protocol: 'ip', ...ANY(), dscp: 'af99' });
    e.addNamedAccessListEntry('Z', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    expect(e.evaluateACL('Z', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('permit');
  });

  it('F-06 un DSCP connu discrimine toujours correctement', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('D', 'extended', 'deny', { protocol: 'ip', ...ANY(), dscp: 'ef' });
    e.addNamedAccessListEntry('D', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    const ef = { ...tcpPkt('1.1.1.1', '2.2.2.2', 80), tos: 46 << 2 } as IPv4Packet;
    expect(e.evaluateACL('D', ef)).toBe('deny');
    expect(e.evaluateACL('D', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('permit');
  });

  it('F-09 sur Cisco, 2000-2699 est ÉTENDUE et ses critères sont évalués', () => {
    const e = new ACLEngine();
    e.addAccessListEntry(2500, 'permit', {
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      dstIP: new IPAddress('192.168.1.1'), dstWildcard: new SubnetMask('0.0.0.0'),
      protocol: 'tcp', dstPortSpec: { op: 'eq', port: 22 },
    });
    expect(e.findById(2500)?.type).toBe('extended');
    // destination et port ne correspondent pas → la règle ne s'applique pas
    expect(e.evaluateACL(2500, tcpPkt('10.0.0.5', '8.8.8.8', 443))).toBe('deny');
    // tout correspond → la règle s'applique
    expect(e.evaluateACL(2500, tcpPkt('10.0.0.5', '192.168.1.1', 22))).toBe('permit');
  });

  it('F-09 1300-1999 est STANDARD sur Cisco', () => {
    const e = new ACLEngine();
    e.addAccessListEntry(1500, 'permit', {
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
    });
    expect(e.findById(1500)?.type).toBe('standard');
  });

  it('F-09 VRP garde sa numérotation : 2000-2999 reste « basic »', () => {
    const h = new HuaweiRouter('AR1');
    h.addAccessListEntry(2000, 'permit', {
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
    });
    h.addAccessListEntry(3000, 'permit', {
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
      protocol: 'ip',
    });
    expect(h.getAccessLists().find(a => a.id === 2000)?.type).toBe('standard');
    expect(h.getAccessLists().find(a => a.id === 3000)?.type).toBe('extended');
  });

  it('F-10 un critère de port sans couche 4 ne correspond pas', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('P', 'extended', 'permit', {
      protocol: 'tcp', ...ANY(), dstPortSpec: { op: 'eq', port: 22 },
    });
    expect(e.evaluateACL('P', tcpPktSansL4('1.1.1.1', '2.2.2.2'))).toBe('deny');
    expect(e.evaluateACL('P', tcpPkt('1.1.1.1', '2.2.2.2', 22))).toBe('permit');
    expect(e.evaluateACL('P', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('deny');
  });

  it('F-10 une ACE SANS critère de port correspond quand même sans couche 4', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Q', 'extended', 'permit', { protocol: 'tcp', ...ANY() });
    expect(e.evaluateACL('Q', tcpPktSansL4('1.1.1.1', '2.2.2.2'))).toBe('permit');
  });

  it('F-01 rayon de souffle : les VACL de commutateur héritent du correctif', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('SW', 'extended', 'permit', { protocol: 'ip', ...ANY(), remark: 'politique de port' });
    e.addNamedAccessListEntry('SW', 'extended', 'deny', { protocol: 'ip', ...ANY() });
    expect(e.evaluateACL('SW', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('deny');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('CONSTATS OUVERTS (paliers 1 à 3)', () => {

  it('F-07 [ouvert] ACL étendue + sonde source seule → TypeError', () => {
    const r = new CiscoRouter('R');
    r.addNamedAccessListEntry('MGMT', 'extended', 'permit', {
      protocol: 'ip',
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
    });
    let err: unknown = null;
    try {
      (r as unknown as { evaluateAclPermit(a: string, s: string): boolean })
        .evaluateAclPermit('MGMT', '10.0.0.5');
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
  });

  it('F-05 [ouvert] icmpCode jamais évalué → unreachable confondus', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Y', 'extended', 'deny', {
      protocol: 'icmp', ...ANY(), icmpType: 'host-unreachable',
    });
    expect(e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable'))).toBe('deny');
  });

  it('F-08 [ouvert] le CLI refuse 1300-1999 et 2000-2699', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'access-list 1500 permit host 10.0.0.1',
      'access-list 2500 permit ip any any',
    ]);
    expect(out[2]).toContain('Invalid');
    expect(out[3]).toContain('Invalid');
  });

  it('F-11 [ouvert] séquence auto ≠ dernier + 10', () => {
    const e = new ACLEngine();
    const mk = (seq?: number) => e.addNamedAccessListEntry('S', 'standard', 'permit', {
      sequence: seq, srcIP: new IPAddress('1.1.1.1'), srcWildcard: new SubnetMask('0.0.0.0'),
    });
    mk(15);
    mk(); // IOS → 25
    expect(e.findByName('S')!.entries.map(x => x.sequence)).toEqual([15, 20]);
  });

  it('F-12 [ouvert] numéros de séquence dupliqués acceptés', () => {
    const e = new ACLEngine();
    for (const a of ['permit', 'deny'] as const) {
      e.addNamedAccessListEntry('D', 'standard', a, {
        sequence: 10, srcIP: new IPAddress('1.1.1.1'), srcWildcard: new SubnetMask('0.0.0.0'),
      });
    }
    expect(e.findByName('D')!.entries.length).toBe(2);
  });

  it('F-13 [ouvert] ACL nommée vide absente de running-config', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'ip access-list extended EMPTY', 'exit', 'exit']);
    expect((await r.executeCommand('show running-config')).includes('EMPTY')).toBe(false);
  });

  it('F-14 [ouvert] "no permit ..." non géré', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended T',
      'permit tcp any any eq 80',
      'no permit tcp any any eq 80',
    ]);
    expect(r.getAccessLists().find(a => a.name === 'T')?.entries.length).toBe(1);
  });

  it('F-15 [ouvert] re-entrer ipv6 access-list efface les règles', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ipv6 access-list V6', 'deny icmp any any', 'permit ipv6 any any', 'exit',
    ]);
    expect(r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length).toBe(2);
    await cfg(r, ['ipv6 access-list V6']);
    expect(r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length).toBe(0);
  });

  it('F-16 [ouvert] jetons inconnus avalés en silence', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended TYPO',
      'permit tcp any any eq 80 estalbished',
    ]);
    expect(out[3]).toBe('');
  });

  it('F-17 [ouvert] log / log-input n\'émettent jamais rien', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended L', 'deny ip any any log', 'exit', 'exit',
    ]);
    // le mot-clé survit à l'affichage — c'est tout ce qu'il fait
    expect(await r.executeCommand('show access-lists')).toContain('log');
  });

  it('F-19 [ouvert] ACL standard affiche "host X" au lieu de l\'IP nue', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'access-list 1 permit host 10.0.0.1', 'exit']);
    expect(await r.executeCommand('show access-lists')).toContain('host 10.0.0.1');
  });
});
