/*
 * Probe — `config system link-monitor` stores a health monitor, and
 * `diagnose sys link-monitor status` probes each server on the wire and
 * reports it alive or dead.
 *
 * Before (FortiGate battery 03, test 110): `config system link-monitor`
 * was an unknown table and `diagnose sys link-monitor status` an unknown
 * path — a WAN link's health could not be watched by ICMP probe.
 *
 * Authority: FortiOS CLI reference, `config system link-monitor`
 * (name, srcintf, server, protocol {ping|tcp-echo|udp-echo|http|twamp},
 * gateway-ip, source-ip, interval, failtime, recoverytime,
 * update-static-route, status) and `diagnose sys link-monitor status`
 * (per-monitor "Status: alive/die", per-server "state: alive/dead"). The
 * exact column layout of the diagnostic is not reachable from here, so the
 * renderer carries the fields the reference names and says so. The probe
 * itself is the firewall's own ICMP echo (the one `execute ping` and the
 * ldb-monitor already send), so only `ping` is honoured; the other
 * protocols are refused rather than pretended (rule 6).
 *
 * Measured before the change (git stash of src/network): 4 of the 6 cases
 * fail — the four that need the table or the diagnostic.
 * Passing either way:
 *   - "the firewall reaches the server on the wire" is the WITNESS: the
 *     same echo the monitor sends is answered, so an alive verdict measures
 *     the monitor and not a dead route.
 *   - "an unimplemented protocol is refused" is non-regression: a criterion
 *     the engine cannot evaluate was never accepted.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

interface Lab { fw: Cli; srv: LinuxServer }

async function buildLab(): Promise<Lab> {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  const srv = new LinuxServer('linux-server', 'wan-srv', 0, 0);
  srv.powerOn();
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0', 'ip route add default via 203.0.113.1',
  ]);
  return { fw, srv };
}

const MONITOR = [
  'config system link-monitor',
  'edit "WAN1_HEALTH"',
  'set srcintf "wan1"',
  'set server "203.0.113.10"',
  'set protocol ping',
  'set interval 500',
  'set failtime 3',
  'next',
  'end',
];

describe('FortiGate link-monitor', () => {
  it('the firewall reaches the server on the wire', async () => {
    const { fw } = await buildLab();
    const out = await fw.executeCommand('execute ping 203.0.113.10');
    expect(out).toMatch(/1 packets received|bytes from 203\.0\.113\.10/i);
  });

  it('the monitor is accepted and rendered', async () => {
    const { fw } = await buildLab();
    await taper(fw, MONITOR);
    const shown = await fw.executeCommand('show system link-monitor');
    expect(shown).toContain('edit "WAN1_HEALTH"');
    expect(shown).toContain('set srcintf "wan1"');
    expect(shown).toContain('set server "203.0.113.10"');
    expect(shown).toContain('set failtime 3');
  });

  it('diagnose sys link-monitor status is not refused', async () => {
    const { fw } = await buildLab();
    await taper(fw, MONITOR);
    const status = await fw.executeCommand('diagnose sys link-monitor status');
    expect(refuse(status)).toBe(false);
  });

  it('a reachable server reads alive', async () => {
    const { fw } = await buildLab();
    await taper(fw, MONITOR);
    const status = await fw.executeCommand('diagnose sys link-monitor status');
    expect(status).toContain('Link Monitor: WAN1_HEALTH');
    expect(status).toMatch(/Status: alive/);
    expect(status).toMatch(/state: alive/);
  });

  it('an unreachable server reads dead', async () => {
    const { fw } = await buildLab();
    await taper(fw, [
      'config system link-monitor',
      'edit "DEAD"', 'set srcintf "wan1"', 'set server "203.0.113.200"',
      'set protocol ping', 'set failtime 1', 'next', 'end',
    ]);
    const status = await fw.executeCommand('diagnose sys link-monitor status');
    expect(status).toMatch(/state: dead/);
    expect(status).toMatch(/Status: die/);
  });

  it('an unimplemented protocol is refused', async () => {
    const { fw } = await buildLab();
    await taper(fw, [
      'config system link-monitor', 'edit "TCP"', 'set srcintf "wan1"', 'set server "203.0.113.10"',
    ]);
    const out = await fw.executeCommand('set protocol tcp-echo');
    expect(refuse(out)).toBe(true);
    await fw.executeCommand('end');
  });
});
