/*
 * Probe: msg_goodpass and msg_badpass of the log section. Source of truth: FreeRADIUS v3.2.x src/main/auth.c rad_authlog (the message is expanded with radius_xlat and appended after a
 * space to the line, "%s: [%s%s%s] (%s)%s": "Login OK" takes msg_goodpass, "Login incorrect" takes msg_badpass), src/main/mainconfig.c (log_config: msg_goodpass, msg_badpass, strings, no default).
 * The simulator read neither key. The expansion is the one the unlang and detail modules use, evaluated against the request attributes.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix. The witness (no message configured: the line ends after the parenthesis) passes either way.
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

describe('msg_goodpass and msg_badpass', () => {
  it('witness: without a message the line ends after the parenthesis', async () => {
    const { client, target } = await lab(['auth = yes']);
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice\\] \\(from client lab port 0\\)'));
  });

  it('msg_goodpass is appended to the success line after a space', async () => {
    const { client, target } = await lab(['auth = yes', 'msg_goodpass = "welcome back"']);
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice\\] \\(from client lab port 0\\) welcome back'));
  });

  it('msg_badpass goes to the failure only, and expands %{User-Name}', async () => {
    const { client, target } = await lab(['auth = yes', 'msg_goodpass = "ok"', 'msg_badpass = "refused %{User-Name}"']);
    await login(client, 'alice', 'nope');
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login incorrect: \\[alice\\] \\(from client lab port 0\\) refused alice'));
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice\\] \\(from client lab port 0\\) ok'));
  });

  it('it combines with auth_goodpass: the password stays inside the brackets, the message after', async () => {
    const { client, target } = await lab(['auth = yes', 'auth_goodpass = yes', 'msg_goodpass = "seen"']);
    await login(client, 'alice', 'wonderland');
    expect(logOf(target)).toMatch(AUTH_LINE('Login OK: \\[alice/wonderland\\] \\(from client lab port 0\\) seen'));
  });
});
