/**
 * Scénario 2 — Capture et décodage du trafic DNS : résolution, TTL,
 * troncation UDP/bascule TCP, NXDOMAIN, anomalies. Assertions basées
 * uniquement sur la sortie tcpdump, jamais sur la sortie de `dig`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const PC_IP = '10.0.1.2';
const BIG_RRSET_SIZE = 60;

function zoneFile(): string {
  const lines = [
    '$ORIGIN example.com.',
    '$TTL 3600',
    '@       IN SOA  ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
    '        IN NS   ns1.example.com.',
    '@       IN MX   10 mail.example.com.',
    'ns1     IN A    10.0.1.10',
    'www     IN A    10.0.1.80',
    'mail    IN A    10.0.1.25',
    'www6    IN AAAA 2001:db8::80',
    'many    30 IN A 198.51.100.1',
  ];
  for (let i = 2; i <= BIG_RRSET_SIZE; i++) {
    lines.push(`many    IN A    198.51.100.${i}`);
  }
  lines.push('');
  return lines.join('\n');
}

function namedConf(): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    '};',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    '};',
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}
function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildDnsLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'NS1');
  pc.configureInterface('eth0', new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', zoneFile());
  await srv.executeCommand('systemctl start named');
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  EquipmentRegistry.resetInstance();
});

async function captureDns(pc: LinuxPC, filter: string, stimulus: () => Promise<unknown>): Promise<string> {
  const pending = pc.executeCommand(`tcpdump -nn -vvv ${filter}`);
  await new Promise((r) => setTimeout(r, 20));
  await stimulus();
  await new Promise((r) => setTimeout(r, 30));
  return pending;
}

describe('Scénario 2 — Capture et décodage du trafic DNS', () => {
  it('la commande de capture DNS (port 53 UDP/TCP) réussit sans erreur, avec écriture pcap', async () => {
    const { pc } = await buildDnsLab();
    const output = await pc.executeCommand(
      `tcpdump -i eth0 -nn -vvv 'port 53 or (tcp and port 53)' -w /tmp/dns-capture.pcap`,
    );
    expect(output).not.toMatch(/tcpdump: error/);
    expect(output).toContain('packets captured');
  });

  describe('décodage des réponses DNS', () => {
    it('réponse A standard : type, adresse et TTL résiduel visibles sans dig', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} www.example.com A`));

      expect(dump).toMatch(/A\? www\.example\.com/);
      expect(dump).toMatch(/A 10\.0\.1\.80 ttl 3600/);
    });

    it('réponse MX : priorité, serveur de mail et TTL visibles sans dig', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} example.com MX`));

      expect(dump).toMatch(/MX\? example\.com/);
      expect(dump).toMatch(/MX 10 mail\.example\.com\.? ttl 3600/);
    });

    it('réponse AAAA : adresse IPv6 et TTL visibles sans dig', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} www6.example.com AAAA`));

      expect(dump).toMatch(/AAAA\? www6\.example\.com/);
      expect(dump).toMatch(/AAAA 2001:db8::80 ttl 3600/);
    });

    it('résolution d\'un nom inexistant : NXDOMAIN dans les flags avec AUTHORITY SECTION pointant vers la SOA de la zone', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} doesnotexist.example.com`));

      expect(dump).toMatch(/NXDomain/);
      expect(dump).toMatch(/authority: SOA ns1\.example\.com/);
    });
  });

  describe('bascule UDP vers TCP', () => {
    it('un jeu de réponses > 512 octets positionne TC=1 en UDP puis bascule immédiatement vers un handshake TCP/53 avec la même requête retransmise', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `port 53`, () => pc.executeCommand(`dig @${NS1_IP} many.example.com A`));

      const lines = dump.split('\n');
      const truncatedUdpIdx = lines.findIndex((l) => l.includes('truncated, TC'));
      expect(truncatedUdpIdx).toBeGreaterThanOrEqual(0);

      const after = lines.slice(truncatedUdpIdx + 1).join('\n');
      expect(after).toMatch(/Flags \[S\]/);
      expect(after).toMatch(/Flags \[S\.\]/);
      expect(after).toMatch(/A\? many\.example\.com/);

      const tcpResponseLine = lines.find((l) => l.includes(`60/0/0`));
      expect(tcpResponseLine).toBeDefined();
      expect(tcpResponseLine).not.toContain('truncated');
    });

    it('une requête ANY sur le même nom déclenche aussi la troncation et la bascule TCP', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `port 53`, () => pc.executeCommand(`dig @${NS1_IP} many.example.com ANY`));

      expect(dump).toMatch(/ANY\? many\.example\.com/);
      expect(dump).toMatch(/truncated, TC/);
      expect(dump).toMatch(/Flags \[S\]/);
    });
  });

  describe('détection d\'anomalie', () => {
    it('détecte un TTL anormalement bas (< 60s) et une incohérence de TTL au sein du même enregistrement round-robin', async () => {
      const { pc } = await buildDnsLab();
      const dump = await captureDns(pc, `tcp port 53`, () => pc.executeCommand(`dig @${NS1_IP} many.example.com A`));

      const ttls = Array.from(dump.matchAll(/A 198\.51\.100\.\d+ ttl (\d+)/g)).map((m) => Number(m[1]));
      expect(ttls.length).toBeGreaterThan(1);

      const ips = new Set(Array.from(dump.matchAll(/A (198\.51\.100\.\d+) ttl/g)).map((m) => m[1]));
      expect(ips.size).toBeGreaterThan(1);

      expect(Math.min(...ttls)).toBeLessThan(60);
      expect(new Set(ttls).size).toBeGreaterThan(1);
    });
  });

  describe('critère de réussite', () => {
    it('tcpdump seul expose type, TTL et rcode (NOERROR/NXDOMAIN) pour chaque échange, sans dépendre de la sortie de dig', async () => {
      const { pc } = await buildDnsLab();

      const okDump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} www.example.com A`));
      expect(okDump).toMatch(/A 10\.0\.1\.80 ttl 3600/);
      expect(okDump).not.toMatch(/NXDomain|ServFail/);

      const nxDump = await captureDns(pc, `udp port 53`, () => pc.executeCommand(`dig @${NS1_IP} nope.example.com A`));
      expect(nxDump).toMatch(/NXDomain/);
    });
  });
});
