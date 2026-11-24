/*
 * Probe: a Huawei NAS authenticating and accounting against a RADIUS server reached over IPv6. The Huawei router has no RADIUS configuration command in this
 * simulator (its client is configured through the agent), so the gap was the plumbing the Cisco router already had: the client had no family-aware sender, no
 * source for NAS-IPv6-Address, and the replies of UDP/1812 and UDP/1813 received over IPv6 were handed to the generic endpoint. The server is the project's
 * FreeRADIUS on a LinuxServer.
 *
 * Discriminated with git stash on src/network: 2 of 3 fall before the fix; the witness (the same lab over IPv4) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

let clock: VirtualTimeScheduler;
beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); clock = installVirtualClock(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';

async function lab(server: string) {
  const nas = new HuaweiRouter('HW-NAS');
  const aaa = new LinuxServer('linux-server', 'AAA');
  new Cable('a').connect(nas.getPort('GE0/0/0')!, aaa.getPort('eth0')!);
  nas.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nas.enableIPv6Routing();
  nas.configureIPv6Interface('GE0/0/0', new IPv6Address('fd00::1'), 64);
  aaa.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  write(aaa, CLIENTS_CONF_PATH, 'client nas6 {\n  ipv6addr = fd00::1\n  secret = shared\n}\nclient nas4 {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(aaa, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  write(aaa, SITE, (vfsOf(aaa).readFile(SITE) ?? '').replace('\tlisten {\n\t\ttype = auth\n', '\tlisten {\n\t\ttype = auth\n\t\tipv6addr = ::\n\t}\n\tlisten {\n\t\ttype = acct\n\t\tipv6addr = ::\n\t}\n\tlisten {\n\t\ttype = auth\n'));
  await aaa.executeCommand('systemctl restart freeradius');
  nas.getRadiusClient().start();
  nas.getRadiusClient().addServer(server, 'shared', { timeoutMs: 500, retransmit: 0 });
  nas.getRadiusAccountingClient().start();
  nas.getRadiusAccountingClient().addServer(server, 'shared', { timeoutMs: 500, retransmit: 0 });
  await aaa.executeCommand('ping -c 1 10.0.0.1');
  await aaa.executeCommand('ping -6 -c 1 fd00::1');
  return { nas, aaa };
}

describe('a Huawei NAS and a RADIUS server over IPv6', () => {
  it('witness: the same lab authenticates over IPv4', async () => {
    const { nas } = await lab('10.0.0.2');
    expect(await clock.advanceUntilSettled(nas.getRadiusClient().authenticate('alice', 'pw'))).toBe(true);
  });

  it('a user known to the server is accepted over IPv6, and the request carries NAS-IPv6-Address', async () => {
    const { nas, aaa } = await lab('fd00::2');
    const lines: string[] = [];
    aaa.followRadiusDebug((line: string) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    expect(await clock.advanceUntilSettled(nas.getRadiusClient().authenticate('alice', 'pw'))).toBe(true);
    expect(lines).toContain('NAS-IPv6-Address = fd00::1');
  });

  it('accounting over IPv6 is acknowledged', async () => {
    const { nas } = await lab('fd00::2');
    const accounting = nas.getRadiusAccountingClient();
    const session = accounting.startSession('alice', 'fd00::2')!;
    await clock.advanceBy(10);
    accounting.stopSession(session);
    await clock.advanceBy(10);
    expect(accounting.acknowledgedCount('fd00::2')).toBe(2);
  });
});
