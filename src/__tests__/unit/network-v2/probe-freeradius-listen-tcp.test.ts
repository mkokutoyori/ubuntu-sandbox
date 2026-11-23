/*
 * Probe: the RADIUS/TCP server (RFC 6613) listened on port 1812 of every FreeRADIUS machine whether or not a `listen` section asked for TCP,
 * and a `listen { proto = tcp }` section was read for nothing. Source of truth: FreeRADIUS v3.2.x src/main/listen.c (a listener has the
 * proto of its section; the default configuration has UDP listeners only, a TCP socket exists only for `proto = tcp`, with the port
 * and the address the section names, type auth, acct or auth+acct sharing the one stream listener) and raddb/sites-available/default.
 * The stream listeners are now installed from the sections and closed with the daemon; a protocol other than udp or tcp is refused by name.
 * (The older over-tcp probe now declares its TCP listener the way a real configuration must.)
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix (the witness too: the base read the section as a second UDP listener on 1812 and refused to start);
 * the one case passing either way is named: stopping the daemon closes the TCP listener, in both states.
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

let tcpPort = 1812;

async function lab(users: string, listen = '', clients = 'client lab {\n  ipaddr = 10.0.0.0/24\n  proto = *\n  secret = shared\n}\n') {
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
  write(target, SITE, (vfsOf(target).readFile(SITE) ?? '').replace('server default {\n', `server default {\n${listen}`));
  const started = await target.executeCommand('systemctl restart freeradius');
  nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, port: tcpPort });
  return { nas, sender, target, started };
}


const SERVER = (target: LinuxServer) => target.executeCommand('ss -tlnp');
const TCP = (extra = '') => `\tlisten {\n\t\ttype = auth+acct\n\t\tproto = tcp\n${extra}\t}\n`;
const ALICE = 'alice Cleartext-Password := "wonderland"\n';

describe('listen { proto = tcp }', () => {
  beforeEach(() => { tcpPort = 1812; });

  it('witness: a declared TCP listener on 1812 serves an authentication', async () => {
    const { nas } = await lab(ALICE, TCP('\t\tport = 1812\n'));
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('accept');
  });

  it('the default configuration has no TCP listener: the connection is refused and ss shows nothing on 1812', async () => {
    const { nas, target } = await lab(ALICE, '');
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).not.toBe('accept');
    expect((await SERVER(target)).split('\n').filter((line) => /:1812\b/.test(line))).toEqual([]);
  });

  it('the section names the port: a listener on 18120 serves there and 1812 stays closed', async () => {
    tcpPort = 18120;
    const { nas, target } = await lab(ALICE, TCP('\t\tport = 18120\n'));
    expect(await nas.getRadiusTcpClient().authenticate('alice', 'wonderland')).toBe('accept');
    const lines = (await SERVER(target)).split('\n');
    expect(lines.some((line) => /:18120\b/.test(line) && line.includes('freeradius'))).toBe(true);
    expect(lines.some((line) => /:1812\b/.test(line))).toBe(false);
  });

  it('the section names the address: ss shows the listener on that address, not on every one', async () => {
    const { target } = await lab(ALICE, TCP('\t\tipaddr = 10.0.0.2\n\t\tport = 1812\n'));
    expect((await SERVER(target)).split('\n').some((line) => line.includes('10.0.0.2:1812'))).toBe(true);
  });

  it('stopping the daemon closes the listener', async () => {
    const { target } = await lab(ALICE, TCP('\t\tport = 1812\n'));
    await target.executeCommand('systemctl stop freeradius');
    expect((await SERVER(target)).split('\n').filter((line) => /:1812\b/.test(line))).toEqual([]);
  });

  it('refuses a protocol that is neither udp nor tcp, naming it', async () => {
    const { started } = await lab(ALICE, TCP().replace('proto = tcp', 'proto = sctp'));
    expect(started).toContain('Unknown protocol "sctp"');
  });
});
