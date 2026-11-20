/**
 * Probe: clients.conf drives FreeRADIUS per client: one secret per client, subnet clients, the unknown client refused, require_message_authenticator enforced.
 *
 * References (rule 8): FreeRADIUS server v3.2.x source: src/main/client.c (client_config: ipaddr/ipv4addr/ipv6addr with a prefix, netmask, secret, shortname, nas_type,
 * require_message_authenticator, limit_proxy_state; the old-style "client <ipaddr> {" form with its WARN; "secret must be at least 1 character long"; client lookup by the most specific
 * prefix), src/main/conffile.c (the grammar, ${variable}, $INCLUDE and the "file[line]: ..." error wording), src/lib/radius.c ("Insecure packet from host %s: Packet does not
 * contain required Message-Authenticator attribute..."). The simulator's engine had one shared secret and an IP allow-list: the secret of the first client block was applied to every
 * NAS, and the other blocks only served as a "is configured" flag.
 *
 * Measured before the change: with two client blocks, secret-a for 10.0.0.1 and secret-b for 10.0.0.3, a request from 10.0.0.3 signed with secret-b was refused (the engine used secret-a
 * for everybody) and one signed with secret-a was accepted, an address that is no client was served as soon as it knew the first secret, and require_message_authenticator was parsed by nobody.
 *
 * Discrimination (git stash push -- src/network): 5 of 7 cases fall on the base. Two pass either way and are named: the WITNESS that the first client's own secret works, and the subnet
 * case (a single subnet client's secret was already the shared secret of the whole server).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UDPPacket } from '@/network/core/types';
import { attr, type RadiusPacket, type RadiusAttribute } from '@/network/radius/types';
import { encryptUserPassword } from '@/network/radius/types';
import { randomRequestAuthenticator, withMessageAuthenticator } from '@/network/radius/authenticators';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const vfsOf = (server: LinuxServer): VirtualFileSystem => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

function lab(clientsConf: string) {
  const bus = new EventBus();
  const server = new LinuxServer('linux-server', 'AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const nas = [1, 3, 9].map((last, index) => {
    const device = new LinuxServer('linux-server', `NAS${last}`);
    device.setEventBus(bus);
    new Cable(`n${last}`).connect(device.getPort('eth0')!, sw.getPort(`FastEthernet0/${index + 2}`)!);
    device.configureInterface('eth0', new IPAddress(`10.0.0.${last}`), new SubnetMask('255.255.255.0'));
    return device;
  });
  server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('s').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  server.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  vfsOf(server).writeFile(CLIENTS_CONF_PATH, clientsConf, 0, 0, 0o022);
  vfsOf(server).writeFile(USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n', 0, 0, 0o022);
  server.getRadiusd().restart();
  return { server, nas, bus };
}

const CONF = `client a {\n  ipaddr = 10.0.0.1\n  secret = secret-a\n}\nclient b {\n  ipaddr = 10.0.0.3\n  secret = secret-b\n}\n`;

describe('clients.conf per client', () => {
  it('WITNESS: the first client\'s own secret works', async () => {
    const { nas } = lab(CONF);
    expect(await nas[0].executeCommand('radtest alice wonderland 10.0.0.2 0 secret-a')).toContain('Received Access-Accept');
  });

  it('the second client\'s own secret works', async () => {
    const { nas } = lab(CONF);
    expect(await nas[1].executeCommand('radtest alice wonderland 10.0.0.2 0 secret-b')).toContain('Received Access-Accept');
  });

  it('a client signing with another client\'s secret does not get through', async () => {
    const { nas } = lab(CONF);
    expect(await nas[1].executeCommand('radtest alice wonderland 10.0.0.2 0 secret-a')).not.toContain('Received Access-Accept');
  });

  it('a subnet client serves every address of the subnet with its secret', async () => {
    const { nas } = lab('client lan {\n  ipaddr = 10.0.0.0/24\n  secret = lan-secret\n}\n');
    expect(await nas[2].executeCommand('radtest alice wonderland 10.0.0.2 0 lan-secret')).toContain('Received Access-Accept');
  });

  it('the most specific client wins over the subnet', async () => {
    const { nas } = lab('client lan {\n  ipaddr = 10.0.0.0/24\n  secret = lan-secret\n}\nclient one {\n  ipaddr = 10.0.0.9\n  secret = one-secret\n}\n');
    expect(await nas[2].executeCommand('radtest alice wonderland 10.0.0.2 0 one-secret')).toContain('Received Access-Accept');
    expect(await nas[2].executeCommand('radtest alice wonderland 10.0.0.2 0 lan-secret')).not.toContain('Received Access-Accept');
  });

  it('an address that is no client is not answered', async () => {
    const { nas } = lab(CONF);
    expect(await nas[2].executeCommand('radtest alice wonderland 10.0.0.2 0 secret-a')).not.toContain('Received Access-Accept');
  });

  it('require_message_authenticator = yes drops a request that carries none, and answers one that does', () => {
    const { server, bus } = lab('client a {\n  ipaddr = 10.0.0.1\n  secret = secret-a\n  require_message_authenticator = yes\n}\n');
    const received = vi.fn();
    bus.subscribe('radius.packet.received', received);
    const authenticator = randomRequestAuthenticator();
    const request = (extra: RadiusAttribute[]): RadiusPacket => ({
      type: 'radius', code: 'access-request', identifier: 7, authenticator,
      attributes: [attr('user-name', 'alice'), attr('user-password', encryptUserPassword('wonderland', 'secret-a', authenticator)), ...extra],
    });
    const udp = (payload: RadiusPacket): UDPPacket => ({ sourcePort: 40000, destinationPort: 1812, payload } as unknown as UDPPacket);
    server.getRadiusServer().handleUdp('eth0', new IPAddress('10.0.0.1'), udp(request([])));
    expect(received).not.toHaveBeenCalled();
    server.getRadiusServer().handleUdp('eth0', new IPAddress('10.0.0.1'), udp(withMessageAuthenticator(request([]), authenticator, 'secret-a')));
    expect(received).toHaveBeenCalledTimes(1);
  });
});
