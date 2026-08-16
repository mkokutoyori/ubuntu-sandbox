/**
 * AUDIT ACL CISCO — banc de preuves.
 *
 * ATTENTION — ce fichier n'est PAS une suite de non-régression.
 * Chaque test y assied le comportement ACTUEL, c'est-à-dire dans la
 * plupart des cas le comportement FAUTIF, afin que le rapport d'audit
 * (AUDIT-ACL-CISCO.md) repose sur une mesure et non sur une lecture.
 *
 * Un test qui PASSE ici = un défaut TOUJOURS PRÉSENT.
 * Un test qui ÉCHOUE ici = le défaut a été corrigé ; supprimer le test
 * et ouvrir la ligne correspondante du rapport.
 *
 * Référence des identifiants F-xx : AUDIT-ACL-CISCO.md, tableau §3.
 */
import { describe, it, expect } from 'vitest';
import {
  IPAddress, SubnetMask, IPv4Packet,
  IP_PROTO_TCP, IP_PROTO_ICMP,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { ACLEngine } from '@/network/devices/router/ACLEngine';

async function cfg(r: CiscoRouter, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await r.executeCommand(c));
  return out;
}

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

describe('AUDIT', () => {
  it('F-01 remark neutralises the whole ACL (permit-any)', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended BLOCK',
      'remark bloque le VLAN invite',
      'deny ip 10.0.0.0 0.0.0.255 any',
      'permit ip any any',
    ]);
    const v = r.evaluateACLByName('BLOCK', tcpPkt('10.0.0.5', '8.8.8.8', 80));
    console.log('F-01 verdict for a packet the ACL says DENY:', v);
    expect(v).toBe('permit'); // BUG: should be deny
  });

  it('F-02 evaluate <name> is a permit-any', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended OUT',
      'evaluate MIRROR',
      'deny ip any any',
    ]);
    const v = r.evaluateACLByName('OUT', tcpPkt('1.2.3.4', '5.6.7.8', 80));
    console.log('F-02 verdict:', v);
    expect(v).toBe('permit'); // BUG: no session table -> should fail closed
  });

  it('F-03 tcp flag matching (match-any syn) is parsed then ignored', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended FLAGS',
      'deny tcp any any match-any rst',
      'permit ip any any',
    ]);
    // packet has NO rst flag -> must NOT match the deny
    const v = r.evaluateACLByName('FLAGS', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true }));
    console.log('F-03 verdict for a SYN pkt against "deny tcp any any match-any rst":', v);
    expect(v).toBe('deny'); // BUG: flags ignored -> deny matches everything
  });

  it('F-04 unknown icmp keyword -> fail OPEN (matches all icmp)', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('X', 'extended', 'deny', {
      protocol: 'icmp',
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
      icmpType: 'administratively-prohibited', // valid IOS kw, absent from the map
    });
    const v = e.evaluateACL('X', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'));
    console.log('F-04 echo-request vs "deny icmp any any administratively-prohibited":', v);
    expect(v).toBe('deny'); // BUG: unmapped keyword -> criterion silently dropped
  });

  it('F-05 host-unreachable and port-unreachable are conflated', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Y', 'extended', 'deny', {
      protocol: 'icmp',
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
      icmpType: 'host-unreachable',
    });
    const v = e.evaluateACL('Y', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable'));
    console.log('F-05 any unreachable vs "deny icmp ... host-unreachable":', v);
    expect(v).toBe('deny'); // icmpCode never checked -> all unreachables conflated
  });

  it('F-06 unknown dscp keyword -> fail OPEN', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('Z', 'extended', 'deny', {
      protocol: 'ip',
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
      dscp: 'af99', // typo
    });
    const v = e.evaluateACL('Z', tcpPkt('1.1.1.1', '2.2.2.2', 80));
    console.log('F-06 dscp typo verdict:', v);
    expect(v).toBe('deny'); // BUG: criterion dropped
  });

  it('F-07 extended ACL on a source-only probe CRASHES (vty/ntp/nat path)', () => {
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
    console.log('F-07 error:', err instanceof Error ? err.message : err);
    expect(err).toBeInstanceOf(TypeError);
  });

  it('F-08 CLI rejects valid IOS ranges 1300-1999 / 2000-2699', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'access-list 1500 permit host 10.0.0.1',
      'access-list 2500 permit ip any any',
    ]);
    console.log('F-08 out:', JSON.stringify(out.slice(2)));
    expect(out[2]).toContain('Invalid');
    expect(out[3]).toContain('Invalid');
  });

  it('F-09 engine types 2000-2999 as STANDARD (Huawei numbering on a Cisco box)', () => {
    const e = new ACLEngine();
    e.addAccessListEntry(2500, 'permit', {
      srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      dstIP: new IPAddress('192.168.1.1'), dstWildcard: new SubnetMask('0.0.0.0'),
      protocol: 'tcp', dstPortSpec: { op: 'eq', port: 22 },
    });
    const acl = e.findById(2500);
    console.log('F-09 acl 2500 type =', acl?.type, '(IOS says extended)');
    expect(acl?.type).toBe('standard');
    // consequence: destination + port criteria silently dropped
    const v = e.evaluateACL(2500, tcpPkt('10.0.0.5', '8.8.8.8', 443));
    console.log('F-09 verdict for a pkt matching NEITHER dst NOR port:', v);
    expect(v).toBe('permit');
  });

  it('F-10 missing L4 payload -> port criteria silently skipped (fail OPEN)', () => {
    const e = new ACLEngine();
    e.addNamedAccessListEntry('P', 'extended', 'permit', {
      protocol: 'tcp',
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
      dstPortSpec: { op: 'eq', port: 22 },
    });
    const noPayload = {
      version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 20,
      identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
      protocol: IP_PROTO_TCP, headerChecksum: 0,
      sourceIP: new IPAddress('1.1.1.1'), destinationIP: new IPAddress('2.2.2.2'),
    } as unknown as IPv4Packet;
    const v = e.evaluateACL('P', noPayload);
    console.log('F-10 tcp/no-payload vs "permit tcp any any eq 22":', v);
    expect(v).toBe('permit');
  });

  it('F-11 auto sequence numbering deviates from IOS (last+10)', () => {
    const e = new ACLEngine();
    const mk = (seq?: number) => e.addNamedAccessListEntry('S', 'standard', 'permit', {
      sequence: seq, srcIP: new IPAddress('1.1.1.1'), srcWildcard: new SubnetMask('0.0.0.0'),
    });
    mk(15);
    mk(); // IOS -> 25
    const seqs = e.findByName('S')!.entries.map(x => x.sequence);
    console.log('F-11 sequences:', seqs, '(IOS gives [15, 25])');
    expect(seqs).toEqual([15, 20]);
  });

  it('F-12 duplicate sequence numbers are accepted silently', () => {
    const e = new ACLEngine();
    for (const a of ['permit', 'deny'] as const) {
      e.addNamedAccessListEntry('D', 'standard', a, {
        sequence: 10, srcIP: new IPAddress('1.1.1.1'), srcWildcard: new SubnetMask('0.0.0.0'),
      });
    }
    const es = e.findByName('D')!.entries;
    console.log('F-12 entries at seq 10:', es.length, es.map(x => x.action));
    expect(es.length).toBe(2);
  });

  it('F-13 empty named ACL never reaches running-config', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'ip access-list extended EMPTY', 'exit', 'exit']);
    const rc = await r.executeCommand('show running-config');
    console.log('F-13 running-config contains EMPTY:', rc.includes('EMPTY'));
    expect(rc.includes('EMPTY')).toBe(false);
  });

  it('F-14 "no permit ..." (remove-by-text) unsupported', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended T',
      'permit tcp any any eq 80',
      'no permit tcp any any eq 80',
    ]);
    console.log('F-14 out:', JSON.stringify(out[4]));
    const acl = r.getAccessLists().find(a => a.name === 'T');
    console.log('F-14 entries left:', acl?.entries.length);
    expect(acl?.entries.length).toBe(1);
  });

  it('F-15 re-entering ipv6 access-list WIPES all entries', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ipv6 access-list V6',
      'deny icmp any any',
      'permit ipv6 any any',
      'exit',
    ]);
    const before = r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length;
    await cfg(r, ['ipv6 access-list V6']);
    const after = r.getIpv6AccessLists().find(a => a.name === 'V6')!.entries.length;
    console.log(`F-15 entries before=${before} after re-entry=${after}`);
    expect(before).toBe(2);
    expect(after).toBe(0);
  });

  it('F-16 unknown trailing tokens silently swallowed (no % Invalid input)', async () => {
    const r = new CiscoRouter('R');
    const out = await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended TYPO',
      'permit tcp any any eq 80 estalbished',
    ]);
    console.log('F-16 out:', JSON.stringify(out[3]));
    expect(out[3]).toBe('');
  });

  it('F-17 remark inflates match counters and prints "(N matches)"', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, [
      'enable', 'configure terminal',
      'ip access-list extended CNT', 'remark hello', 'exit', 'exit',
    ]);
    r.evaluateACLByName('CNT', tcpPkt('1.1.1.1', '2.2.2.2', 80));
    const show = await r.executeCommand('show access-lists');
    console.log('F-17 show:\n' + show);
    expect(show).toContain('match');
  });

  it('F-18 standard ACL show renders "host X" (IOS prints a bare IP)', async () => {
    const r = new CiscoRouter('R');
    await cfg(r, ['enable', 'configure terminal', 'access-list 1 permit host 10.0.0.1', 'exit']);
    const show = await r.executeCommand('show access-lists');
    console.log('F-18 show:\n' + show);
    expect(show).toContain('host 10.0.0.1');
  });
});

describe('AUDIT — rayon de souffle commutateur', () => {
  it('F-19 le meme moteur sert les VACL : un remark neutralise aussi un port ACL', () => {
    const e = new ACLEngine();
    const anyAny = {
      protocol: 'ip',
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
    };
    e.addNamedAccessListEntry('SW', 'extended', 'permit', { ...anyAny, remark: 'politique de port' });
    e.addNamedAccessListEntry('SW', 'extended', 'deny', { ...anyAny });
    const v = e.evaluateACL('SW', tcpPkt('1.1.1.1', '2.2.2.2', 80));
    console.log('F-19 "deny ip any any" precede d un remark =>', v);
    expect(v).toBe('permit');
  });
});
