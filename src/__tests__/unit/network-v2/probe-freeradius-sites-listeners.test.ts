/*
 * Probe: the virtual servers were never read, so the ports and addresses of the listeners were fixed in the code. Source of truth:
 * FreeRADIUS v3.2.x src/main/listen.c (listen_init / listener_create: a `listen` section of a `server` with type, ipaddr, port, and
 * virtual_server; port 0 is the service port of the type; the print of common_socket_print "auth address * port 1812 bound to server
 * default"; Invalid type "%s" in listen section.; status_socket_recv: only Status-Server is understood on a status socket; "Ignoring
 * request to %s from unknown client"), raddb/radiusd.conf.in (`$INCLUDE sites-enabled/` at the end), raddb/sites-available/default
 * (server default { listen { type = auth ... } listen { ... type = acct } }, the first listen section on line 59 of the shipped file)
 * and raddb/sites-available/status (server status { listen { type = status ipaddr = 127.0.0.1 port = 18121 } client admin { ... } }).
 * The simulator's sites carry the listen sections and the server's own clients only; the processing sections stay unread (TODO.md).
 *
 * Discriminated with git stash on src: 12 of 14 fall before the fix; two pass either way and are named: the witness (a default
 * install answers on 1812) and the unknown client on the default port (the log line is the same as before).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(clientIp = '10.0.0.1', users = 'alice Cleartext-Password := "wonderland"\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${clientIp}\n  secret = shared\n}\n`);
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const SITES = '/etc/freeradius/3.0/sites-available/default';
const ENABLED = '/etc/freeradius/3.0/sites-enabled';
const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;
const PING = `printf 'Message-Authenticator = 0x00\\n'`;

const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';

async function labWithSite(edit: (text: string) => string) {
  const made = await lab();
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

describe('virtual servers and listeners', () => {
  it('witness: a default install answers an authentication on 1812', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('the default site is a file of sites-available linked from sites-enabled, and -CX reads it after the modules', async () => {
    const { target } = await lab();
    expect((await target.executeCommand(`readlink ${ENABLED}/default`)).trim()).toBe('../sites-available/default');
    const out = (await target.executeCommand('freeradius -CX')).split('\n');
    const detail = out.indexOf('including configuration file /etc/freeradius/3.0/mods-enabled/detail');
    const sites = out.indexOf('including configuration file /etc/freeradius/3.0/sites-enabled/default');
    expect(detail).toBeGreaterThan(0);
    expect(sites).toBeGreaterThan(detail);
  });

  it('the shipped listen section of the auth listener is on line 59, as in the distribution', async () => {
    const { target } = await lab();
    expect(site(target).split('\n')[58]).toBe('\tlisten {');
    expect(site(target).split('\n')[46]).toBe('server default {');
  });

  it('moving the auth listener to port 18120 moves the service: the new port answers, from that port, and 1812 does not', async () => {
    const { client } = await labWithSite((text) => text.replace('type = auth\n\t\tipaddr = *\n\t\tport = 0', 'type = auth\n\t\tipaddr = *\n\t\tport = 18120'));
    const moved = await client.executeCommand(`${ALICE} | radclient 10.0.0.2:18120 auth shared`);
    expect(moved).toMatch(/Received Access-Accept Id \d+ from 10\.0\.0\.2:18120 to /);
    expect(await client.executeCommand(`${ALICE} | radclient -t 1 -r 1 10.0.0.2 auth shared`)).toContain('No reply from server');
  });

  it('a second listen section is a second port, both answer', async () => {
    const { client } = await labWithSite((text) => text.replace('\t#  Accounting, on every address.', '\tlisten {\n\t\ttype = auth\n\t\tipaddr = *\n\t\tport = 18120\n\t}\n\n\t#  Accounting, on every address.'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2:18120 auth shared`)).toContain('Received Access-Accept');
  });

  it('an ipaddr of another address leaves this one without a listener', async () => {
    const { client } = await labWithSite((text) => text.replace('type = auth\n\t\tipaddr = *', 'type = auth\n\t\tipaddr = 10.0.0.99'));
    expect(await client.executeCommand(`${ALICE} | radclient -t 1 -r 1 10.0.0.2 auth shared`)).toContain('No reply from server');
  });

  it('auth+acct serves authentication and accounting on the one port', async () => {
    const { client, target } = await labWithSite((text) => text.replace(/\tlisten \{\n\t\ttype = auth[\s\S]*?\n\t\}\n/, '\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 0\n\t}\n').replace(/\t#  Accounting[\s\S]*?\tlisten \{[\s\S]*?\n\t\}\n/, ''));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
    const acct = await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "z"\\n' | radclient 10.0.0.2:1812 acct shared`);
    expect(acct).toContain('Received Accounting-Response');
    expect(target.getRadiusServer().listAccountingSessions().map((entry) => entry.sessionId)).toContain('z');
  });

  it('the status site, linked from sites-enabled, answers Status-Server on 127.0.0.1:18121 with its own client, and only that', async () => {
    const { target } = await lab();
    await target.executeCommand(`ln -s ../sites-available/status ${ENABLED}/status`);
    await target.executeCommand('systemctl restart freeradius');
    expect(await target.executeCommand(`${PING} | radclient 127.0.0.1:18121 status adminsecret`)).toContain('Received Access-Accept');
    expect(await target.executeCommand(`${PING} | radclient -t 1 -r 1 127.0.0.1:18121 status testing123`)).toContain('No reply from server');
    expect(await target.executeCommand(`${ALICE} | radclient -t 1 -r 1 127.0.0.1:18121 auth adminsecret`)).toContain('No reply from server');
  });

  it('freeradius -X names every listener with the server it is bound to', async () => {
    const { target } = await lab();
    await target.executeCommand(`ln -s ../sites-available/status ${ENABLED}/status`);
    await target.executeCommand('systemctl stop freeradius');
    const out = (await target.executeCommand('freeradius -X')).split('\n');
    expect(out).toContain('Listening on auth address * port 1812 bound to server default');
    expect(out).toContain('Listening on acct address * port 1813 bound to server default');
    expect(out).toContain('Listening on status address 127.0.0.1 port 18121 bound to server status');
    await target.getRadiusd().stop();
  });

  it('a second daemon beside the running one: the collision names the listener and the file and line of its section', async () => {
    const { target } = await labWithSite((text) => text.replace('port = 0\n\t}\n\n\t#  Accounting', 'port = 18120\n\t}\n\n\t#  Accounting'));
    const out = await target.executeCommand('freeradius -X');
    expect(out).toContain('Failed binding to auth address * port 18120 bound to server default: Address already in use');
    expect(out).toMatch(/\/etc\/freeradius\/3\.0\/sites-enabled\/default\[59\]: Error binding to port for 0\.0\.0\.0 port 18120/);
  });

  it('an unknown listen type is refused in the words of listen.c, with its file and line; a missing type too', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('type = auth\n', 'type = bogus\n'));
    expect(await target.executeCommand('freeradius -C')).toBe('');
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: false, error: '/etc/freeradius/3.0/sites-enabled/default[59]: Invalid type "bogus" in listen section.' });
    write(target, SITES, site(target).replace('type = bogus\n', ''));
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: false, error: '/etc/freeradius/3.0/sites-enabled/default[59]: No type specified in listen section' });
  });

  it('a listen type the real server has and this one has not is refused naming it, not accepted and ignored', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('type = auth\n', 'type = detail\n'));
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: false, error: '/etc/freeradius/3.0/sites-enabled/default[59]: The listen type "detail" is not implemented in this simulator' });
  });

  it('the unknown-client line names the listener the packet came to', async () => {
    const { client, target } = await labWithSite((text) => text.replace('type = auth\n\t\tipaddr = *\n\t\tport = 0', 'type = auth\n\t\tipaddr = *\n\t\tport = 18120'));
    write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.9\n  secret = shared\n}\n');
    await target.executeCommand('systemctl reload freeradius');
    await client.executeCommand(`${ALICE} | radclient -t 1 -r 1 10.0.0.2:18120 auth shared`);
    expect(vfsOf(target).readFile('/var/log/freeradius/radius.log') ?? '').toContain('Ignoring request to auth address * port 18120 bound to server default from unknown client 10.0.0.1');
  });

  it('witness for the log: on the default port the same line names port 1812', async () => {
    const { client, target } = await lab('10.0.0.9');
    await client.executeCommand(`${ALICE} | radclient -t 1 -r 1 10.0.0.2 auth shared`);
    expect(vfsOf(target).readFile('/var/log/freeradius/radius.log') ?? '').toContain('Ignoring request to auth address * port 1812 bound to server default from unknown client 10.0.0.1');
  });

  it('an ipv6addr that is not an IPv6 address is refused in the words of the source', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('type = auth\n', 'type = auth\n\t\tipv6addr = 10.0.0.1\n'));
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: false, error: '/etc/freeradius/3.0/sites-enabled/default[59]: Failed finding address for 10.0.0.1' });
  });
});
