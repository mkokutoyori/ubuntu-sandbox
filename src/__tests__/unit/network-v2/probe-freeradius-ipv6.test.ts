/*
 * Probe: the RADIUS server handled IPv4 only: a listen section with `ipv6addr` was refused, a client written `ipv6addr` was read as a v4
 * address and failed, and an IPv6 datagram to port 1812 reached nobody. Source of truth: FreeRADIUS v3.2.x src/main/listen.c (a listener has
 * one address family: `ipaddr = *` is IPv4, `ipv6addr = ::` is IPv6; "Failed finding address for X" when the value is not an address of that
 * family), src/main/client.c (ipaddr / ipv4addr / ipv6addr with a prefix, up to 128 for IPv6; a client matches the packet's source by
 * longest prefix within its family), src/main/command.c (show client list prints an IPv6 client without a /128). The server now binds IPv6
 * listeners through the host's dual-stack UDP socket table, keys its client table by family, and answers an IPv6 client over IPv6 with the
 * ordinary Response Authenticator. The packets cross a real switch as IPv6 frames (neighbour discovery included). The RADIUS client agents
 * (radclient, radtest, the NAS side) and the home_server / proxy path stay IPv4: `ipv6addr` in a home_server is still refused (TODO.md).
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix; the one passing either way is named: an IPv4 listener (ipaddr = *) does not take IPv6
 * traffic (on the base the agent dropped every IPv6 source; with the fix the service checks the datagram's family against the listener's: the host's UDP
 * dispatch is keyed by port only, so the family is decided where the listener is declared).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { attr, encryptUserPassword, type RadiusPacket } from '@/network/radius/types';
import { randomRequestAuthenticator, verifyResponseAuthenticator, withMessageAuthenticator } from '@/network/radius/authenticators';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';

async function lab(clients: string, listener = 'type = auth\n\t\tipv6addr = ::\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'NAS');
  const target = new LinuxServer('linux-server', 'RADIUS');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  client.configureIPv6Interface('eth0', new IPv6Address('fd00::1'), 64);
  target.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  write(target, CLIENTS_CONF_PATH, clients);
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  write(target, SITE, (vfsOf(target).readFile(SITE) ?? '').replace('type = auth\n', listener));
  const started = await target.executeCommand('systemctl restart freeradius');
  return { client, target, started };
}

const V6_CLIENT = 'client nas6 {\n  ipv6addr = fd00::1\n  secret = shared\n}\nclient nas4 {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n';

function accessRequest(password: string): RadiusPacket {
  const authenticator = randomRequestAuthenticator();
  const base: RadiusPacket = {
    type: 'radius', code: 'access-request', identifier: 9, authenticator,
    attributes: [attr('user-name', 'alice'), attr('user-password', encryptUserPassword(password, 'shared', authenticator))],
  };
  return withMessageAuthenticator(base, authenticator, 'shared');
}

async function ask(made: Awaited<ReturnType<typeof lab>>, password: string, port = 1812): Promise<{ reply: RadiusPacket | null; sent: RadiusPacket }> {
  await made.client.executeCommand('ping -6 -c 1 fd00::2');
  const sent = accessRequest(password);
  let reply: RadiusPacket | null = null;
  const localPort = 41000 + Math.floor(Math.random() * 1000);
  made.client.udpBind(localPort, (datagram: { udp: { payload?: unknown } }) => { reply = datagram.udp.payload as RadiusPacket; }, 'probe', { families: ['ipv6'] });
  made.client.sendUdpDatagramTo(new IPv6Address('fd00::2'), port, localPort, sent, 36);
  return { reply, sent };
}

describe('RADIUS over IPv6', () => {
  it('witness: with an IPv6 authentication listener an IPv4 accounting request is still answered', async () => {
    const made = await lab(V6_CLIENT);
    const out = await made.client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s"\\nNAS-IP-Address = 10.0.0.1\\n' | radclient -r 1 -t 1 10.0.0.2 acct shared`);
    expect(out).toContain('Received Accounting-Response');
  });

  it('answers an IPv6 Access-Request from a client written ipv6addr, with a valid Response Authenticator', async () => {
    const made = await lab(V6_CLIENT);
    expect(made.started).not.toContain('Failed');
    const { reply, sent } = await ask(made, 'wonderland');
    expect(reply?.code).toBe('access-accept');
    expect(verifyResponseAuthenticator(reply!, sent.authenticator, 'shared')).toBe(true);
  });

  it('rejects a wrong password over IPv6', async () => {
    const made = await lab(V6_CLIENT);
    expect((await ask(made, 'wrong')).reply?.code).toBe('access-reject');
  });

  it('does not answer an IPv6 address that is no client, and logs it with the listener address ::', async () => {
    const made = await lab('client nas4 {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
    expect((await ask(made, 'wonderland')).reply).toBeNull();
    expect(vfsOf(made.target).readFile('/var/log/freeradius/radius.log') ?? '').toContain('Ignoring request to auth address :: port 1812 bound to server default from unknown client fd00::1');
  });

  it('a client written with an IPv6 prefix matches every source of that prefix', async () => {
    const made = await lab('client net6 {\n  ipv6addr = fd00::/64\n  secret = shared\n}\n');
    expect((await ask(made, 'wonderland')).reply?.code).toBe('access-accept');
    const other = await lab('client net6 {\n  ipv6addr = fd01::/64\n  secret = shared\n}\n');
    expect((await ask(other, 'wonderland')).reply).toBeNull();
  });

  it('show client list prints an IPv6 client without /128 and a network with its prefix', async () => {
    const made = await lab('client one {\n  ipv6addr = fd00::1\n  secret = shared\n}\nclient net {\n  ipv6addr = fd05::/48\n  secret = shared\n}\n');
    expect(made.target.getRadiusd().clientListing(false)).toEqual(['fd00::1', 'fd05::/48']);
  });

  it('a listener serves its own family only: an IPv6 request to an ipaddr = * listener is not answered, and an IPv4 request to an ipv6addr listener neither', async () => {
    const made = await lab(V6_CLIENT, 'type = auth\n\t\tipaddr = *\n');
    expect((await ask(made, 'wonderland')).reply).toBeNull();
    const six = await lab(V6_CLIENT);
    expect(await six.client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 -t 1 10.0.0.2 auth shared`)).toContain('No reply from server');
  });

  it('refuses a listener address and a client address of the wrong family, in the words of the source', async () => {
    expect((await lab(V6_CLIENT, 'type = auth\n\t\tipv6addr = 10.0.0.1\n')).started).toContain('Failed finding address for 10.0.0.1');
    expect((await lab('client bad {\n  ipv4addr = fd00::1\n  secret = shared\n}\n')).started).toContain('Failed parsing client address "fd00::1"');
  });
});
