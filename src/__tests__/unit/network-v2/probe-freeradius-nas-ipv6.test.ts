/*
 * Probe: a Cisco NAS authenticating against a RADIUS server reached over IPv6. IOS takes `radius server NAME / address ipv6 X [auth-port N] [acct-port N]`
 * (Cisco IOS Security Command Reference, radius server); the NAS only knew `address ipv4`, wrote its running-config line with `ipv4` whatever the address, its
 * UDP egress had no family-aware sender for the RADIUS client and the replies of an IPv6 server were handed to the generic endpoint, so the login timed out. Now the
 * address is accepted and shown as `address ipv6`, the client sends through the router's IPv6 datagram sender, and a reply from UDP/1812 or UDP/1813 over IPv6
 * reaches the RADIUS client and accounting client as the IPv4 path already does. The server is the project's FreeRADIUS on a LinuxServer, so the exchange is
 * a real one on both ends; the 802.1X NAS uses this same client (Dot1xAgent over RadiusClientAgent.sendEapRound).
 *
 * The server replies from the address the request was sent to (FreeRADIUS answers from the datagram's destination), not from whichever address the host's source
 * selection prefers: the reply of the lab came from a random temporary address of the interface, which no NAS can match with its configured server.
 *
 * Accounting from the NAS over IPv6 (Acct-Start, interim, Acct-Stop) did not leave the NAS: the accounting client built an IPv4 address from the server and omits
 * NAS-IP-Address now that the datagram has no IPv4 source; both clients write NAS-IPv6-Address (RFC 3162, the address the host would pick on egress) and send from it, so the attribute
 * and the datagram's source cannot disagree.
 *
 * Discriminated with git stash on src/network against the commit that added address ipv6: the accounting case is the only one that falls (the first four were
 * discriminated when that commit was made: 3 of them fell before it, the witness passed either way). The witness (the same lab authenticates over IPv4) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { eapPacketToWireHex } from '@/network/radius/eap';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

let clock: VirtualTimeScheduler;
beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); clock = installVirtualClock(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';

async function lab(serverLines: string[]) {
  const nas = new CiscoRouter('NAS');
  const aaa = new LinuxServer('linux-server', 'AAA');
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, aaa.getPort('eth0')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nas.enableIPv6Routing();
  nas.configureIPv6Interface('GigabitEthernet0/0', new IPv6Address('fd00::1'), 64);
  aaa.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) await nas.executeCommand(c);
  write(aaa, CLIENTS_CONF_PATH, 'client nas6 {\n  ipv6addr = fd00::1\n  secret = shared\n}\nclient nas4 {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(aaa, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  write(aaa, SITE, (vfsOf(aaa).readFile(SITE) ?? '').replace('\tlisten {\n\t\ttype = auth\n', '\tlisten {\n\t\ttype = auth\n\t\tipv6addr = ::\n\t}\n\tlisten {\n\t\ttype = acct\n\t\tipv6addr = ::\n\t}\n\tlisten {\n\t\ttype = auth\n'));
  const started = await aaa.executeCommand('systemctl restart freeradius');
  nas.getRadiusClient().start();
  for (const c of [
    'enable', 'configure terminal', 'aaa new-model', 'radius server S', ...serverLines, 'key shared', 'exit',
    'radius-server timeout 1', 'radius-server retransmit 0',
    'aaa group server radius G', 'server name S', 'exit', 'aaa authentication login default group G', 'end',
  ]) await nas.executeCommand(c);
  await aaa.executeCommand('ping -c 1 10.0.0.1');
  await aaa.executeCommand('ping -6 -c 1 fd00::1');
  return { nas, aaa, started };
}

const login = async (nas: CiscoRouter, user = 'alice', password = 'pw') =>
  (await clock.advanceUntilSettled(nas.getAaaAuthenticator().authenticate(user, password, 'default'))).accepted;

describe('a Cisco NAS and a RADIUS server over IPv6', () => {
  it('witness: the same lab authenticates over IPv4', async () => {
    const { nas, started } = await lab(['address ipv4 10.0.0.2 auth-port 1812 acct-port 1813']);
    expect(started).not.toContain('Failed');
    expect(await login(nas)).toBe(true);
  });

  it('address ipv6 is accepted and written as address ipv6 in the running-config', async () => {
    const { nas } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    const config = await nas.executeCommand('show running-config');
    expect(config).toContain(' address ipv6 fd00::2 auth-port 1812 acct-port 1813');
    expect(config).not.toContain('address ipv4 fd00::2');
  });

  it('a user known to the server is accepted over IPv6', async () => {
    const { nas } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    expect(await login(nas)).toBe(true);
  });

  it('a wrong password is rejected over IPv6 by the server, not lost', async () => {
    const { nas } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    expect(await login(nas, 'alice', 'nope')).toBe(false);
    const out = await nas.executeCommand('show aaa servers');
    expect(out).toMatch(/Response: accept 0, reject 1, challenge 0/);
    expect(out).toMatch(/timeouts 0/);
  });

  it('accounting over IPv6: Acct-Start, interim update and Acct-Stop are acknowledged by the server', async () => {
    const { nas } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    const accounting = nas.getRadiusAccountingClient();
    accounting.start();
    accounting.addServer('fd00::2', 'shared', { port: 1813 });
    const session = accounting.startSession('alice', 'fd00::2')!;
    await clock.advanceBy(10);
    accounting.interimUpdate(session, { inputOctets: 10, outputOctets: 20 });
    await clock.advanceBy(10);
    accounting.stopSession(session);
    await clock.advanceBy(10);
    expect(accounting.acknowledgedCount('fd00::2')).toBe(3);
  });

  it('the Access-Request and the Acct-Start carry NAS-IPv6-Address, the address the datagram was sent from', async () => {
    const { nas, aaa } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    const lines: string[] = [];
    aaa.followRadiusDebug((line: string) => lines.push(line.trim()));
    expect(await login(nas)).toBe(true);
    const accounting = nas.getRadiusAccountingClient();
    accounting.start();
    accounting.addServer('fd00::2', 'shared', { port: 1813 });
    accounting.startSession('alice', 'fd00::2');
    await clock.advanceBy(10);
    expect(lines.filter((line) => /NAS-IPv6-Address = fd00::1$/.test(line.replace(/^\(\d+\) /, ''))).length).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => /Received Access-Request Id \d+ from fd00::1:\d+/.test(line))).toBe(true);
    expect(lines.some((line) => /Received Accounting-Request Id \d+ from fd00::1:\d+/.test(line))).toBe(true);
  });

  it('an EAP round carries NAS-IPv6-Address too', async () => {
    const { nas, aaa } = await lab(['address ipv6 fd00::2 auth-port 1812 acct-port 1813']);
    expect(await login(nas)).toBe(true);
    const lines: string[] = [];
    aaa.followRadiusDebug((line: string) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    const identity = eapPacketToWireHex({ type: 'eap', code: 'response', identifier: 1, eapType: 'identity', payload: 'alice' });
    await clock.advanceUntilSettled(nas.getRadiusClient().sendEapRound('alice', identity, null, {}, 'fd00::2'));
    expect(lines.some((line) => /EAP-Message = 0x/.test(line))).toBe(true);
    expect(lines.filter((line) => line === 'NAS-IPv6-Address = fd00::1').length).toBeGreaterThanOrEqual(1);
  });
});
