/*
 * Probe: the RADIUS/TCP server (RFC 6613) carried its own copy of the decision: a plaintext user table fed by the daemon one entry at a
 * time, one shared secret, no client list, no users-file password types, no Login-Time, no Simultaneous-Use, no Status-Server, no
 * accounting, no reply attributes. FreeRADIUS has one request processor behind every listener, whatever the transport (src/main/listen.c
 * tcp_socket_recv builds the same REQUEST and calls the same rad_authenticate / rad_accounting / rad_status_server as the UDP sockets;
 * client lookup by client_listener_find first). RadiusTcpServer is now only the stream: it hands each request to the agent that already
 * decides for UDP (handleStreamRequest) and writes back what the agent answers; addUser, removeUser and setSharedSecret forward to the
 * agent, so a router's TCP server and its UDP server share one user list.
 *
 * Discriminated with git stash on src: 5 of 7 fall before the fix; two pass either way and are named: the witness (a cleartext user
 * authenticates over TCP) and the wrong password (rejected before as after).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { md5 } from '@/crypto/hash';
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding';
import { withMessageAuthenticator } from '@/network/radius/authenticators';
import type { RadiusPacket } from '@/network/radius/types';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(users: string, clients = 'client lab {\n  ipaddr = 10.0.0.0/24\n  proto = *\n  secret = shared\n}\n') {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const sender = new LinuxServer('linux-server', 'SENDER');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); sender.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(sender.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  sender.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, clients);
  write(target, USERS_FILE_PATH, users);
  const SITE = '/etc/freeradius/3.0/sites-available/default';
  write(target, SITE, (vfsOf(target).readFile(SITE) ?? '').replace('server default {\n', 'server default {\n\tlisten {\n\t\ttype = auth+acct\n\t\tproto = tcp\n\t\tport = 1812\n\t}\n'));
  await target.executeCommand('systemctl restart freeradius');
  nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
  return { nas, sender, target };
}

describe('RADIUS over TCP shares the one decision', () => {
  it('witness: a cleartext user authenticates over TCP', async () => {
    const { nas } = await lab('alice Cleartext-Password := "wonderland"\n');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('accept');
  });

  it('a wrong password is rejected over TCP', async () => {
    const { nas } = await lab('alice Cleartext-Password := "wonderland"\n');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'nope')).toBe('reject');
  });

  it('a user whose password is an MD5-Password of the users file authenticates over TCP, as over UDP', async () => {
    const { nas } = await lab(`alice MD5-Password := "${bytesToHex(md5(utf8ToBytes('wonderland')))}"\n`);
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('accept');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wrong')).toBe('reject');
  });

  it('Login-Time applies over TCP: outside the hours the right password is rejected', async () => {
    const { nas, target } = await lab('alice Cleartext-Password := "wonderland", Login-Time := "Wk0900-1700"\n');
    await target.executeCommand('date -s "2030-01-02 20:00:00" >/dev/null');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('reject');
    await target.executeCommand('date -s "2030-01-02 10:00:00" >/dev/null');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('accept');
  });

  it('Simultaneous-Use applies over TCP, from the sessions the accounting of the same server holds', async () => {
    const { nas, sender } = await lab('alice Cleartext-Password := "wonderland", Simultaneous-Use := 1\n');
    await sender.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "t1"\\nNAS-Port = 3\\n' | radclient 10.0.0.2 acct shared`);
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('reject');
  });

  it('the client list applies over TCP: a NAS that is not a client of clients.conf gets no answer', async () => {
    const { nas } = await lab('alice Cleartext-Password := "wonderland"\n', 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).not.toBe('accept');
  });

  it('Status-Server is served on the stream too: the agent answers it', async () => {
    const { target } = await lab('alice Cleartext-Password := "wonderland"\n');
    const answers: RadiusPacket[] = [];
    const status = withMessageAuthenticator({ type: 'radius', code: 'status-server', identifier: 9, authenticator: '22'.repeat(16), attributes: [] }, '22'.repeat(16), 'shared');
    target.getRadiusServer().handleStreamRequest(new IPAddress('10.0.0.3'), 40001, new IPAddress('10.0.0.2'), 1812, status, (response) => answers.push(response));
    expect(answers.map((answer) => answer.code)).toEqual(['access-accept']);
  });
});
