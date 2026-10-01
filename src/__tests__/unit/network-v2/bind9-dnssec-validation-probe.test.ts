/**
 * Sonde de la validation DNSSEC de named (RFC 4035 §3.2.2, §3.2.3, RFC 6840 §5.7).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 5 cas sur 6 tombent.
 *   - named.conf refusait « trust-anchors » : named ne démarre pas
 *   - aucun résolveur n'était construit avec des ancres, donc jamais de
 *     validation, jamais de bit AD, et une réponse falsifiée passait
 *   - le bit CD de la requête n'était pas renvoyé
 * Passe avant et après (témoin) : sans ancre, une réponse est servie sans AD.
 */

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
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { generateZoneKey, makeDsForKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function query(flags: { ad?: boolean; cd?: boolean; dnssecOk?: boolean }): DnsMessage {
  return {
    id: 77,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false,
      ad: flags.ad ?? false, cd: flags.cd ?? false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname: 'www.lab.test', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [],
    additionals: flags.dnssecOk ? [makeOptRecord(4096, { dnssecOk: true })] : [],
  };
}

async function lab(options: { anchor: boolean; tamper?: boolean }) {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const auth = new LinuxServer('linux-server', 'AUTH');
  const ns = new LinuxServer('linux-server', 'NS1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [auth, ns, pc].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  auth.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  ns.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);

  const zone = new Zone('lab.test', makeSoaRecord('lab.test', 3600, {
    mname: 'ns.lab.test', rname: 'h.lab.test', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('lab.test', 3600, 'ns.lab.test'));
  zone.addRecord(makeARecord('ns.lab.test', 3600, '10.0.0.2'));
  zone.addRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
  const ksk = generateZoneKey('lab.test', 'ksk', 3600);
  signZone(zone, { zsk: generateZoneKey('lab.test', 'zsk', 3600), ksk });
  if (options.tamper) {
    const forged = makeARecord('www.lab.test', 300, '6.6.6.6');
    zone.removeRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
    zone.addRecord(forged);
  }
  new PrimaryZoneAgent(auth, zone).start();

  const ds = makeDsForKey('lab.test', 3600, ksk).data;
  const anchor = options.anchor
    ? `trust-anchors { "lab.test." static-ds ${ds.keyTag} ${ds.algorithm} ${ds.digestType} "${ds.digest}"; };\n`
    : '';
  vfsOf(ns).writeFile('/etc/bind/named.conf', [
    anchor,
    'options { recursion yes; allow-recursion { any; }; dnssec-validation auto; forwarders { 10.0.0.2; }; };',
    '',
  ].join('\n'), 0, 0, 0o022);
  const start = await ns.executeCommand('systemctl start named');
  return { pc, start };
}

const ask = (pc: LinuxPC, flags: Parameters<typeof query>[0]) =>
  queryDnsOverUdp(pc, new IPAddress('10.0.0.3'), query(flags), 53, 3000);

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — validation DNSSEC', () => {
  it('témoin : sans ancre, la réponse est servie sans bit AD', async () => {
    const { pc } = await lab({ anchor: false });
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.ad).toBe(false);
  });

  it('avec ancre et DO, la réponse validée porte AD et ses RRSIG', async () => {
    const { pc, start } = await lab({ anchor: true });
    expect(start).not.toContain('Failed');
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.ad).toBe(true);
    expect(r?.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(true);
  });

  it('sans DO ni AD dans la requête, pas de bit AD et pas de RRSIG', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc, {});
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.ad).toBe(false);
    expect(r?.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(false);
  });

  it('une requête avec AD (RFC 6840 §5.7) obtient AD sans DO', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc, { ad: true });
    expect(r?.flags.ad).toBe(true);
  });

  it('une réponse falsifiée est bogus : SERVFAIL', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  });

  it('avec CD, la même réponse falsifiée est rendue et CD est renvoyé', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    const r = await ask(pc, { dnssecOk: true, cd: true });
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.cd).toBe(true);
    expect(r?.flags.ad).toBe(false);
  });
});
