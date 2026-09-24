/*
 * Probe — a FortiGate session ages: it leaves the table when its timer
 * runs out, and the timer is the one FortiOS reads.
 *
 * Before: SessionTable.sweep() had no caller, so a session never died and
 * "expire=" counted down to 0 and stayed there. The TCP timers were frozen
 * in the profile (TIME_WAIT 120 s, handshake 30 s) where FortiOS reads
 * tcp-timewait-timer (1), tcp-halfopen-timer (10), tcp-halfclose-timer
 * (120), tcp-rst-timer (5) and udp-idle-timer (180) from config system
 * global, and none of them was accepted there. proto_state printed
 * TIME_WAIT as 07 and CLOSE_WAIT as 05, the reverse of FortiOS.
 *
 * Authorities: the defaults and ranges of the global timers come from the
 * Fortinet Ansible collection (fortios_system_global); the proto_state codes
 * (1 ESTABLISHED, 2 SYN_SENT, 3 SYN_RECV, 4 FIN_WAIT, 5 TIME_WAIT, 6 CLOSE,
 * 7 CLOSE_WAIT, 8 LAST_ACK) and the session-ttl default range
 * (300-2764800 or never) come from search excerpts of the Fortinet
 * documentation, whose pages are refused by this environment's proxy.
 *
 * Time is advanced on the virtual clock the harness installs, because a
 * Linux sleep does not let time pass (TODO.md).
 *
 * Measured before the change (git stash of src/events, src/network/core
 * and src/network/devices/firewall): 7 of the 9 cases fail.
 * Passing either way:
 *   - "an HTTP exchange leaves a session in the table" is the WITNESS: the
 *     lab, the policy and the session list are sound.
 *   - "session-ttl default still refuses a value under 300" is
 *     non-regression: the floor was already enforced.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { getDefaultScheduler, VirtualTimeScheduler } from '@/events/Scheduler';
import { type Cli, taper, serveZones, labZone } from '../../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer; fw: Cli }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  pc.powerOn();
  srv.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action accept', 'set schedule "always"',
    'set service "ALL"', 'set nat enable', 'next',
    'end',
  ]);
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    'systemctl start nginx',
  ]);
  await serveZones(srv as unknown as Cli, [labZone()]);
  return { pc, srv, fw };
}

function elapse(seconds: number): void {
  const clock = getDefaultScheduler();
  if (!(clock instanceof VirtualTimeScheduler)) throw new Error('the harness installs a virtual clock');
  clock.advance(seconds * 1000);
}

async function sessionsTo(fw: Cli, port: number): Promise<string> {
  await fw.executeCommand('diagnose sys session filter clear');
  await fw.executeCommand(`diagnose sys session filter dport ${port}`);
  return fw.executeCommand('diagnose sys session list');
}

describe('FortiGate session aging', () => {
  it('an HTTP exchange leaves a session in the table', async () => {
    const { pc, fw } = await buildLab();
    await pc.executeCommand('curl -s -o /dev/null http://203.0.113.9/');
    expect(await sessionsTo(fw, 80)).toMatch(/^total session 1$/m);
  });

  it('a cleanly closed TCP session is shown in TIME_WAIT, proto_state=05', async () => {
    const { pc, fw } = await buildLab();
    await pc.executeCommand('curl -s -o /dev/null http://203.0.113.9/');
    expect(await sessionsTo(fw, 80)).toMatch(/proto=6 proto_state=05 .*timeout=1$/m);
  });

  it('a cleanly closed TCP session leaves the table once tcp-timewait-timer elapses', async () => {
    const { pc, fw } = await buildLab();
    await pc.executeCommand('curl -s -o /dev/null http://203.0.113.9/');
    elapse(2);
    expect(await sessionsTo(fw, 80)).toMatch(/^total session 0$/m);
  });

  it('tcp-timewait-timer from config system global decides how long TIME_WAIT lasts', async () => {
    const { pc, fw } = await buildLab();
    await taper(fw, ['config system global', 'set tcp-timewait-timer 30', 'end']);
    await pc.executeCommand('curl -s -o /dev/null http://203.0.113.9/');
    elapse(2);
    const listed = await sessionsTo(fw, 80);
    expect(listed).toMatch(/proto_state=05 .*timeout=30$/m);
    expect(listed).toMatch(/^total session 1$/m);
  });

  it('a TCP session reset by the server stays in CLOSE for tcp-rst-timer, then leaves', async () => {
    const { pc, fw } = await buildLab();
    await pc.executeCommand('nc -z -w 1 203.0.113.9 81');
    expect(await sessionsTo(fw, 81)).toMatch(/proto=6 proto_state=06 .*timeout=5$/m);
    elapse(6);
    expect(await sessionsTo(fw, 81)).toMatch(/^total session 0$/m);
  });

  it('a UDP session leaves the table once udp-idle-timer elapses', async () => {
    const { pc, fw } = await buildLab();
    await taper(fw, ['config system global', 'set udp-idle-timer 5', 'end']);
    await pc.executeCommand('dig @203.0.113.9 srv.lab.lan +short +tries=1');
    expect(await sessionsTo(fw, 53)).toMatch(/proto=17 .*timeout=5$/m);
    elapse(6);
    expect(await sessionsTo(fw, 53)).toMatch(/^total session 0$/m);
  });

  it('a session-ttl port entry ages the matching sessions', async () => {
    const { pc, fw } = await buildLab();
    await taper(fw, [
      'config system session-ttl', 'config port', 'edit 1',
      'set protocol 17', 'set start-port 53', 'set end-port 53', 'set timeout 3',
      'next', 'end', 'end',
    ]);
    await pc.executeCommand('dig @203.0.113.9 srv.lab.lan +short +tries=1');
    elapse(4);
    expect(await sessionsTo(fw, 53)).toMatch(/^total session 0$/m);
  });

  it('session-ttl default accepts never and the documented maximum', async () => {
    const { fw } = await buildLab();
    await taper(fw, ['config system session-ttl', 'set default never', 'end']);
    expect(await fw.executeCommand('get system session-ttl')).toMatch(/^default\s*:\s*never$/m);
    await taper(fw, ['config system session-ttl', 'set default 2764800', 'end']);
    expect(await fw.executeCommand('get system session-ttl')).toMatch(/^default\s*:\s*2764800$/m);
  });

  it('session-ttl default still refuses a value under 300', async () => {
    const { fw } = await buildLab();
    await fw.executeCommand('config system session-ttl');
    expect(await fw.executeCommand('set default 5')).toMatch(/Command fail/);
  });
});
