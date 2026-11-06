/*
 * The same packet seen by two machines carried timestamps that no network allows: in the DNS lab the resolver captured the root server's answer 6 ms BEFORE
 * the root server captured the question, and the same one-hop exchange showed 1.0 ms one way and 3.0 ms back. Each machine froze its own base from the
 * real clock at its first observation of a cascade, so the base of two machines differed by the real time the JavaScript took between their observations.
 * One wall anchor is now shared by every machine (PathClock.wallAnchor); a machine adds only its own clock offset (SystemClock.offsetFromSource), so a
 * clock that was set or stepped on one machine stays visible and nothing else differs.
 *
 * Measured against the commit before (worktree): 1 of the 3 cases falls (a reply reaches the client 1 to 4 ms after the server sent it). The 2 that pass either way: the WITNESS
 * (both machines capture every packet) and the stepped-clock case, a NON-REGRESSION showing that the per-machine offset the old code carried is still carried.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Seen { readonly at: number; readonly key: string }

function seen(dump: string): Seen[] {
  return [...dump.matchAll(/^(\d+\.\d+) IP \S+ > \S+: ICMP echo (request|reply), id \d+, seq (\d+)/gm)]
    .map((m) => ({ at: Number(m[1]) * 1000, key: `${m[2]}${m[3]}` }));
}

async function bothCaptures(): Promise<{ client: Seen[]; server: Seen[]; skewed: Seen[] }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await pc.executeCommand('sudo tcpdump -nn -w /tmp/one.pcap &');
  await srv.executeCommand('tcpdump -nn -w /tmp/two.pcap &');
  await pc.executeCommand('ping -c 3 10.0.0.2');
  await pc.executeCommand('sudo pkill tcpdump');
  await srv.executeCommand('pkill tcpdump');
  const client = seen(await pc.executeCommand('sudo tcpdump -nn -tt -r /tmp/one.pcap icmp'));
  const server = seen(await srv.executeCommand('tcpdump -nn -tt -r /tmp/two.pcap icmp'));
  return { client, server, skewed: [] };
}

describe('two machines capturing the same packet read one clock', () => {
  it('WITNESS: both machines capture the six packets of three probes', async () => {
    const { client, server } = await bothCaptures();
    expect(client).toHaveLength(6);
    expect(server).toHaveLength(6);
  });

  it('a packet is never received before it was sent, nor more than 100 microseconds later on a direct cable', async () => {
    const { client, server } = await bothCaptures();
    for (const sent of client.filter((s) => s.key.startsWith('request'))) {
      const received = server.find((s) => s.key === sent.key)!;
      expect(received.at - sent.at).toBeGreaterThanOrEqual(0);
      expect(received.at - sent.at).toBeLessThan(0.1);
    }
    for (const sent of server.filter((s) => s.key.startsWith('reply'))) {
      const received = client.find((s) => s.key === sent.key)!;
      expect(received.at - sent.at).toBeGreaterThanOrEqual(0);
      expect(received.at - sent.at).toBeLessThan(0.1);
    }
  });

  it('a clock stepped on one machine stays visible and nothing else moves', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    await srv.executeCommand('date -s "2030-01-01 00:00:00" >/dev/null');
    await pc.executeCommand('sudo tcpdump -nn -w /tmp/one.pcap &');
    await srv.executeCommand('tcpdump -nn -w /tmp/two.pcap &');
    await pc.executeCommand('ping -c 1 10.0.0.2');
    await pc.executeCommand('sudo pkill tcpdump');
    await srv.executeCommand('pkill tcpdump');
    const client = seen(await pc.executeCommand('sudo tcpdump -nn -tt -r /tmp/one.pcap icmp'));
    const server = seen(await srv.executeCommand('tcpdump -nn -tt -r /tmp/two.pcap icmp'));
    const stepped = server.find((s) => s.key === 'request1')!.at;
    const untouched = client.find((s) => s.key === 'request1')!.at;
    expect(Math.abs(stepped - Date.UTC(2030, 0, 1))).toBeLessThan(5000);
    expect(Math.abs(untouched - Date.now())).toBeLessThan(60_000);
  });
});
