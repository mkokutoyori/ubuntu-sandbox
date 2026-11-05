/*
 * The IP identification of every datagram came from ONE counter shared by every machine of the simulation (nextIPv4Id): a capture of a three-hop DNS
 * lab read 177 (client), 178 (DC1), 179 (resolver), 180 (root), 181 (resolver)... a single sequence across hosts that never talk to the same counter.
 * A real host numbers the datagrams it originates itself. createIPv4Packet now takes the identification from a counter per SOURCE address
 * (nextIPv4IdFor), seeded from the address so that two machines never run in lockstep; a forwarder keeps the id it was given, as before.
 *
 * Measured against the commit before (worktree): 2 of the 3 cases fall (the ids of the two machines interleave as one sequence, and the server's
 * sequence depends on the client's traffic). The WITNESS passes either way: each machine's own ids still climb by one per datagram it sends.
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

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc, srv };
}

async function idsBySource(pc: LinuxPC, pings: number): Promise<Record<string, number[]>> {
  await pc.executeCommand('sudo tcpdump -nn -w /tmp/ids.pcap &');
  await pc.executeCommand(`ping -c ${pings} 10.0.0.2`);
  await pc.executeCommand('sudo pkill tcpdump');
  const text = await pc.executeCommand('sudo tcpdump -v -nn -r /tmp/ids.pcap ip');
  const bySource: Record<string, number[]> = {};
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const id = /\bid (\d+),/.exec(line);
    const source = /^\s+(\d+\.\d+\.\d+\.\d+) > /.exec(lines[index + 1] ?? '');
    if (id && source) (bySource[source[1]] ??= []).push(Number(id[1]));
  });
  return bySource;
}

async function serverDelta(extraPings: number): Promise<number> {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  const { pc } = await lab();
  const first = await idsBySource(pc, 1);
  if (extraPings > 0) await pc.executeCommand(`ping -c ${extraPings} 10.0.0.2`);
  const second = await idsBySource(pc, 1);
  return second['10.0.0.2'][0] - first['10.0.0.2'][0];
}

describe('IP identification is numbered by the host that sends', () => {
  it('WITNESS: each machine numbers its own datagrams in increasing order', async () => {
    const { pc } = await lab();
    const ids = await idsBySource(pc, 3);
    expect(ids['10.0.0.1']).toHaveLength(3);
    expect(ids['10.0.0.2']).toHaveLength(3);
    for (const sequence of [ids['10.0.0.1'], ids['10.0.0.2']]) {
      expect(sequence.every((id, i, all) => i === 0 || id > all[i - 1])).toBe(true);
    }
  });

  it('the two machines do not share one interleaved sequence', async () => {
    const { pc } = await lab();
    const ids = await idsBySource(pc, 3);
    const request = ids['10.0.0.1'];
    const reply = ids['10.0.0.2'];
    expect(reply.map((id, i) => id - request[i])).not.toEqual([1, 1, 1]);
  });

  it("the server's numbering does not count the client's datagrams", async () => {
    const quiet = await serverDelta(0);
    const busy = await serverDelta(5);
    expect(busy - quiet).toBeGreaterThanOrEqual(5);
    expect(busy - quiet).toBeLessThanOrEqual(6);
  });
});
