/**
 * Sonde du résolveur face à des serveurs faisant autorité hostiles
 * (RFC 1034 §5.3, RFC 1035 §4.1.1, RFC 2308 §5).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 6 cas sur 9 tombent.
 *   - la section réponse d'un serveur hostile était mise en cache en bloc,
 *     y compris un enregistrement pour un nom qu'on ne lui avait pas demandé
 *     (empoisonnement de cache)
 *   - une délégation vers une zone qui ne contient pas le nom demandé était suivie
 *   - un glue hors de la zone du serveur interrogé était suivi
 *   - une réponse dont la section question ne reprend pas la question posée
 *     était acceptée
 *   - un NXDOMAIN n'était retenu que pour le type demandé : un second type
 *     pour le même nom relançait des requêtes (RFC 2308 §5)
 *   - une réponse venue d'une autre adresse que le serveur interrogé était acceptée
 * Passent avant et après (témoins) : une résolution honnête aboutit, un CNAME
 * légitime est suivi, un NODATA reste propre au type demandé.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { makeARecord, makeAaaaRecord, makeNsRecord, makeSoaRecord, makeCnameRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';

type Rr = ResourceRecord<ResourceRecordData>;

interface Reply {
  readonly rcode?: number;
  readonly aa?: boolean;
  readonly answers?: readonly Rr[];
  readonly authorities?: readonly Rr[];
  readonly additionals?: readonly Rr[];
  readonly questions?: DnsMessage['questions'];
}

function reply(query: DnsMessage, r: Reply): DnsMessage {
  return {
    id: query.id,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: r.aa ?? false, tc: false, rd: false, ra: false,
      ad: false, cd: false, rcode: r.rcode ?? DnsRcode.NOERROR,
    },
    questions: r.questions ?? query.questions,
    answers: r.answers ?? [], authorities: r.authorities ?? [], additionals: r.additionals ?? [],
  };
}

const SOA = makeSoaRecord('', 3600, {
  mname: 'a.root', rname: 'h.root', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
});

type Handler = (query: DnsMessage, sourcePort?: number) => DnsMessage;

function lab(handlers: Record<string, Handler>) {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'R');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c0').connect(pc.getPorts()[0], sw.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  const queried = new Map<string, number>();
  let index = 1;
  for (const [ip, handler] of Object.entries(handlers)) {
    const srv = new LinuxServer('linux-server', `S${index}`);
    new Cable(`c${index}`).connect(srv.getPorts()[0], sw.getPorts()[index]);
    srv.getPorts()[0].configureIP(new IPAddress(ip), mask);
    const counting: Handler = (q, port) => {
      queried.set(ip, (queried.get(ip) ?? 0) + 1);
      return handler(q, port);
    };
    bindDnsUdpServer(srv, (q, _ip, port) => counting(q, port));
    bindDnsTcpServer(srv, (q) => counting(q));
    index++;
  }
  const spoofer = new LinuxServer('linux-server', 'SPOOF');
  new Cable('cs').connect(spoofer.getPorts()[0], sw.getPorts()[7]);
  spoofer.getPorts()[0].configureIP(new IPAddress('10.0.0.9'), mask);
  const cache = new DnsCache();
  const resolver = new RecursiveResolver(pc, [new IPAddress('10.0.0.2')], cache, { timeoutMs: 300 });
  return { pc, cache, resolver, queried, spoofer };
}

const aOf = (rr: Rr) => String((rr.data as { address: IPAddress }).address);

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('résolveur — réponses hostiles', () => {
  it('témoin : une réponse honnête est acceptée', async () => {
    const { resolver } = lab({
      '10.0.0.2': (q) => reply(q, { aa: true, answers: [makeARecord('www.good.test', 300, '192.0.2.1')] }),
    });
    const result = await resolver.resolve('www.good.test', RRType.A);
    expect(result.status).toBe('NOERROR');
    expect(result.answers.map(aOf)).toEqual(['192.0.2.1']);
  });

  it('témoin : un CNAME légitime est suivi', async () => {
    const { resolver } = lab({
      '10.0.0.2': (q) => q.questions[0].qname === 'alias.good.test'
        ? reply(q, { aa: true, answers: [makeCnameRecord('alias.good.test', 300, 'www.good.test')] })
        : reply(q, { aa: true, answers: [makeARecord('www.good.test', 300, '192.0.2.1')] }),
    });
    const result = await resolver.resolve('alias.good.test', RRType.A);
    expect(result.answers.map((rr) => rr.data.type)).toEqual([RRType.CNAME, RRType.A]);
  });

  it('un enregistrement non demandé dans la section réponse n’entre ni dans le résultat ni dans le cache', async () => {
    const { resolver, cache } = lab({
      '10.0.0.2': (q) => reply(q, {
        aa: true,
        answers: [makeARecord('www.evil.test', 300, '192.0.2.1'), makeARecord('bank.example.org', 300, '6.6.6.6')],
      }),
    });
    const result = await resolver.resolve('www.evil.test', RRType.A);
    expect(result.answers.map((rr) => rr.name)).toEqual(['www.evil.test']);
    expect(cache.lookup('bank.example.org', RRType.A).kind).toBe('miss');
  });

  it('une délégation vers une zone qui ne contient pas le nom demandé est ignorée', async () => {
    const { resolver, queried } = lab({
      '10.0.0.2': (q) => reply(q, {
        authorities: [makeNsRecord('com', 300, 'ns.com')],
        additionals: [makeARecord('ns.com', 300, '10.0.0.3')],
      }),
      '10.0.0.3': (q) => reply(q, {
        authorities: [makeNsRecord('org', 300, 'ns.attacker.net')],
        additionals: [makeARecord('ns.attacker.net', 300, '10.0.0.4')],
      }),
      '10.0.0.4': (q) => reply(q, { aa: true, answers: [makeARecord('www.bad.com', 300, '6.6.6.6')] }),
    });
    const result = await resolver.resolve('www.bad.com', RRType.A);
    expect(result.status).toBe('SERVFAIL');
    expect(queried.get('10.0.0.4') ?? 0).toBe(0);
  });

  it('un glue hors de la zone du serveur interrogé n’est pas suivi', async () => {
    const { resolver, queried } = lab({
      '10.0.0.2': (q) => reply(q, {
        authorities: [makeNsRecord('com', 300, 'ns.com')],
        additionals: [makeARecord('ns.com', 300, '10.0.0.3')],
      }),
      '10.0.0.3': (q) => reply(q, {
        authorities: [makeNsRecord('bad.com', 300, 'ns.attacker.net')],
        additionals: [makeARecord('ns.attacker.net', 300, '10.0.0.4')],
      }),
      '10.0.0.4': (q) => reply(q, { aa: true, answers: [makeARecord('www.bad.com', 300, '6.6.6.6')] }),
    });
    const result = await resolver.resolve('www.bad.com', RRType.A);
    expect(result.answers.map(aOf)).not.toContain('6.6.6.6');
    expect(queried.get('10.0.0.4') ?? 0).toBe(0);
  });

  it('une réponse dont la question n’est pas celle posée est ignorée', async () => {
    const { resolver } = lab({
      '10.0.0.2': (q) => reply(q, {
        aa: true,
        questions: [{ qname: 'other.test', qtype: RRType.A, qclass: 1 }],
        answers: [makeARecord('www.good.test', 300, '6.6.6.6')],
      }),
    });
    const result = await resolver.resolve('www.good.test', RRType.A);
    expect(result.status).toBe('SERVFAIL');
  });

  it('un NXDOMAIN vaut pour le nom, quel que soit le type (RFC 2308 §5)', async () => {
    const { resolver, queried } = lab({
      '10.0.0.2': (q) => reply(q, { aa: true, rcode: DnsRcode.NXDOMAIN, authorities: [SOA] }),
    });
    expect((await resolver.resolve('ghost.test', RRType.A)).status).toBe('NXDOMAIN');
    const before = queried.get('10.0.0.2') ?? 0;
    const second = await resolver.resolve('ghost.test', RRType.AAAA);
    expect(second.status).toBe('NXDOMAIN');
    expect(queried.get('10.0.0.2') ?? 0).toBe(before);
  });

  it('un NODATA reste propre au type : un autre type est interrogé', async () => {
    const { resolver, queried } = lab({
      '10.0.0.2': (q) => q.questions[0].qtype === RRType.A
        ? reply(q, { aa: true, authorities: [SOA] })
        : reply(q, { aa: true, answers: [makeAaaaRecord('host.test', 300, '2001:db8::5')] }),
    });
    await resolver.resolve('host.test', RRType.A);
    const before = queried.get('10.0.0.2') ?? 0;
    await resolver.resolve('host.test', RRType.AAAA);
    expect(queried.get('10.0.0.2') ?? 0).toBeGreaterThan(before);
  });

  it('une réponse venue d’une autre adresse que le serveur interrogé est ignorée', async () => {
    const holder: { spoofer?: LinuxServer } = {};
    const forged = (q: DnsMessage): Uint8Array => encodeDnsMessage(
      reply(q, { aa: true, answers: [makeARecord('www.good.test', 300, '6.6.6.6')] }));
    const built = lab({
      '10.0.0.2': (q, port) => {
        const bytes = forged(q);
        holder.spoofer!.sendUdpDatagramTo(new IPAddress('10.0.0.1'), port!, 53, bytes, bytes.length);
        return reply(q, { aa: true, rcode: DnsRcode.NXDOMAIN, authorities: [SOA] });
      },
    });
    holder.spoofer = built.spoofer;
    const result = await built.resolver.resolve('www.good.test', RRType.A);
    expect(result.answers.map(aOf)).not.toContain('6.6.6.6');
    expect(result.status).toBe('NXDOMAIN');
  });
});
