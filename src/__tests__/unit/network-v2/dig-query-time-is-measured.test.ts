/*
 * Probe — `dig` prints the time its query took, measured on the clock the
 * simulation runs on, not a number drawn at random.
 *
 * DigRunner printed ";; Query time: N msec" with N = random 1..10 (and the
 * same for every +trace hop), so a test reading the value passed one run in
 * ten. Frame delivery is synchronous and the virtual round trip is 0 ms
 * (CLAUDE.md, known limits), which is therefore what dig must print.
 *
 * Measured before the change (git stash of DigRunner.ts): the Query time
 * case fails on every run (the value is never 0).
 * Passing either way:
 *   - "the answer is received" is the WITNESS: the zone is served and the
 *     query crosses the wire.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper, serveZones, labZone } from '../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<LinuxPC> {
  const srv = new LinuxServer('linux-server', 'ns1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0']);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0']);
  await serveZones(srv as unknown as Cli, [labZone()]);
  return pc;
}

describe('dig Query time', () => {
  it('the answer is received', async () => {
    const pc = await buildLab();
    expect(await pc.executeCommand('dig @203.0.113.9 srv.lab.lan')).toMatch(/^srv\.lab\.lan\.\s+3600\s+IN\s+A\s+203\.0\.113\.9$/m);
  });

  it('is the measured round trip, 0 ms on the virtual wire', async () => {
    const pc = await buildLab();
    for (let run = 0; run < 3; run++) {
      expect(await pc.executeCommand('dig @203.0.113.9 srv.lab.lan')).toMatch(/^;; Query time: 0 msec$/m);
    }
  });
});
