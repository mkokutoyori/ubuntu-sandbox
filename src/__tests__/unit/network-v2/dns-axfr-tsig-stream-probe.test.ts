/**
 * Transfert de zone sur plusieurs messages, signé TSIG (RFC 2845 §4.4).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 6 cas sur 8 tombent.
 *   - une zone de 1500 enregistrements partait dans un seul message
 *   - le serveur ignorait la signature de la requête de transfert et ne signait
 *     rien ; `allow-transfer { key … }` et `primaries { … key … }` étaient refusés
 *     par named.conf
 *   - aucune fonction ne signait ni ne vérifiait une chaîne de messages
 * Passent avant et après : le témoin (un transfert non signé d'une petite zone
 * aboutit entre deux named) et le secret faux (non discriminant avant : named.conf
 * refusait la configuration, donc rien n'était transféré).
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
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import { Zone } from '@/network/dns/zone/Zone';
import { buildTransferMessages, transferComplete, buildAxfrAnswers } from '@/network/dns/transfer/AxfrSession';
import {
  signMessageStream, verifyMessageStream, TsigKeyring, TsigAlgorithm, type TsigKey,
} from '@/network/dns/tsig/Tsig';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const SECRET = 'c2VjcmV0LXBhcnRhZ2U=';
const NOW = 1_800_000_000;
const KEY: TsigKey = { name: 'lab-key.', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage' };

function bigZone(records: number): Zone {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 7, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 3600, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '10.0.1.10'));
  for (let i = 0; i < records; i++) zone.addRecord(makeARecord(`host${i}.example.com`, 300, `192.0.2.${(i % 250) + 1}`));
  return zone;
}

function transferQuery(): DnsMessage {
  return {
    id: 77,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'example.com', qtype: RRType.AXFR, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const vfsOf = (s: LinuxServer) => (s as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (s: LinuxServer, path: string, content: string) => vfsOf(s).writeFile(path, content, 0, 0, 0o022);

function zoneDb(extra: number): string {
  return [
    '$ORIGIN example.com.', '$TTL 3600',
    '@ IN SOA ns1.example.com. admin.example.com. ( 7 3600 900 604800 300 )',
    '  IN NS ns1.example.com.', '  IN NS ns2.example.com.',
    'ns1 IN A 10.0.1.10', 'ns2 IN A 10.0.1.20', 'www IN A 10.0.1.80',
    ...Array.from({ length: extra }, (_, i) => `h${i} IN A 192.0.2.${(i % 250) + 1}`), '',
  ].join('\n');
}

function labNamed(options: { signed: boolean; wrongSecret?: boolean; hosts?: number }) {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const primary = new LinuxServer('linux-server', 'NS1');
  const secondary = new LinuxServer('linux-server', 'NS2');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [primary, secondary, pc].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  primary.getPorts()[0].configureIP(new IPAddress('10.0.1.10'), mask);
  secondary.getPorts()[0].configureIP(new IPAddress('10.0.1.20'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), mask);
  const keyBlock = (secret: string) => `key "lab-key" { algorithm hmac-sha256; secret "${secret}"; };\n`;
  write(primary, '/etc/bind/named.conf', [
    options.signed ? keyBlock(SECRET) : '',
    'options { recursion no; };',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com";',
    `  also-notify { 10.0.1.20; }; allow-transfer { ${options.signed ? 'key lab-key;' : '10.0.1.20;'} }; };`, '',
  ].join('\n'));
  write(primary, '/etc/bind/db.example.com', zoneDb(options.hosts ?? 0));
  write(secondary, '/etc/bind/named.conf', [
    options.signed ? keyBlock(options.wrongSecret ? 'cGFzLWxlLWJvbg==' : SECRET) : '',
    'options { recursion no; };',
    'zone "example.com" { type secondary;',
    `  primaries { 10.0.1.10${options.signed ? ' key lab-key' : ''}; }; file "db.example.com"; };`, '',
  ].join('\n'));
  return { pc, primary, secondary };
}

async function answered(pc: LinuxPC, name: string): Promise<boolean> {
  const q: DnsMessage = { ...transferQuery(), id: 5, questions: [{ qname: name, qtype: RRType.A, qclass: DnsClass.IN }] };
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await queryDnsOverUdp(pc, new IPAddress('10.0.1.20'), q, 53, 300);
    if (r && r.flags.rcode === DnsRcode.NOERROR && r.answers.length > 0) {
      return (r.answers[0].data as ARecordData).address.toString().length > 0;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('AXFR en plusieurs messages', () => {
  it('une grande zone est découpée, chaque message sous le budget, et se reconnaît comme complète', () => {
    const zone = bigZone(1500);
    const messages = buildTransferMessages(transferQuery(), buildAxfrAnswers(zone));
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(encodeDnsMessage(m).length).toBeLessThanOrEqual(16384 + 200);
    expect(transferComplete(messages.slice(0, -1))).toBe(false);
    expect(transferComplete(messages)).toBe(true);
    expect(messages.flatMap((m) => m.answers)).toHaveLength(buildAxfrAnswers(zone).length);
  });
});

describe('chaîne TSIG de transfert (RFC 2845 §4.4)', () => {
  const ring = () => { const r = new TsigKeyring(); r.add(KEY); return r; };
  const signed = () => signMessageStream(buildTransferMessages(transferQuery(), buildAxfrAnswers(bigZone(1500))), {
    key: KEY, timeSigned: NOW, requestMac: new Uint8Array([1, 2, 3, 4]),
  });

  it('une chaîne intacte se vérifie', () => {
    const frames = signed().map((m) => encodeDnsMessage(m));
    expect(frames.length).toBeGreaterThan(1);
    expect(verifyMessageStream(frames, { lookup: ring().lookup, now: NOW, requestMac: new Uint8Array([1, 2, 3, 4]) }).ok).toBe(true);
  });

  it('un message supprimé de la chaîne la rompt', () => {
    const frames = signed().map((m) => encodeDnsMessage(m));
    frames.splice(1, 1);
    expect(verifyMessageStream(frames, { lookup: ring().lookup, now: NOW, requestMac: new Uint8Array([1, 2, 3, 4]) }).ok).toBe(false);
  });

  it('deux messages permutés rompent la chaîne', () => {
    const frames = signed().map((m) => encodeDnsMessage(m));
    [frames[1], frames[2]] = [frames[2], frames[1]];
    expect(verifyMessageStream(frames, { lookup: ring().lookup, now: NOW, requestMac: new Uint8Array([1, 2, 3, 4]) }).ok).toBe(false);
  });

  it('une chaîne liée à une autre requête est rejetée', () => {
    const frames = signed().map((m) => encodeDnsMessage(m));
    expect(verifyMessageStream(frames, { lookup: ring().lookup, now: NOW, requestMac: new Uint8Array([9, 9]) }).ok).toBe(false);
  });
});

describe('transfert named → named', () => {
  it('témoin : un transfert non signé d’une petite zone aboutit', async () => {
    const { pc, primary, secondary } = labNamed({ signed: false });
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');
    expect(await answered(pc, 'www.example.com')).toBe(true);
  }, 25000);

  it('un transfert signé, d’une zone en plusieurs messages, aboutit', async () => {
    const { pc, primary, secondary } = labNamed({ signed: true, hosts: 1500 });
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');
    expect(await answered(pc, 'h1499.example.com')).toBe(true);
  }, 30000);

  it('un secondaire dont le secret est faux ne reçoit pas la zone', async () => {
    const { pc, primary, secondary } = labNamed({ signed: true, wrongSecret: true });
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');
    expect(await answered(pc, 'www.example.com')).toBe(false);
  }, 30000);
});
