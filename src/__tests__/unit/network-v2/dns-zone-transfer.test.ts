import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import type { SoaRecordData, ResourceRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { SecondaryZoneAgent } from '@/network/dns/transfer/SecondaryZoneAgent';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const ORIGIN = 'example.com';
const INITIAL_SERIAL = 2026070100;

function buildZone(): Zone {
  const zone = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial: INITIAL_SERIAL, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord(`ns1.${ORIGIN}`, 3600, '10.0.0.1'));
  zone.addRecord(makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.10'));
  return zone;
}

function makeQuery(qname: string, qtype: number, id = 7): DnsMessage {
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met within timeout');
}

interface Lab {
  client: LinuxPC;
  primary: PrimaryZoneAgent;
  secondary: SecondaryZoneAgent;
  transferLog: { qtype: number; response: DnsMessage }[];
}

function buildLab(options: { journalLimit?: number } = {}): Lab {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const primaryHost = new LinuxServer('linux-server', 'ns-primary', 0, 0);
  const secondaryHost = new LinuxServer('linux-server', 'ns-secondary', 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);

  const mask = new SubnetMask('255.255.255.0');
  [primaryHost, secondaryHost, client].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  primaryHost.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  secondaryHost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), mask);

  const primary = new PrimaryZoneAgent(primaryHost, buildZone(), {
    secondaries: [new IPAddress('10.0.0.2')],
    journalLimit: options.journalLimit,
  });
  primary.start();

  const transferLog: { qtype: number; response: DnsMessage }[] = [];
  primary.onTransfer((qtype, response) => transferLog.push({ qtype, response }));

  const secondary = new SecondaryZoneAgent(secondaryHost, ORIGIN, new IPAddress('10.0.0.1'));
  secondary.start();

  return { client, primary, secondary, transferLog };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('AXFR — full zone transfer over TCP (RFC 5936)', () => {
  it('bootstraps the secondary with a SOA-delimited full transfer, then serves authoritatively', async () => {
    const lab = buildLab();

    await lab.secondary.refresh();

    expect(lab.transferLog).toHaveLength(1);
    expect(lab.transferLog[0].qtype).toBe(RRType.AXFR);
    const answers = lab.transferLog[0].response.answers;
    expect(answers[0].data.type).toBe(RRType.SOA);
    expect(answers[answers.length - 1].data.type).toBe(RRType.SOA);
    expect(answers.length).toBeGreaterThan(2);

    const reply = await queryDnsOverUdp(lab.client, new IPAddress('10.0.0.2'), makeQuery(`www.${ORIGIN}`, RRType.A));
    expect(reply!.flags.aa).toBe(true);
    expect((reply!.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.10');
  }, 15000);

  it('refuses AXFR over UDP', async () => {
    const lab = buildLab();

    const reply = await queryDnsOverUdp(lab.client, new IPAddress('10.0.0.1'), makeQuery(ORIGIN, RRType.AXFR));

    expect(reply!.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 15000);
});

describe('NOTIFY + IXFR — incremental replication (RFC 1996, RFC 1995)', () => {
  it('propagates an update to the secondary via NOTIFY-triggered IXFR', async () => {
    const lab = buildLab();
    await lab.secondary.refresh();

    await lab.primary.applyUpdate({
      additions: [makeARecord(`new.${ORIGIN}`, 3600, '192.0.2.99')],
      removals: [],
    });

    await waitUntil(async () => {
      const reply = await queryDnsOverUdp(lab.client, new IPAddress('10.0.0.2'), makeQuery(`new.${ORIGIN}`, RRType.A));
      return reply !== null && reply.answers.length === 1;
    });

    const ixfr = lab.transferLog.find((t) => t.qtype === RRType.IXFR);
    expect(ixfr).toBeDefined();
    expect(ixfr!.response.answers[0].data.type).toBe(RRType.SOA);
    expect(ixfr!.response.answers[1].data.type).toBe(RRType.SOA);
    expect((ixfr!.response.answers[1].data as SoaRecordData).serial).toBe(INITIAL_SERIAL);
  }, 15000);

  it('applies deletions carried by an IXFR delta', async () => {
    const lab = buildLab();
    await lab.secondary.refresh();

    await lab.primary.applyUpdate({
      additions: [],
      removals: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.10')],
    });

    await waitUntil(async () => {
      const reply = await queryDnsOverUdp(lab.client, new IPAddress('10.0.0.2'), makeQuery(`www.${ORIGIN}`, RRType.A));
      return reply !== null && reply.answers.length === 0 && reply.flags.rcode === DnsRcode.NXDOMAIN;
    });
  }, 15000);

  it('falls back to a full transfer when the journal no longer covers the client serial', async () => {
    const lab = buildLab({ journalLimit: 1 });
    await lab.secondary.refresh();

    await lab.primary.applyUpdate({ additions: [makeARecord(`a1.${ORIGIN}`, 3600, '192.0.2.1')], removals: [], notify: false });
    await lab.primary.applyUpdate({ additions: [makeARecord(`a2.${ORIGIN}`, 3600, '192.0.2.2')], removals: [], notify: false });

    await lab.secondary.refresh();

    const ixfr = lab.transferLog.filter((t) => t.qtype === RRType.IXFR);
    expect(ixfr).toHaveLength(1);
    expect(ixfr[0].response.answers[1].data.type).not.toBe(RRType.SOA);

    const reply = await queryDnsOverUdp(lab.client, new IPAddress('10.0.0.2'), makeQuery(`a1.${ORIGIN}`, RRType.A));
    expect(reply!.answers).toHaveLength(1);
  }, 15000);

  it('answers a current-serial IXFR with the lone SOA (already up to date)', async () => {
    const lab = buildLab();
    await lab.secondary.refresh();

    const soa = lab.primary.zone.soa;
    const query: DnsMessage = {
      ...makeQuery(ORIGIN, RRType.IXFR, 11),
      authorities: [soa as ResourceRecord<SoaRecordData>],
    };
    const reply = await queryDnsOverTcp(lab.client, new IPAddress('10.0.0.1'), query);

    expect(reply!.answers).toHaveLength(1);
    expect(reply!.answers[0].data.type).toBe(RRType.SOA);
  }, 15000);

  it('does not transfer again when the secondary is already current', async () => {
    const lab = buildLab();
    await lab.secondary.refresh();
    const transfersAfterBootstrap = lab.transferLog.length;

    await lab.secondary.refresh();

    expect(lab.transferLog.length).toBe(transfersAfterBootstrap);
  }, 15000);
});
