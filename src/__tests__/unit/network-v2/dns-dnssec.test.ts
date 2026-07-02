import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, RrsigRecordData, NsecRecordData, DnskeyRecordData } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import { generateZoneKey, makeDsForKey, dsMatchesKey } from '@/network/dns/dnssec/DnsKey';
import { signZone, signRRSet, verifySignature, defaultSignatureWindow } from '@/network/dns/dnssec/DnsSigner';
import { buildNsecChain, nsecCovers, canonicalNameCompare } from '@/network/dns/dnssec/Nsec';

function soaFor(origin: string) {
  return makeSoaRecord(origin, 3600, {
    mname: origin === '' ? 'ns.root' : `ns1.${origin}`,
    rname: origin === '' ? 'hostmaster.root' : `hostmaster.${origin}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  });
}

function buildSignedChildZone(): { zone: Zone; keys: ReturnType<typeof zoneKeys> } {
  const zone = new Zone('example.com', soaFor('example.com'));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '10.0.0.2'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  const keys = zoneKeys('example.com');
  signZone(zone, keys);
  return { zone, keys };
}

function zoneKeys(origin: string) {
  return {
    zsk: generateZoneKey(origin, 'zsk', 3600),
    ksk: generateZoneKey(origin, 'ksk', 3600),
  };
}

interface Lab {
  resolverHost: LinuxPC;
  anchors: ReturnType<typeof makeDsForKey>[];
  childZone: Zone;
}

function buildLab(options: { tamper?: boolean } = {}): Lab {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const rootSrv = new LinuxServer('linux-server', 'root-srv', 0, 0);
  const childSrv = new LinuxServer('linux-server', 'child-srv', 0, 0);
  const resolverHost = new LinuxPC('linux-pc', 'resolver', 0, 0);

  const mask = new SubnetMask('255.255.255.0');
  [rootSrv, childSrv, resolverHost].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  rootSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  childSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  resolverHost.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), mask);

  const { zone: childZone, keys: childKeys } = buildSignedChildZone();

  const unsignedZone = new Zone('unsigned.org', soaFor('unsigned.org'));
  unsignedZone.addRecord(makeNsRecord('unsigned.org', 86400, 'ns1.unsigned.org'));
  unsignedZone.addRecord(makeARecord('ns1.unsigned.org', 3600, '10.0.0.2'));
  unsignedZone.addRecord(makeARecord('www.unsigned.org', 3600, '198.51.100.5'));

  const rootKeys = zoneKeys('');
  const rootZone = new Zone('.', soaFor(''));
  rootZone.addRecord(makeNsRecord('', 86400, 'ns.root'));
  rootZone.addRecord(makeARecord('ns.root', 86400, '10.0.0.1'));
  rootZone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  rootZone.addRecord(makeARecord('ns1.example.com', 86400, '10.0.0.2'));
  rootZone.addRecord(makeDsForKey('example.com', 3600, childKeys.ksk));
  rootZone.addRecord(makeNsRecord('unsigned.org', 86400, 'ns1.unsigned.org'));
  rootZone.addRecord(makeARecord('ns1.unsigned.org', 86400, '10.0.0.2'));
  signZone(rootZone, rootKeys);

  if (options.tamper) {
    childZone.removeRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
    childZone.addRecord(makeARecord('www.example.com', 3600, '203.0.113.66'));
  }

  const rootStore = new ZoneStore();
  rootStore.addZone(rootZone);
  const rootEngine = new AuthoritativeServer(rootStore);
  bindDnsUdpServer(rootSrv, (q) => rootEngine.answer(q));
  bindDnsTcpServer(rootSrv, (q) => rootEngine.answer(q));

  const childStore = new ZoneStore();
  childStore.addZone(childZone);
  childStore.addZone(unsignedZone);
  const childEngine = new AuthoritativeServer(childStore);
  bindDnsUdpServer(childSrv, (q) => childEngine.answer(q));
  bindDnsTcpServer(childSrv, (q) => childEngine.answer(q));

  return {
    resolverHost,
    anchors: [makeDsForKey('', 3600, rootKeys.ksk)],
    childZone,
  };
}

function makeValidatingResolver(lab: Lab): RecursiveResolver {
  return new RecursiveResolver(lab.resolverHost, [new IPAddress('10.0.0.1')], new DnsCache(), {
    timeoutMs: 500,
    dnssec: { anchors: lab.anchors },
  });
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('DNSSEC signing primitives (RFC 4033-4035)', () => {
  it('signs a zone: DNSKEY RRset at the apex, one RRSIG per RRset, circular NSEC chain', () => {
    const { zone } = buildSignedChildZone();

    const dnskeys = zone.getRRSet('example.com', RRType.DNSKEY);
    expect(dnskeys).toHaveLength(2);

    const all = zone.allRecords();
    const rrsigs = all.filter((rr) => rr.data.type === RRType.RRSIG);
    const coveredTypes = new Set(rrsigs.map((rr) => (rr.data as RrsigRecordData).typeCovered));
    expect(coveredTypes.has(RRType.SOA)).toBe(true);
    expect(coveredTypes.has(RRType.A)).toBe(true);
    expect(coveredTypes.has(RRType.DNSKEY)).toBe(true);
    expect(coveredTypes.has(RRType.NSEC)).toBe(true);

    const nsecs = all.filter(
      (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC,
    );
    const owners = nsecs.map((rr) => rr.name).sort(canonicalNameCompare);
    const nextNames = new Set(nsecs.map((rr) => rr.data.nextDomainName));
    expect(nsecs).toHaveLength(owners.length);
    for (const owner of owners) expect(nextNames.has(owner)).toBe(true);
  });

  it('verifies a genuine signature and rejects a tampered RRset', () => {
    const keys = zoneKeys('example.com');
    const window = defaultSignatureWindow();
    const rrset = [makeARecord('www.example.com', 3600, '192.0.2.10')];
    const rrsig = signRRSet(rrset, 'example.com', keys.zsk, window);

    const now = Math.floor(Date.now() / 1000);
    expect(verifySignature(rrset, rrsig.data, keys.zsk.data, now)).toBe(true);

    const forged = [makeARecord('www.example.com', 3600, '203.0.113.9')];
    expect(verifySignature(forged, rrsig.data, keys.zsk.data, now)).toBe(false);
  });

  it('rejects a signature outside its validity window', () => {
    const keys = zoneKeys('example.com');
    const rrset = [makeARecord('www.example.com', 3600, '192.0.2.10')];
    const rrsig = signRRSet(rrset, 'example.com', keys.zsk, { inception: 1000, expiration: 2000 });

    expect(verifySignature(rrset, rrsig.data, keys.zsk.data, 1500)).toBe(true);
    expect(verifySignature(rrset, rrsig.data, keys.zsk.data, 2001)).toBe(false);
  });

  it('matches a DS record against its DNSKEY and rejects another key', () => {
    const keys = zoneKeys('example.com');
    const other = generateZoneKey('example.com', 'ksk', 3600, undefined, 'other');
    const ds = makeDsForKey('example.com', 3600, keys.ksk);

    expect(dsMatchesKey('example.com', ds.data, keys.ksk.data)).toBe(true);
    expect(dsMatchesKey('example.com', ds.data, (other.data as DnskeyRecordData))).toBe(false);
  });

  it('NSEC covers the gap between two owners, including the wraparound interval', () => {
    const zone = new Zone('example.com', soaFor('example.com'));
    zone.addRecord(makeARecord('alpha.example.com', 3600, '192.0.2.1'));
    zone.addRecord(makeARecord('omega.example.com', 3600, '192.0.2.2'));
    const chain = buildNsecChain(zone);

    const alphaNsec = chain.find((rr) => rr.name === 'alpha.example.com')!;
    expect(nsecCovers('ghost.example.com', alphaNsec)).toBe(true);

    const omegaNsec = chain.find((rr) => rr.name === 'omega.example.com')!;
    expect(omegaNsec.data.nextDomainName).toBe('example.com');
    expect(nsecCovers('zzz.example.com', omegaNsec)).toBe(true);
  });
});

describe('Validating resolver over a real LAN — chain of trust to the root anchor', () => {
  it('resolves and validates a signed answer as secure across the delegation chain', async () => {
    const lab = buildLab();
    const resolver = makeValidatingResolver(lab);

    const result = await resolver.resolve('www.example.com', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect(result.security).toBe('secure');
    expect(result.answers.some((rr) => rr.data.type === RRType.A)).toBe(true);
    expect(result.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(true);
  }, 15000);

  it('detects a record altered after signing and fails closed with SERVFAIL/bogus', async () => {
    const lab = buildLab({ tamper: true });
    const resolver = makeValidatingResolver(lab);

    const result = await resolver.resolve('www.example.com', RRType.A);

    expect(result.security).toBe('bogus');
    expect(result.status).toBe('SERVFAIL');
    expect(result.answers).toHaveLength(0);
  }, 15000);

  it('proves NXDOMAIN with a covering NSEC and validates it as secure', async () => {
    const lab = buildLab();
    const resolver = makeValidatingResolver(lab);

    const result = await resolver.resolve('ghost.example.com', RRType.A);

    expect(result.status).toBe('NXDOMAIN');
    expect(result.security).toBe('secure');
  }, 15000);

  it('treats an unsigned delegation without DS as insecure, not bogus', async () => {
    const lab = buildLab();
    const resolver = makeValidatingResolver(lab);

    const result = await resolver.resolve('www.unsigned.org', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect(result.security).toBe('insecure');
    expect(result.answers.some((rr) => rr.data.type === RRType.A)).toBe(true);
  }, 15000);

  it('leaves plain resolution untouched when validation is disabled', async () => {
    const lab = buildLab();
    const resolver = new RecursiveResolver(
      lab.resolverHost, [new IPAddress('10.0.0.1')], new DnsCache(), { timeoutMs: 500 },
    );

    const result = await resolver.resolve('www.example.com', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect(result.security).toBeUndefined();
    expect(result.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(false);
  }, 15000);
});
