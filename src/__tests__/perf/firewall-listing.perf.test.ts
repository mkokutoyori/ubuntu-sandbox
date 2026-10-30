/**
 * Banc des listages `iptables -L` et `ufw status` : coût selon le nombre de règles, dérive, mémoire retenue.
 *
 *   FIREWALL_PERF=1 PERF_OUT=/tmp/fw.txt node_modules/.bin/vitest run src/__tests__/perf/firewall-listing.perf.test.ts
 */

import { appendFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

const enabled = process.env.FIREWALL_PERF === '1';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;

function report(name: string, value: number | string): void {
  const line = `PERF ${name} ${value}\n`;
  if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line);
}

function heapMb(): number {
  collect();
  collect();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

describe.skipIf(!enabled)('listages du pare-feu', () => {
  it('iptables -L : coût par règle et dérive', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    for (let i = 0; i < 2000; i++) {
      await srv.executeCommand(`iptables -A INPUT -p tcp -s 10.${i % 250}.${(i >> 8) & 255}.0/24 --dport ${1000 + (i % 60000)} -j DROP`);
    }
    const timeOf = async (n: number): Promise<number> => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await srv.executeCommand('iptables -L INPUT -vn');
      return (performance.now() - t0) / n;
    };
    const first = await timeOf(20);
    const before = heapMb();
    await timeOf(200);
    const last = await timeOf(20);
    const retained = heapMb() - before;
    report('iptables-L-2000-rules-ms', first.toFixed(2));
    report('iptables-L-drift-ratio', (last / first).toFixed(2));
    report('iptables-L-retained-mb', retained.toFixed(2));
    expect(last / first).toBeLessThan(2);
    expect(retained).toBeLessThan(20);
  }, 600000);

  it('ufw status : coût et dérive avec 300 règles', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    await srv.executeCommand('ufw enable');
    for (let i = 0; i < 300; i++) await srv.executeCommand(`ufw allow ${2000 + i}/tcp`);
    const timeOf = async (n: number): Promise<number> => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await srv.executeCommand('ufw status numbered');
      return (performance.now() - t0) / n;
    };
    const first = await timeOf(20);
    const last = await timeOf(100);
    report('ufw-status-300-rules-ms', first.toFixed(2));
    report('ufw-status-drift-ratio', (last / first).toFixed(2));
    expect(last / first).toBeLessThan(2);
  }, 600000);

  it('filterPacket : coût d\'une règle connlimit selon le nombre de flux suivis', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    await srv.executeCommand('iptables -A INPUT -p tcp -m connlimit --connlimit-above 100000 -j DROP');
    const manager = (srv as unknown as { executor: { iptables: { filterPacket(p: object, s?: object): string } } }).executor.iptables;
    const syn = (port: number) => ({ direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: port, dstPort: 22, iface: 'eth0', tcpFlags: 2, ipPacketBytes: 60 });
    for (const flows of [100, 1000, 4000]) {
      for (let i = 0; i < flows; i++) manager.filterPacket(syn(10000 + i), {});
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) manager.filterPacket(syn(60000 + i), {});
      report(`connlimit-ms-per-packet-with-${flows}-flows`, ((performance.now() - t0) / 100).toFixed(3));
    }
  }, 600000);

  it('ipset : coût d\'un test d\'appartenance et d\'un ajout selon la taille de l\'ensemble', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    const manager = (srv as unknown as { executor: { ipset: { execute(a: string[]): unknown; contains(n: string, ip: string): boolean } } }).executor.ipset;
    manager.execute(['create', 'big', 'hash:ip', 'maxelem', '200000', 'timeout', '600']);
    const baseline = heapMb();
    let added = 0;
    for (const size of [1000, 10000, 60000]) {
      for (; added < size; added++) manager.execute(['add', 'big', `10.${(added >> 16) & 255}.${(added >> 8) & 255}.${added & 255}`]);
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) manager.contains('big', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      report(`ipset-contains-us-with-${size}-elements`, (((performance.now() - t0) * 1000) / 2000).toFixed(2));
    }
    report('ipset-bytes-per-element', (((heapMb() - baseline) * 1048576) / 60000).toFixed(0));
  }, 600000);
});
