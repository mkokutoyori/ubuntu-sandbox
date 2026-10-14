/**
 * firewall policy `set timeout-send-rst enable`: when an idle TCP session
 * expires, the firewall sends a RST to both ends so they close their sockets,
 * instead of leaving two hosts each believing the connection is alive.
 *
 * The RSTs carry the sequence numbers the session table tracked, so each end
 * accepts them (RFC 9293: a RST is valid when its sequence is in the window).
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * the attribute, so the sockets stay open and the 1 case that expects them
 * closed falls (1 of 3). The established witness and the no-attribute case
 * (sockets survive the expiry) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '../../../support/ntpTime';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function lab(sendRst: boolean) {
  const scheduler = installVirtualClock();
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...(sendRst ? ['set timeout-send-rst enable'] : []), 'next', 'end',
  ]);
  srv.getTcpStack().listen(9000, { onAccept: () => undefined });
  pc.getTcpStack().connect('192.168.20.10', 9000);
  const established = async (d: LinuxPC | LinuxServer) =>
    /ESTAB/.test(await d.executeCommand('ss -tn'));
  return { pc, srv, established, elapse: (seconds: number) => scheduler.advance(seconds * 1000) };
}

describe('policy timeout-send-rst', () => {
  it('witness: the connection is established on both ends', async () => {
    const l = await lab(true);
    expect(await l.established(l.pc)).toBe(true);
    expect(await l.established(l.srv)).toBe(true);
  });

  it('witness: without the attribute the sockets survive the session expiry', async () => {
    const l = await lab(false);
    l.elapse(7200);
    expect(await l.established(l.pc)).toBe(true);
    expect(await l.established(l.srv)).toBe(true);
  });

  it('with the attribute both ends are reset when the session expires', async () => {
    const l = await lab(true);
    l.elapse(7200);
    expect(await l.established(l.pc)).toBe(false);
    expect(await l.established(l.srv)).toBe(false);
  });
});
