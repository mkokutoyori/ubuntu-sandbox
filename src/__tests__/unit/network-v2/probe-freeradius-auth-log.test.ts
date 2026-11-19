/*
 * Probe: freeradius wrote nothing. Source of truth: FreeRADIUS v3.2.x src/main/auth.c (rad_authlog: "%s: [%s%s%s] (%s)%s" with
 * msg "Login OK" / "Login incorrect", the user, "/password" only when auth_goodpass / auth_badpass, and auth_name's
 * "from client <shortname> port <NAS-Port>[ cli <Calling-Station-Id>]"), src/main/log.c (the ": Auth: " category and
 * the "(<request number>)" prefix), src/main/mainconfig.c (log_config: auth, auth_accept, auth_reject, auth_badpass,
 * auth_goodpass; `auth = yes` implies accept and reject; "Unknown log_destination %s"), src/lib/conffile.c ("Invalid value
 * '%s' for boolean variable %s", yes/true/on, no/false/off), raddb/radiusd.conf.in (log section, default `auth = no`).
 * A reject also stopped carrying the invented Reply-Message "Authentication failed": a stock FreeRADIUS sends none.
 *
 * Discriminated with git stash on src/network: 11 of 12 fall before the fix; one passes either way and is named: the witness
 * (with the stock `auth = no` nothing is logged, which was also true when nothing could be).
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

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const CONF_PATH = '/etc/freeradius/3.0/radiusd.conf';
const LOG_PATH = '/var/log/freeradius/radius.log';

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

const confWith = (logLines: string[]) => `logdir = /var/log/freeradius\nlog {\n\tdestination = files\n\tfile = \${logdir}/radius.log\n${logLines.map((line) => `\t${line}\n`).join('')}}\n`;

async function lab(logLines: string[]) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  write(target, CONF_PATH, confWith(logLines));
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

const login = (client: LinuxServer, user: string, password: string) => client.executeCommand(`radtest ${user} ${password} 10.0.0.2 0 shared`);
const logOf = (target: LinuxServer) => vfsOf(target).readFile(LOG_PATH) ?? '';
const AUTH_LINE = (message: string) => new RegExp(`^\\w{3} \\w{3} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d \\d{4} : Auth: \\(\\d+\\) ${message}$`, 'm');

describe('freeradius auth log', () => {
  it('witness: with the stock auth = no, nothing is logged', async () => {
    const { client, target } = await lab(['auth = no']);
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).not.toContain('Login');
  });

  it('auth = yes logs a successful login in the rad_authlog format', async () => {
    const { client, target } = await lab(['auth = yes']);
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice\\] \\(from client lab port 0\\)'));
  });

  it('auth = yes logs a failed login as Login incorrect', async () => {
    const { client, target } = await lab(['auth = yes']);
    await login(client, 'alice', 'nope');
    expect(logOf(target)).toMatch(AUTH_LINE('Login incorrect: \\[alice\\] \\(from client lab port 0\\)'));
  });

  it('auth_badpass = yes adds the wrong password to the failure only', async () => {
    const { client, target } = await lab(['auth = yes', 'auth_badpass = yes']);
    await login(client, 'alice', 'nope');
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login incorrect: \\[alice/nope\\] \\(from client lab port 0\\)'));
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice\\] \\(from client lab port 0\\)'));
  });

  it('auth_goodpass = yes adds the right password to the success only', async () => {
    const { client, target } = await lab(['auth = yes', 'auth_goodpass = yes']);
    await login(client, 'alice', 'nope');
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice/wonderland\\] \\(from client lab port 0\\)'));
    expect(logOf(target)).toMatch(AUTH_LINE('Login incorrect: \\[alice\\] \\(from client lab port 0\\)'));
  });

  it('auth_accept alone logs accepts and not rejects', async () => {
    const { client, target } = await lab(['auth_accept = yes']);
    await login(client, 'alice', 'nope');
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toContain('Login OK');
    expect(logOf(target)).not.toContain('Login incorrect');
  });

  it('request numbers count the requests the server has seen', async () => {
    const { client, target } = await lab(['auth = yes']);
    await login(client, 'alice', 'wonderland');
    await login(client, 'alice', 'nope');
    const numbers = [...logOf(target).matchAll(/Auth: \((\d+)\)/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual([0, 1]);
  });

  it('the log file named in the configuration is the one written', async () => {
    const { client, target } = await lab(['auth = yes', 'file = /var/log/lab-radius.log']);
    await login(client, 'alice', 'wonderland');
    expect(vfsOf(target).readFile('/var/log/lab-radius.log') ?? '').toContain('Login OK');
  });

  it('an Access-Reject carries no Reply-Message of its own', async () => {
    const { client } = await lab(['auth = no']);
    expect(await login(client, 'alice', 'nope')).not.toContain('Reply-Message');
  });

  it('a value that is not a boolean stops the reload, with the conffile wording', async () => {
    const { target } = await lab(['auth = no']);
    write(target, CONF_PATH, confWith(['auth = maybe']));
    expect(await target.executeCommand('systemctl reload freeradius')).toContain(`${CONF_PATH}[5]: Invalid value 'maybe' for boolean variable auth`);
  });

  it('an unknown destination stops the reload, with the mainconfig wording', async () => {
    const { target } = await lab(['auth = no']);
    write(target, CONF_PATH, confWith(['auth = no']).replace('destination = files', 'destination = carrier-pigeon'));
    expect(await target.executeCommand('systemctl reload freeradius')).toContain('radiusd: Error: Unknown log_destination carrier-pigeon');
  });

  it('a daemon without radiusd.conf does not start', async () => {
    const { target } = await lab(['auth = no']);
    vfsOf(target).deleteFile(CONF_PATH);
    await target.executeCommand('systemctl stop freeradius');
    expect(await target.executeCommand('systemctl start freeradius')).toContain('Failed to start freeradius.service');
  });
});
