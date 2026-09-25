/*
 * Probe — `arping` sends real ARP requests and counts the replies that come
 * back, instead of reading the local ARP cache.
 *
 * Measured before the fix (git stash of src/network): 2 of the 3 cases fail.
 *   - "cold cache": once `ip neigh flush all` empties the cache, the old
 *     arping, which only read that cache, answered
 *     "Received 0 response(s)" for a live neighbour; a `ping` then made the
 *     very same arping succeed.
 *   - "the target learns the prober": no request ever left the host, so
 *     the target never learned the prober's MAC.
 * Passing either way:
 *   - "an absent host" is the WITNESS: nothing answers, 0 responses, exit 1.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function buildLan(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
  [pc, srv, sw].forEach((d) => d.powerOn());
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) await srv.executeCommand(line);
  await pc.executeCommand('ip neigh flush all');
  await srv.executeCommand('ip neigh flush all');
  return { pc, srv };
}

describe('arping probes on the wire', () => {
  it('a live neighbour answers even when the ARP cache is cold', async () => {
    const { pc } = await buildLan();
    expect(await pc.executeCommand('ip neigh')).not.toContain('10.0.0.2');
    const out = await pc.executeCommand('arping -c 1 10.0.0.2');
    expect(out).toMatch(/ARPING 10\.0\.0\.2 from 10\.0\.0\.1 eth0/);
    expect(out).toMatch(/Unicast reply from 10\.0\.0\.2 \[[0-9A-F:]{17}\]/);
    expect(out).toMatch(/Received 1 response\(s\)/);
  });

  it('the target learns the prober from the request it received', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand('arping -c 1 10.0.0.2');
    expect(await srv.executeCommand('ip neigh')).toContain('10.0.0.1');
  });

  it('an absent host sends no reply', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand('arping -c 2 10.0.0.99; echo EC=$?');
    expect(out).toMatch(/Sent 2 probes/);
    expect(out).toMatch(/Received 0 response\(s\)/);
    expect(out).toMatch(/EC=1/);
  });
});
