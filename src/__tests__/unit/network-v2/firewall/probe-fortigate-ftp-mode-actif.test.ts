/*
 * Probe: the `ftp` session helper only covered PASV/EPSV (server opens, client connects in) ; active mode
 * (PORT/EPRT, RFC 959 §2.3/§3.2 and RFC 2428 §2 — client names its own endpoint, server connects out) had no
 * equivalent: the server's outbound data connection carried no ExpectedFlow, so nothing but a policy admitting
 * ALL from the server's interface let it through. Measured on a policy that only opens the control port 21
 * (no service "ALL"): `curl --ftp-port <client-ip>` timed out waiting for the server's data connection.
 *
 * Active mode stays uncovered when the control channel is itself source-translated (NAT enabled on the
 * policy): the client announces its own, private address, which nothing downstream rewrites — the real
 * FTP-over-NAT limitation an ALG normally closes by rewriting the PORT/EPRT argument in the stream, which
 * this helper does not attempt (recorded in TODO.md). That case is a witness for the boundary, not a defect.
 *
 * Discriminated with git stash on src/network: 2 of 4 fall before the fix (the two un-NAT'd active-mode
 * transfers) ; the other two pass either way and are named: the PASV witness (unaffected by this change) and
 * the NAT boundary case (no ExpectedFlow exists on either side of the fix, so nothing carries it then either).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }
type FwPort = { getPort(n: string): import('@/network/hardware/Port').Port };

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function lab(nat: boolean) {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cmd & FwPort;
  const pc = new LinuxPC('linux-pc', 'PC', 200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 400, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, pc.getPort('eth0')!);
  new Cable('c2').connect(fw.getPort('wan1')!, srv.getPort('eth0')!);

  for (const line of [
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set service "FTP"', 'set action accept', 'set schedule "always"',
    `set nat ${nat ? 'enable' : 'disable'}`, 'next', 'end',
  ]) await fw.executeCommand(line);

  await pc.executeCommand('ip link set eth0 up');
  await pc.executeCommand('ip addr add 10.1.0.10/24 dev eth0');
  await pc.executeCommand('ip route add default via 10.1.0.1');
  await srv.executeCommand('ip link set eth0 up');
  await srv.executeCommand('ip addr add 203.0.113.9/24 dev eth0');
  await srv.executeCommand('ip route add default via 203.0.113.1');
  if (nat) await fw.executeCommand('config router static\nedit 1\nset dst 10.1.0.0 255.255.255.0\nset device "port1"\nend');
  await srv.executeCommand('apt install -y vsftpd');
  await srv.executeCommand('echo "ACTIVE_MODE_PAYLOAD" > /srv/ftp/active.txt');
  return { pc, srv };
}

describe('ftp session helper: active mode (PORT/EPRT)', () => {
  it('witness: PASV still works under a policy scoped to FTP only', async () => {
    const { pc } = await lab(false);
    const res = await pc.executeCommand('curl -s --connect-timeout 2 --max-time 3 ftp://203.0.113.9/active.txt');
    expect(res).toContain('ACTIVE_MODE_PAYLOAD');
  });

  it('active mode (EPRT) carries the data connection under a routed, non-NAT policy', async () => {
    const { pc } = await lab(false);
    const res = await pc.executeCommand('curl -s --connect-timeout 2 --max-time 3 --ftp-port 10.1.0.10 ftp://203.0.113.9/active.txt');
    expect(res).toContain('ACTIVE_MODE_PAYLOAD');
  });

  it('active mode falls back to PORT when EPRT is disabled, and still carries the data', async () => {
    const { pc } = await lab(false);
    const res = await pc.executeCommand('curl -s --disable-eprt --connect-timeout 2 --max-time 3 --ftp-port 10.1.0.10 ftp://203.0.113.9/active.txt');
    expect(res).toContain('ACTIVE_MODE_PAYLOAD');
  });

  it('boundary: active mode is not carried once the control channel is itself source-translated', async () => {
    const { pc } = await lab(true);
    const res = await pc.executeCommand('curl -s --connect-timeout 2 --max-time 3 --ftp-port 10.1.0.10 ftp://203.0.113.9/active.txt');
    expect(res).not.toContain('ACTIVE_MODE_PAYLOAD');
  });
});
