/*
 * 'ping' printed time=0.003 ms while the pinger's own tcpdump put the echo reply 2.002 ms after the echo request. The RTT is read from the simulated
 * path clock (PathClock), but a capture timestamp was taken from a per-machine base re-read from the REAL clock each time a machine first observed a
 * new cascade, so the real compute time of the JavaScript between the request leaving (observed outside the cascade) and the reply arriving (observed
 * inside a cascade of its own) leaked into the capture: 1 to 4 ms of wall-clock noise on a path whose simulated transit is a few microseconds.
 * Equipment.observationMicros now reads one timeline for every observation: a wall anchor shared by all machines (PathClock.wallAnchor, re-synchronised
 * with the real clock after a pause of more than 100 ms or a drift of more than 1 s) plus the machine's own clock offset plus PathClock.now().
 *
 * Measured against the commit before (worktree): 2 of the 3 cases fall (the capture interval is 1 to 4 ms where ping prints a few microseconds, twice). The WITNESS passes
 * either way: ping still prints one time= per probe and the capture still holds each request with its reply.
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

interface Seen { readonly at: number; readonly type: 'request' | 'reply'; readonly seq: number }

function seen(dump: string): Seen[] {
  return [...dump.matchAll(/^(\d+\.\d+) IP \S+ > \S+: ICMP echo (request|reply), id \d+, seq (\d+)/gm)]
    .map((m) => ({ at: Number(m[1]) * 1000, type: m[2] as 'request' | 'reply', seq: Number(m[3]) }));
}

async function pinged(pings: number): Promise<{ times: number[]; client: Seen[] }> {
  const { pc, srv } = await lab();
  await pc.executeCommand('sudo tcpdump -nn -w /tmp/rtt.pcap &');
  const output = await pc.executeCommand(`ping -c ${pings} 10.0.0.2`);
  await pc.executeCommand('sudo pkill tcpdump');
  const times = [...output.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1]));
  const client = seen(await pc.executeCommand('sudo tcpdump -nn -tt -r /tmp/rtt.pcap icmp'));
  expect(srv).toBeDefined();
  return { times, client };
}

describe('the RTT ping prints is the interval its own capture shows', () => {
  it('WITNESS: one time= per probe and one request / reply pair per probe in the capture', async () => {
    const { times, client } = await pinged(3);
    expect(times).toHaveLength(3);
    expect(client.map((s) => `${s.type}${s.seq}`)).toEqual(['request1', 'reply1', 'request2', 'reply2', 'request3', 'reply3']);
  });

  it('the capture interval of request and reply is the time= ping printed, to the microsecond', async () => {
    const { times, client } = await pinged(3);
    for (const seq of [1, 2, 3]) {
      const request = client.find((s) => s.type === 'request' && s.seq === seq)!;
      const reply = client.find((s) => s.type === 'reply' && s.seq === seq)!;
      expect(Math.abs(reply.at - request.at - times[seq - 1])).toBeLessThanOrEqual(0.005);
    }
  });

  it('no probe takes a millisecond on a direct cable', async () => {
    const { client } = await pinged(3);
    for (const seq of [1, 2, 3]) {
      const request = client.find((s) => s.type === 'request' && s.seq === seq)!;
      const reply = client.find((s) => s.type === 'reply' && s.seq === seq)!;
      expect(reply.at - request.at).toBeLessThan(0.5);
    }
  });
});
