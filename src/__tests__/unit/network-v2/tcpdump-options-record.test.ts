/**
 * Records the two capture labs of tcpdump-options-oracle.test.ts (CE-less LAN with ICMP, TCP, UDP, IPv6, NDP, fragments, HTTP, FTP,
 * SMTP, SSH; and a BIND lab answering A, MX, AAAA, SOA, NS, ANY, NXDOMAIN, a truncated answer and DNS over TCP).
 * It does nothing unless TCPDUMP_RECORD_DIR is set; scripts/oracle/record_tcpdump_options.py then feeds the written capture files to the
 * real tcpdump 4.99.4 and writes src/__tests__/support/oracle/tcpdump-options-4.99.4.json.
 */
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const RECORD_DIR = process.env.TCPDUMP_RECORD_DIR;

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



async function recordBase(): Promise<string> {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await pc1.executeCommand('sudo ip -6 addr add 2001:db8::1/64 dev eth0');
  await pc2.executeCommand('sudo ip -6 addr add 2001:db8::2/64 dev eth0');
  const writing = pc1.executeCommand('sudo tcpdump -w all.cap -c 400');
  await new Promise((r) => setTimeout(r, 30));
  const steps = [
    'ping -c 2 10.0.0.2', 'ping -c 1 -s 3000 10.0.0.2', 'ping -6 -c 2 2001:db8::2', 'ping -6 -c 1 -s 2000 2001:db8::2',
    'ping -c 1 10.0.0.77', 'traceroute -n 10.0.0.2', 'traceroute -6 -n 2001:db8::2',
    'nc -z 10.0.0.2 9001', 'nc -zu 10.0.0.2 9002', 'echo hi | nc -u -w1 10.0.0.2 9003',
    'nc -6 -z 2001:db8::2 9004', 'ping -c 1 -R 10.0.0.2', 'ping -c 1 -Q 0x10 10.0.0.2', 'ntpdate -q 10.0.0.2', 'ssh -o BatchMode=yes -o ConnectTimeout=1 root@10.0.0.2 true', 'curl -s -m 2 http://10.0.0.2:9000/', 'ping -c 1 -t 1 10.0.0.2', 'ping -c 1 -M do -s 1472 10.0.0.2',
  ];
  await pc2.executeCommand('nc -l -p 9000 &');
  await pc1.executeCommand('echo hello | nc 10.0.0.2 9000');
  for (const step of steps) await pc1.executeCommand(step);
  await pc2.executeCommand('nc -6 -l -p 9100 &');
  await pc1.executeCommand('echo hello6 | nc -6 2001:db8::2 9100');
  for (const port of [80, 21, 25, 22, 23, 8080]) await pc2.executeCommand(`sudo nc -l -p ${port} &`);
  await pc1.executeCommand("printf 'GET /index.html HTTP/1.1\\r\\nHost: pc2\\r\\nUser-Agent: x\\r\\n\\r\\n' | nc 10.0.0.2 80");
  await pc1.executeCommand("printf 'USER anonymous\\r\\nPASS x\\r\\n' | nc 10.0.0.2 21");
  await pc1.executeCommand("printf 'EHLO pc1\\r\\nMAIL FROM:<a@b>\\r\\n' | nc 10.0.0.2 25");
  await pc1.executeCommand("printf 'SSH-2.0-OpenSSH_9.6\\r\\n' | nc 10.0.0.2 22");
  await pc1.executeCommand("printf 'hello telnet\\r\\n' | nc 10.0.0.2 23");
  await pc1.executeCommand("printf 'POST /x HTTP/1.0\\r\\nContent-Length: 3\\r\\n\\r\\nabc' | nc 10.0.0.2 8080");
  await writing;
  return pc1.executeCommand('cat all.cap');
}

async function recordDns(): Promise<string> {
  const { pc } = await buildDnsLab();
  const writing = pc.executeCommand('sudo tcpdump -w all.cap -c 60');
  await new Promise((r) => setTimeout(r, 30));
  for (const step of [
    'dig @10.0.1.10 www.example.com A', 'dig @10.0.1.10 example.com MX', 'dig @10.0.1.10 www6.example.com AAAA',
    'dig @10.0.1.10 nope.example.com A', 'dig @10.0.1.10 many.example.com A', 'dig @10.0.1.10 example.com SOA',
    'dig @10.0.1.10 example.com NS', 'dig @10.0.1.10 example.com ANY', 'dig @10.0.1.10 +tcp www.example.com A',
    'dig @10.0.1.10 -x 10.0.1.80', 'dig @10.0.1.10 www.other.org A', 'dig @10.0.1.10 +norecurse example.com TXT',
  ]) await pc.executeCommand(step);
  for (let i = 0; i < 12; i++) await pc.executeCommand('dig @10.0.1.10 www.example.com A');
  await writing;
  return pc.executeCommand('cat all.cap');
}

it.skipIf(RECORD_DIR === undefined)('records the capture files', async () => {
  mkdirSync(RECORD_DIR as string, { recursive: true });
  writeFileSync(`${RECORD_DIR}/base.json`, await recordBase());
  writeFileSync(`${RECORD_DIR}/dns.json`, await recordDns());
}, 480000);
