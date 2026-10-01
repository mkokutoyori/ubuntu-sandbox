/**
 * Sonde de la validation DNSSEC du rôle Windows DNS Server
 * (Add-DnsServerTrustAnchor ; RFC 4035 §3.2).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 4 cas sur 5 tombent.
 * Add-DnsServerTrustAnchor n'existait pas et le serveur ne validait jamais :
 * pas de bit AD, une réponse falsifiée était servie. Passe avant et après
 * (témoin) : sans ancre, la réponse est servie sans AD.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { generateZoneKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const run = async (d: WindowsServer, line: string) =>
  (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');

function query(cd = false): DnsMessage {
  return {
    id: 5,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd,
      rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname: 'www.lab.test', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [makeOptRecord(4096, { dnssecOk: true })],
  };
}

async function lab(options: { anchor: boolean; tamper?: boolean }) {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const auth = new LinuxServer('linux-server', 'AUTH');
  const wns = new WindowsServer('DNS1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [auth, wns, pc].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  auth.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  wns.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  wns.setCurrentUser('Administrator');

  const zone = new Zone('lab.test', makeSoaRecord('lab.test', 3600, {
    mname: 'ns.lab.test', rname: 'h.lab.test', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('lab.test', 3600, 'ns.lab.test'));
  zone.addRecord(makeARecord('ns.lab.test', 3600, '10.0.0.2'));
  zone.addRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
  const ksk = generateZoneKey('lab.test', 'ksk', 3600);
  signZone(zone, { zsk: generateZoneKey('lab.test', 'zsk', 3600), ksk });
  if (options.tamper) {
    zone.removeRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
    zone.addRecord(makeARecord('www.lab.test', 300, '6.6.6.6'));
  }
  new PrimaryZoneAgent(auth, zone).start();

  await run(wns, 'Install-WindowsFeature DNS');
  await run(wns, 'Add-DnsServerForwarder -IPAddress 10.0.0.2');
  let added = '';
  if (options.anchor) {
    added = await run(wns,
      `Add-DnsServerTrustAnchor -Name lab.test -CryptoAlgorithm EcdsaP256Sha256 -Base64Data "${ksk.data.publicKey}"`);
  }
  return { pc, added, wns };
}

const ask = (pc: LinuxPC, cd = false) =>
  queryDnsOverUdp(pc, new IPAddress('10.0.0.3'), query(cd), 53, 3000);

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('Windows DNS — validation DNSSEC', () => {
  it('témoin : sans ancre, la réponse est servie sans AD', async () => {
    const { pc } = await lab({ anchor: false });
    const r = await ask(pc);
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.ad).toBe(false);
  });

  it('Add-DnsServerTrustAnchor enregistre l’ancre, Get-DnsServerTrustAnchor la liste', async () => {
    const { added, wns } = await lab({ anchor: true });
    expect(added).toBe('');
    expect(await run(wns, 'Get-DnsServerTrustAnchor')).toContain('lab.test');
  });

  it('avec ancre, la réponse validée porte AD', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc);
    expect(r?.flags.ad).toBe(true);
  });

  it('une réponse falsifiée est SERVFAIL', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    expect((await ask(pc))?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  });

  it('avec CD, la réponse falsifiée est rendue', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    const r = await ask(pc, true);
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.cd).toBe(true);
  });
});
