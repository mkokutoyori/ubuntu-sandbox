/**
 * Plafonnement des TTL par la signature (RFC 4035 §5.3.3) et mémorisation du
 * verdict dans le cache.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 3 cas sur 4 tombent.
 *   - un RRset de TTL 3600 signé pour 100 s restait servi 3600 s
 *   - il restait dans le cache au-delà de la validité de sa signature
 *   - un second appel servi par le cache perdait le verdict « secure », donc le bit AD
 * Passe avant et après (témoin) : un RRset dont le TTL est inférieur à la
 * validité de la signature garde son TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { generateZoneKey, makeDsForKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';

const NOW = Math.floor(Date.now() / 1000);

function lab(signatureSeconds: number) {
  const auth = new LinuxServer('linux-server', 'AUTH');
  const pc = new LinuxPC('linux-pc', 'R');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c').connect(auth.getPorts()[0], pc.getPorts()[0]);
  auth.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  const zone = new Zone('lab.test', makeSoaRecord('lab.test', 3600, {
    mname: 'ns.lab.test', rname: 'h.lab.test', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('lab.test', 3600, 'ns.lab.test'));
  zone.addRecord(makeARecord('ns.lab.test', 3600, '10.0.0.2'));
  zone.addRecord(makeARecord('www.lab.test', 3600, '192.0.2.10'));
  const ksk = generateZoneKey('lab.test', 'ksk', 3600);
  signZone(zone, { zsk: generateZoneKey('lab.test', 'zsk', 3600), ksk },
    { inception: NOW - 60, expiration: NOW + signatureSeconds });
  new PrimaryZoneAgent(auth, zone).start();
  const cache = new DnsCache();
  const resolver = new RecursiveResolver(pc, [new IPAddress('10.0.0.2')], cache, {
    timeoutMs: 500, dnssec: { anchors: [makeDsForKey('lab.test', 0, ksk)] },
  });
  return { resolver, cache };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('TTL et signature', () => {
  it('témoin : un TTL inférieur à la validité de la signature est conservé', async () => {
    const { resolver } = lab(86400);
    const r = await resolver.resolve('www.lab.test', RRType.A);
    expect(r.security).toBe('secure');
    expect(r.answers.find((rr) => rr.data.type === RRType.A)!.ttl).toBe(3600);
  });

  it('un TTL plus long que la validité restante est ramené à celle-ci', async () => {
    const { resolver } = lab(100);
    const r = await resolver.resolve('www.lab.test', RRType.A);
    expect(r.security).toBe('secure');
    const ttl = r.answers.find((rr) => rr.data.type === RRType.A)!.ttl;
    expect(ttl).toBeLessThanOrEqual(100);
    expect(ttl).toBeGreaterThan(0);
  });

  it('le cache ne garde pas la donnée au-delà de la signature', async () => {
    const { resolver, cache } = lab(100);
    await resolver.resolve('www.lab.test', RRType.A);
    const hit = cache.lookup('www.lab.test', RRType.A);
    expect(hit.kind).toBe('hit');
    if (hit.kind === 'hit') expect(hit.records[0].ttl).toBeLessThanOrEqual(100);
  });

  it('une réponse servie par le cache garde son verdict secure', async () => {
    const { resolver } = lab(86400);
    await resolver.resolve('www.lab.test', RRType.A);
    const again = await resolver.resolve('www.lab.test', RRType.A);
    expect(again.fromCache).toBe(true);
    expect(again.security).toBe('secure');
  });
});
