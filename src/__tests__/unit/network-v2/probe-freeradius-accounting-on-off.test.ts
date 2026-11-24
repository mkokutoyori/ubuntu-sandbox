/*
 * Probe: Accounting-On and Accounting-Off bypassed the site: the server closed the NAS's sessions, wrote its detail entry and answered,
 * but the preacct and accounting programs of the site never ran for them. Source of truth: FreeRADIUS v3.2.x src/main/acct.c / process.c
 * (an Accounting-Request of any Acct-Status-Type goes through the same preacct and accounting sections; rlm_radutmp closes the NAS's
 * sessions for On/Off from inside accounting; a reject in preacct drops the request without a response) and the previous
 * accounting-program work (one request context). The sessions are still closed first; what the site writes in its sections now applies
 * to these packets too, and the -X trace shows them.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the one passing either way is the witness that the Accounting-Response comes back.
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
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const START = `printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient 10.0.0.2 acct shared`;

async function traced(edit: (text: string) => string = (text) => text) {
  const made = await lab();
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  const output = await made.client.executeCommand(START);
  return { ...made, lines, output };
}

const SITE_FILE = '/etc/freeradius/3.0/sites-available/default';
const ON = `printf 'Acct-Status-Type = Accounting-On\\nNAS-IP-Address = 10.0.0.1\\n' | radclient -r 1 10.0.0.2 acct shared`;

async function reboot(edit: (text: string) => string = (text) => text) {
  const made = await lab();
  write(made.target, SITE_FILE, edit(vfsOf(made.target).readFile(SITE_FILE) ?? ''));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  const output = await made.client.executeCommand(ON);
  return { ...made, lines, output };
}

describe('Accounting-On through the site sections', () => {
  it('witness: the NAS gets its Accounting-Response', async () => {
    const { output } = await reboot();
    expect(output).toContain('Received Accounting-Response');
  });

  it('the preacct and accounting sections run for it, with their modules, in the trace', async () => {
    const { lines } = await reboot();
    expect(lines.some((line) => line.startsWith('# Executing section preacct'))).toBe(true);
    expect(lines.some((line) => line.startsWith('# Executing section accounting'))).toBe(true);
    expect(lines).toContain('[detail] = ok');
  });

  it('an if on the status type runs the statements written for it', async () => {
    const { lines } = await reboot((text) => text.replace('\taccounting {\n', '\taccounting {\n\t\tif (&Acct-Status-Type == Accounting-On) {\n\t\t\tupdate request {\n\t\t\t\tCalled-Station-Id := "rebooted"\n\t\t\t}\n\t\t}\n'));
    expect(lines).toContain('if (&Acct-Status-Type == Accounting-On)  -> TRUE');
    expect(lines).toContain('&request:Called-Station-Id := "rebooted"');
  });

  it('a reject in preacct drops the request: no Accounting-Response', async () => {
    const { output } = await reboot((text) => text.replace('\tpreacct {\n', '\tpreacct {\n\t\treject\n'));
    expect(output).toContain('No reply from server');
  });
});
