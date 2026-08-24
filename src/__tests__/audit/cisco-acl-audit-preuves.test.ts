/**
 * AUDIT ACL CISCO — non-régression des dix-neuf constats.
 *
 * Ce fichier a commencé comme un banc de preuves : chaque test y assoyait
 * le comportement FAUTIF, pour que le rapport repose sur une mesure et
 * non sur une lecture. Les dix-neuf constats ayant été corrigés, il a
 * changé de nature — **chaque test assoit désormais le comportement
 * JUSTE, et un échec est une régression.**
 *
 * La règle qui les unit, et qu'il faut tenir : *un critère que le moteur
 * ne sait pas trancher fait échouer la correspondance.* Jamais réussir,
 * jamais « sauter le critère ». Un nouveau critère d'ACE se teste dans
 * les deux sens : il correspond quand il doit, et il ne correspond pas
 * quand on ne peut pas le vérifier.
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

function icmpPkt(src: string, dst: string, icmpType: string, code?: number): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 28,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'icmp', icmpType, code },
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
describe('ACL Cisco — non-régression des constats d\'audit', () => {

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

  it('F-07 une ACL étendue en access-class ne plante plus', () => {
    const r = new CiscoRouter('R');
    r.addNamedAccessListEntry('MGMT', 'extended', 'permit', {
      protocol: 'ip',
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
    });
    const ev = (r as unknown as { evaluateAclPermit(a: string, s: string): boolean });
    expect(() => ev.evaluateAclPermit('MGMT', '10.0.0.5')).not.toThrow();
    expect(ev.evaluateAclPermit('MGMT', '10.0.0.5')).toBe(true);
    expect(ev.evaluateAclPermit('MGMT', '192.168.1.5')).toBe(false);
  });

  it('F-15 ré-entrer dans une ACL IPv6 l\'ouvre en ajout', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ipv6 access-list V6', 'deny icmp any any', 'permit ipv6 any any', 'exit',
    ]);
    expect(r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length).toBe(2);
    await cfg(r, ['ipv6 access-list V6']);
    expect(r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length).toBe(2);
    // et l'ajout se poursuit à la suite
    await cfg(r, ['deny tcp any any']);
    expect(r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length).toBe(3);
  });

  it('F-16 un jeton inconnu est refusé, et rien n\'est enregistré', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended TYPO',
      'permit tcp any any eq 80 estalbished',
    ]);
    expect(out[3]).toContain('Invalid input');
    // La liste existe (creee a l'entree en mode, cf. F-13) mais l'ACE
    // fautive n'y a PAS ete enregistree.
    expect(r.getAccessLists().find(a => a.name === 'TYPO')?.entries.length).toBe(0);
  });

  it('F-16 une ACE correcte reste acceptée', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended OK',
      'permit tcp any any eq 80 established log',
      'deny icmp any any echo log-input',
    ]);
    expect(out[3]).toBe('');
    expect(out[4]).toBe('');
    expect(r.getAccessLists().find(a => a.name === 'OK')?.entries.length).toBe(2);
  });

  it('F-05 le code ICMP distingue enfin les variantes d\'unreachable', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Y', 'extended', 'deny', {
      protocol: 'icmp', ...ANY(), icmpType: 'host-unreachable',
    });
    e.addNamedAccessListEntry('Y', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    // code 1 = host-unreachable -> refuse
    expect(e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable', 1))).toBe('deny');
    // code 3 = port-unreachable -> ne correspond plus
    expect(e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable', 3))).toBe('permit');
  });

  it('F-05 `unreachable` nu couvre toujours toutes les variantes', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('U', 'extended', 'deny', {
      protocol: 'icmp', ...ANY(), icmpType: 'unreachable',
    });
    for (const code of [0, 1, 3, 13]) {
      expect(e.evaluateACL('U', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable', code))).toBe('deny');
    }
  });

  it('F-08 les quatre plages IOS sont acceptees, et un numero hors plage recoit le refus d IOS', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'access-list 1500 permit host 10.0.0.1',
      'access-list 2500 permit ip any any',
      'access-list 3000 permit ip any any',
    ]);
    expect(out[2]).toBe('');
    expect(out[3]).toBe('');
    expect(r.getAccessLists().find(a => a.id === 1500)?.type).toBe('standard');
    expect(r.getAccessLists().find(a => a.id === 2500)?.type).toBe('extended');
    const refus = out[4].split('\n');
    expect(refus[0]).toMatch(/^ +\^$/);
    expect(refus[1]).toBe("% Invalid input detected at '^' marker.");
    expect(r.getAccessLists().some(a => a.id === 3000)).toBe(false);
  });

  it('F-11 la sequence auto est « dernier + 10 », comme IOS', () => {
    const e = new ACLEngine();
    const mk = (seq?: number) => e.addNamedAccessListEntry('S', 'standard', 'permit', {
      sequence: seq, srcIP: new IPAddress('1.1.1.1'), srcWildcard: new SubnetMask('0.0.0.0'),
    });
    mk(15); mk();
    expect(e.findByName('S')!.entries.map(x => x.sequence)).toEqual([15, 25]);
  });

  it('F-12 un numero de sequence deja pris est refuse', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended D',
      'sequence 10 permit ip any any',
      'sequence 10 deny ip any any',
    ]);
    expect(out[4]).toContain('Duplicate sequence number');
    expect(r.getAccessLists().find(a => a.name === 'D')?.entries.length).toBe(1);
  });

  it('F-13 une ACL nommee vide figure dans running-config', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'ip access-list extended EMPTY', 'exit', 'exit']);
    expect(await r.executeCommand('show running-config')).toContain('ip access-list extended EMPTY');
  });

  it('F-19 le show d\'une ACL standard rend l\'IP nue', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'access-list 1 permit host 10.0.0.1', 'exit']);
    const show = await r.executeCommand('show access-lists');
    expect(show).toContain('permit 10.0.0.1');
    expect(show).not.toContain('host 10.0.0.1');
  });

  it('F-17 `log` emet un IPACCESSLOGP, et son absence n\'emet rien', async () => {
    const mk = async (ace: string) => {
      const r = new CiscoRouter('R');
      await cfg(r, [
        'enable', 'configure terminal',
        `access-list 100 ${ace}`,
        'logging buffered 8000 debugging', 'end',
      ]);
      r.evaluateACLByName('100', tcpPkt('10.0.0.1', '10.0.0.2', 22));
      return r.executeCommand('show logging');
    };
    expect(await mk('deny tcp any any eq 22 log')).toMatch(/IPACCESSLOGP: list 100 denied tcp/);
    expect(await mk('deny tcp any any eq 22')).not.toContain('IPACCESSLOGP');
  });

  it('F-14 "no permit ..." supprime l\'ACE decrite', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended T',
      'permit tcp any any eq 80',
      'permit tcp any any eq 443',
      'no permit tcp any any eq 80',
    ]);
    expect(out[5]).toBe('');
    const acl = r.getAccessLists().find(a => a.name === 'T')!;
    expect(acl.entries.length).toBe(1);
    expect(acl.entries[0].dstPortSpec?.port).toBe(443);
  });

  it('F-14 supprimer une ACE absente le dit, au lieu de "Incomplete"', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended T',
      'permit tcp any any eq 80',
      'no permit udp any any eq 53',
    ]);
    expect(out[4]).toContain('does not exist');
    expect(r.getAccessLists().find(a => a.name === 'T')?.entries.length).toBe(1);
  });

  it('F-14 la suppression par numero de sequence marche toujours', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list standard S',
      'permit host 10.0.0.1',
      'no 10',
    ]);
    expect(r.getAccessLists().find(a => a.name === 'S')?.entries.length).toBe(0);
  });

  it('§8.3 `option <name>` est un critere non verifiable : il ne correspond pas', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('O', 'extended', 'permit', {
      protocol: 'ip', ...ANY(), optionName: 'any-options',
    });
    e.addNamedAccessListEntry('O', 'extended', 'deny', { protocol: 'ip', ...ANY() });
    // `IPv4Packet` ne modelise aucune option d'en-tete : le permit ne peut
    // pas s'appliquer, et la liste retombe sur le deny.
    expect(e.evaluateACL('O', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('deny');
  });

  it('§7.4 observer une ACL ne la fait plus compter', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('C', 'extended', 'permit', { protocol: 'ip', ...ANY() });
    const pkt = tcpPkt('1.1.1.1', '2.2.2.2', 80);
    e.evaluateACL('C', pkt, new Date(), false);
    expect(e.findByName('C')!.entries[0].matchCount).toBe(0);
    e.evaluateACL('C', pkt);
    expect(e.findByName('C')!.entries[0].matchCount).toBe(1);
  });

  it('F-01 rayon de souffle : les VACL de commutateur héritent du correctif', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('SW', 'extended', 'permit', { protocol: 'ip', ...ANY(), remark: 'politique de port' });
    e.addNamedAccessListEntry('SW', 'extended', 'deny', { protocol: 'ip', ...ANY() });
    expect(e.evaluateACL('SW', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('deny');
  });
});
