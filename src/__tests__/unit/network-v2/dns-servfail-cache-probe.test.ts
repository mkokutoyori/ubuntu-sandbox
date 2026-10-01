/**
 * Cache de SERVFAIL (RFC 2308 §7 : mémorisation facultative, au plus 5 minutes)
 * et option `servfail-ttl` de named.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 2 cas sur 4 tombent
 * (aucune mémorisation d'un SERVFAIL ; `servfail-ttl` refusé par named.conf).
 * Passent avant et après (témoins) : sans durée, chaque appel interroge le serveur ;
 * la clé par nom et type (rien n'est mémorisé avant, donc rien ne se croise).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function lab(servfailTtlSeconds?: number) {
  const srv = new LinuxServer('linux-server', 'S');
  const pc = new LinuxPC('linux-pc', 'R');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c').connect(srv.getPorts()[0], pc.getPorts()[0]);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  let queries = 0;
  bindDnsUdpServer(srv, (q) => {
    queries++;
    return {
      id: q.id,
      flags: { qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.SERVFAIL },
      questions: q.questions, answers: [], authorities: [], additionals: [],
    };
  });
  const resolver = new RecursiveResolver(pc, [new IPAddress('10.0.0.2')], new DnsCache(), {
    timeoutMs: 300, servfailTtlSeconds,
  });
  return { resolver, count: () => queries };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('cache de SERVFAIL', () => {
  it('témoin : sans durée, chaque appel interroge le serveur', async () => {
    const { resolver, count } = lab();
    await resolver.resolve('x.test', RRType.A);
    await resolver.resolve('x.test', RRType.A);
    expect(count()).toBe(2);
  });

  it('avec une durée, le second appel est servi par le cache', async () => {
    const { resolver, count } = lab(30);
    expect((await resolver.resolve('x.test', RRType.A)).status).toBe('SERVFAIL');
    const second = await resolver.resolve('x.test', RRType.A);
    expect(second.status).toBe('SERVFAIL');
    expect(second.fromCache).toBe(true);
    expect(count()).toBe(1);
  });

  it('la mémorisation est par nom et par type', async () => {
    const { resolver, count } = lab(30);
    await resolver.resolve('x.test', RRType.A);
    await resolver.resolve('x.test', RRType.AAAA);
    expect(count()).toBe(2);
  });

  it('named accepte servfail-ttl', async () => {
    const ns = new LinuxServer('linux-server', 'NS1');
    (ns as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(
      '/etc/bind/named.conf', 'options { recursion no; servfail-ttl 10; };\n', 0, 0, 0o022);
    const out = await ns.executeCommand('named-checkconf');
    expect(out).not.toMatch(/unknown option/);
  });
});
