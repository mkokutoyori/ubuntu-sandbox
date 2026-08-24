/**
 * AUDIT — les ACL du COMMUTATEUR Cisco. Non-régression des neuf constats.
 *
 * Ce fichier a commencé comme un banc de preuves ; les constats corrigés,
 * il assoit désormais le comportement JUSTE — un échec est une régression.
 *
 * **Le constat unique dont les neuf découlaient : DEUX magasins.** Un écho
 * verbatim du texte tapé, affiché par `show access-lists`, et les entrées
 * du moteur, qui seules filtrent. Ils divergeaient de partout, et la plus
 * grave divergence était muette : `no deny tcp any any` disparaissait de
 * la vue et la règle continuait de refuser.
 *
 * Le commutateur partage désormais l'analyse (`parseCiscoAce`) et le rendu
 * (`showAccessListsFrom`) du routeur : les deux plateformes ne peuvent
 * plus répondre différemment à la même question.
 *
 * Référence des identifiants C-xx : AUDIT-ACL-CISCO-SWITCH.md.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv4Packet, IP_PROTO_ICMP, IP_PROTO_TCP } from '@/network/core/types';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

async function sw(cmds: string[]): Promise<{ s: CiscoSwitch; out: string[] }> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const out: string[] = [];
  for (const c of cmds) out.push(await s.executeCommand(c));
  return { s, out };
}

function tcpPkt(src: string, dst: string, dport: number, flags?: Record<string, boolean>): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 40,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'tcp', sourcePort: 1234, destinationPort: dport, flags: flags ?? { syn: true } },
  } as unknown as IPv4Packet;
}

function icmpPkt(src: string, dst: string, icmpType: string, code = 0): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 28,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'icmp', icmpType, code },
  } as unknown as IPv4Packet;
}

describe('ACL du commutateur Cisco — non-régression', () => {

  it('C-01 `no deny ...` supprime la règle du MOTEUR', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended BLOCK',
      'deny tcp any any',
      'permit ip any any',
      'no deny tcp any any',
    ]);
    expect(out[5]).toBe('');
    const e = s.getVaclEngine();
    expect(e.evaluateACLByName('BLOCK', tcpPkt('1.1.1.1', '2.2.2.2', 22))).toBe('permit');
    expect(e.findByName('BLOCK')!.entries.length).toBe(1);
  });

  it('C-01 `no <sequence>` et une ACE absente se disent', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended B2',
      'deny ip any any',
      'no 10',
      'no deny udp any any',
    ]);
    expect(out[4]).toBe('');
    expect(s.getVaclEngine().findByName('B2')!.entries.length).toBe(0);
    expect(out[5]).toContain('does not exist');
  });

  it('C-02 `show access-lists` lit le TYPE de la liste, pas « est-ce un nombre »', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'access-list 100 permit ip any any',
      'access-list 10 permit host 10.0.0.1', 'exit',
    ]);
    const d = await s.executeCommand('show access-lists');
    expect(d).toContain('Extended IP access list 100');
    expect(d).toContain('Standard IP access list 10');
  });

  it('C-02 un numéro hors des quatre plages IOS reçoit le refus d\'IOS', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'access-list 3000 permit ip any any',
    ]);
    const refus = out[2].split('\n');
    expect(refus[0]).toMatch(/^ +\^$/);
    expect(refus[1]).toBe("% Invalid input detected at '^' marker.");
    expect(s.getVaclEngine().getAccessLists().some(a => a.id === 3000)).toBe(false);
  });

  it('C-03 une entrée numérotée atteint le moteur, forme nue comprise', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended SEQ',
      '10 deny ip any any',
      '20 permit ip any any',
    ]);
    expect(out[3]).toBe('');
    expect(out[4]).toBe('');
    expect(s.getVaclEngine().findByName('SEQ')!.entries.map(e => e.sequence)).toEqual([10, 20]);
  });

  it('C-04 les critères de PORT sont évalués', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended PORTS',
      'deny tcp any any eq 22',
      'permit ip any any',
    ]);
    const e = s.getVaclEngine();
    expect(e.evaluateACLByName('PORTS', tcpPkt('1.1.1.1', '2.2.2.2', 22))).toBe('deny');
    expect(e.evaluateACLByName('PORTS', tcpPkt('1.1.1.1', '2.2.2.2', 80))).toBe('permit');
    expect(e.findByName('PORTS')!.entries[0].dstPortSpec).toEqual({ op: 'eq', port: 22 });
  });

  it('C-05 `icmp-type` et `established` sont évalués', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended DIVERS',
      'deny icmp any any echo',
      'permit ip any any',
    ]);
    const e = s.getVaclEngine();
    expect(e.evaluateACLByName('DIVERS', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'))).toBe('deny');
    expect(e.evaluateACLByName('DIVERS', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-reply'))).toBe('permit');
  });

  it('C-05 `established` distingue une réponse d\'une ouverture', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended EST',
      'permit tcp any any established',
      'deny ip any any',
    ]);
    const e = s.getVaclEngine();
    expect(e.evaluateACLByName('EST', tcpPkt('1.1.1.1', '2.2.2.2', 80, { ack: true }))).toBe('permit');
    expect(e.evaluateACLByName('EST', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true }))).toBe('deny');
  });

  it('C-06 un jeton inconnu est refusé, et rien n\'est enregistré', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended TYPO',
      'permit tcp any any eq 80 estalbished',
    ]);
    expect(out[3]).toContain('Invalid input');
    expect(s.getVaclEngine().findByName('TYPO')!.entries.length).toBe(0);
  });

  it('C-07 `ip access-list standard` sans nom est refusé', async () => {
    const { s, out } = await sw([
      'enable', 'configure terminal',
      'ip access-list standard',
    ]);
    expect(out[2]).toContain('Incomplete');
    expect(s.getVaclEngine().getAccessListsInternal().length).toBe(0);
  });

  it('C-07 un type inconnu est refusé', async () => {
    const { out } = await sw([
      'enable', 'configure terminal',
      'ip access-list bidon NOM',
    ]);
    expect(out[2]).toContain('Invalid input');
  });

  it('C-08 un `remark` est rendu comme remarque et ne filtre rien', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended MIX',
      'remark politique invites',
      'deny ip 10.0.0.0 0.0.0.255 any',
      'permit ip any any', 'exit', 'exit',
    ]);
    const d = await s.executeCommand('show access-lists');
    expect(d).toContain('remark politique invites');
    expect(d).not.toContain('no deny');
    // la remarque n'ouvre pas la liste (constat F-01 du rapport routeur)
    expect(s.getVaclEngine().evaluateACLByName('MIX', tcpPkt('10.0.0.5', '8.8.8.8', 80))).toBe('deny');
  });

  it('C-09 la vue et le moteur décrivent la MÊME règle', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended DIV',
      'permit tcp any any eq 443', 'exit', 'exit',
    ]);
    const d = await s.executeCommand('show access-lists');
    const e = s.getVaclEngine().findByName('DIV')!.entries[0];
    expect(d).toContain('eq 443');
    expect(e.dstPortSpec).toEqual({ op: 'eq', port: 443 });
  });

  it('C-09 `show access-lists <nom>` filtre, et le compteur est celui du moteur', async () => {
    const { s } = await sw([
      'enable', 'configure terminal',
      'ip access-list extended UNE', 'permit ip any any',
      'exit', 'ip access-list extended DEUX', 'permit ip any any', 'exit', 'exit',
    ]);
    const e = s.getVaclEngine();
    e.evaluateACLByName('UNE', tcpPkt('1.1.1.1', '2.2.2.2', 80));
    const d = await s.executeCommand('show access-lists UNE');
    expect(d).toContain('UNE');
    expect(d).not.toContain('DEUX');
    expect(d).toMatch(/\(1 match\)/);
  });
});
