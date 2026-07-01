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
import { makeARecord, makeSoaRecord, makeNsRecord, makeCnameRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';

function soaFor(origin: string) {
  return makeSoaRecord(origin, 3600, {
    mname: origin === '' ? 'a.root' : `ns1.${origin}`,
    rname: origin === '' ? 'hostmaster.root' : `hostmaster.${origin}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  });
}

function buildRootZone(): Zone {
  const zone = new Zone('.', soaFor(''));
  zone.addRecord(makeNsRecord('com', 86400, 'ns.tld-servers.net'));
  zone.addRecord(makeARecord('ns.tld-servers.net', 86400, '10.0.0.2'));
  zone.addRecord(makeNsRecord('net', 86400, 'ns.tld-servers.net'));
  return zone;
}

function buildTldStore(): ZoneStore {
  const com = new Zone('com', soaFor('com'));
  com.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  com.addRecord(makeARecord('ns1.example.com', 86400, '10.0.0.3'));
  com.addRecord(makeNsRecord('broken.com', 86400, 'ns1.broken.com'));
  com.addRecord(makeARecord('ns1.broken.com', 86400, '10.0.0.99'));
  com.addRecord(makeNsRecord('noglue.com', 86400, 'ns.elsewhere.net'));

  const net = new Zone('net', soaFor('net'));
  net.addRecord(makeNsRecord('elsewhere.net', 86400, 'ns.elsewhere.net'));
  net.addRecord(makeARecord('ns.elsewhere.net', 86400, '10.0.0.2'));

  const elsewhere = new Zone('elsewhere.net', soaFor('elsewhere.net'));
  elsewhere.addRecord(makeARecord('ns.elsewhere.net', 3600, '10.0.0.3'));

  const store = new ZoneStore();
  store.addZone(com);
  store.addZone(net);
  store.addZone(elsewhere);
  return store;
}

function buildChildStore(): ZoneStore {
  const example = new Zone('example.com', soaFor('example.com'));
  example.addRecord(makeARecord('www.example.com', 3600, '192.0.2.80'));
  example.addRecord(makeCnameRecord('alias.example.com', 3600, 'www.example.com'));

  const noglue = new Zone('noglue.com', soaFor('noglue.com'));
  noglue.addRecord(makeARecord('www.noglue.com', 3600, '192.0.2.99'));

  const store = new ZoneStore();
  store.addZone(example);
  store.addZone(noglue);
  return store;
}

interface Lab {
  resolverHost: LinuxPC;
  hits: { root: number; tld: number; child: number };
  makeResolver(cache?: DnsCache): RecursiveResolver;
}

function buildLab(): Lab {
  const sw = new GenericSwitch('switch-generic', 'core-sw', 8, 0, 0);
  const rootSrv = new LinuxServer('linux-server', 'root-srv', 0, 0);
  const tldSrv = new LinuxServer('linux-server', 'tld-srv', 0, 0);
  const childSrv = new LinuxServer('linux-server', 'child-srv', 0, 0);
  const resolverHost = new LinuxPC('linux-pc', 'resolver', 0, 0);

  const mask = new SubnetMask('255.255.255.0');
  [rootSrv, tldSrv, childSrv, resolverHost].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  rootSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  tldSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  childSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  resolverHost.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), mask);

  const hits = { root: 0, tld: 0, child: 0 };

  const rootStore = new ZoneStore();
  rootStore.addZone(buildRootZone());
  const rootEngine = new AuthoritativeServer(rootStore);
  bindDnsUdpServer(rootSrv, (q) => { hits.root++; return rootEngine.answer(q); });
  bindDnsTcpServer(rootSrv, (q) => rootEngine.answer(q));

  const tldEngine = new AuthoritativeServer(buildTldStore());
  bindDnsUdpServer(tldSrv, (q) => { hits.tld++; return tldEngine.answer(q); });
  bindDnsTcpServer(tldSrv, (q) => tldEngine.answer(q));

  const childEngine = new AuthoritativeServer(buildChildStore());
  bindDnsUdpServer(childSrv, (q) => { hits.child++; return childEngine.answer(q); });
  bindDnsTcpServer(childSrv, (q) => childEngine.answer(q));

  return {
    resolverHost,
    hits,
    makeResolver: (cache?: DnsCache) =>
      new RecursiveResolver(resolverHost, [new IPAddress('10.0.0.1')], cache ?? new DnsCache(), { timeoutMs: 500 }),
  };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('RecursiveResolver — RFC 1034 §5.3 iterative resolution on a real LAN', () => {
  it('resolves a name through root, TLD and child delegations', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    const result = await resolver.resolve('www.example.com', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect(result.fromCache).toBe(false);
    expect(result.answers).toHaveLength(1);
    expect((result.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.80');
    expect(lab.hits.root).toBeGreaterThanOrEqual(1);
    expect(lab.hits.tld).toBeGreaterThanOrEqual(1);
    expect(lab.hits.child).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('follows an in-zone CNAME chain to the final address', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    const result = await resolver.resolve('alias.example.com', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect(result.answers.some((rr) => rr.data.type === RRType.CNAME)).toBe(true);
    expect(result.answers.some((rr) => rr.data.type === RRType.A)).toBe(true);
  }, 15000);

  it('resolves through a glueless referral by resolving the NS name first', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    const result = await resolver.resolve('www.noglue.com', RRType.A);

    expect(result.status).toBe('NOERROR');
    expect((result.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.99');
  }, 15000);
});

describe('RecursiveResolver — cache behavior (RFC 1034 §5, RFC 2308)', () => {
  it('answers the second identical query from cache without touching the network', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    await resolver.resolve('www.example.com', RRType.A);
    const hitsAfterFirst = { ...lab.hits };
    const second = await resolver.resolve('www.example.com', RRType.A);

    expect(second.status).toBe('NOERROR');
    expect(second.fromCache).toBe(true);
    expect(lab.hits).toEqual(hitsAfterFirst);
  }, 15000);

  it('decays TTL on cached answers and expires them', async () => {
    const lab = buildLab();
    let nowMs = 1_000_000;
    const cache = new DnsCache(() => nowMs);
    const resolver = lab.makeResolver(cache);

    await resolver.resolve('www.example.com', RRType.A);
    nowMs += 100_000;
    const decayed = await resolver.resolve('www.example.com', RRType.A);
    expect(decayed.fromCache).toBe(true);
    expect(decayed.answers[0].ttl).toBe(3500);

    const hitsBeforeExpiry = { ...lab.hits };
    nowMs += 3_500_001;
    const refetched = await resolver.resolve('www.example.com', RRType.A);
    expect(refetched.fromCache).toBe(false);
    expect(refetched.answers[0].ttl).toBe(3600);
    expect(lab.hits.child).toBeGreaterThan(hitsBeforeExpiry.child);
  }, 15000);

  it('caches NXDOMAIN negatively with the SOA MINIMUM as TTL', async () => {
    const lab = buildLab();
    let nowMs = 1_000_000;
    const cache = new DnsCache(() => nowMs);
    const resolver = lab.makeResolver(cache);

    const first = await resolver.resolve('ghost.example.com', RRType.A);
    expect(first.status).toBe('NXDOMAIN');

    const hitsAfterFirst = { ...lab.hits };
    const second = await resolver.resolve('ghost.example.com', RRType.A);
    expect(second.status).toBe('NXDOMAIN');
    expect(second.fromCache).toBe(true);
    expect(lab.hits).toEqual(hitsAfterFirst);

    nowMs += 300_001;
    const third = await resolver.resolve('ghost.example.com', RRType.A);
    expect(third.fromCache).toBe(false);
    expect(lab.hits.child).toBeGreaterThan(hitsAfterFirst.child);
  }, 15000);

  it('caches NODATA negatively for an existing name with no record of that type', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    const first = await resolver.resolve('www.example.com', RRType.MX);
    expect(first.status).toBe('NOERROR');
    expect(first.answers).toHaveLength(0);

    const hitsAfterFirst = { ...lab.hits };
    const second = await resolver.resolve('www.example.com', RRType.MX);
    expect(second.fromCache).toBe(true);
    expect(lab.hits).toEqual(hitsAfterFirst);
  }, 15000);
});

describe('RecursiveResolver — failure realism', () => {
  it('returns SERVFAIL when the delegated server is unreachable', async () => {
    const lab = buildLab();
    const resolver = lab.makeResolver();

    const result = await resolver.resolve('www.broken.com', RRType.A);

    expect(result.status).toBe('SERVFAIL');
    expect(result.answers).toHaveLength(0);
  }, 15000);

  it('returns SERVFAIL when no root hint answers', async () => {
    const lab = buildLab();
    const resolver = new RecursiveResolver(
      lab.resolverHost, [new IPAddress('10.0.0.55')], new DnsCache(), { timeoutMs: 200 },
    );

    const result = await resolver.resolve('www.example.com', RRType.A);

    expect(result.status).toBe('SERVFAIL');
  }, 15000);
});
