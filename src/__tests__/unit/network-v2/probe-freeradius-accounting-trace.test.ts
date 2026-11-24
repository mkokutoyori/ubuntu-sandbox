/*
 * Probe: the `-X` trace of an Accounting-Request showed only the packets in and out, with the sections run in between left out.
 * Source of truth: FreeRADIUS v3.2.x src/main/auth.c / process.c rad_virtual_server (the same `Virtual server <name> received
 * request` ... `server <name> {` ... `} # server <name>` ... `Virtual server sending reply` frame as an Access-Request), modcall.c
 * (`# Executing section <name> from file <file> line <n>`, `<name> {`, `[module] = rcode`, `} # <name> = rcode`), the site's
 * own preacct and accounting sections in the order they are written, and a preacct that rejects: accounting does not run.
 * The text is built from the sources like the Access-Request trace; no real -X capture of an accounting request was reachable.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; the one passing either way is the witness that the packets in
 * and out are traced and the Accounting-Response is answered.
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

describe('the -X trace of an Accounting-Request', () => {
  it('witness: the packets in and out are traced and the Accounting-Response is answered', async () => {
    const { lines, output } = await traced();
    expect(output).toContain('Received Accounting-Response');
    expect(lines.some((line) => line.startsWith('Received Accounting-Request Id'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Sent Accounting-Response Id'))).toBe(true);
  });

  it('prints the virtual server frame with both sections and the modules of the site in order', async () => {
    const { lines } = await traced();
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at('Virtual server default received request')).toBeGreaterThan(-1);
    expect(at('# Executing section preacct from file')).toBeGreaterThan(at('server default {'));
    expect(at('[preprocess] = ok')).toBeGreaterThan(at('preacct {'));
    expect(at('} # preacct = updated')).toBeGreaterThan(at('[acct_unique] = updated'));
    expect(at('# Executing section accounting from file')).toBeGreaterThan(at('} # preacct'));
    expect(at('[radutmp] = ok')).toBeGreaterThan(at('accounting {'));
    expect(at('} # server default')).toBeGreaterThan(at('} # accounting'));
    expect(at('Virtual server sending reply')).toBeGreaterThan(at('} # server default'));
  });

  it('names the site file and line of each section', async () => {
    const { lines, target } = await traced();
    const line = site(target).split('\n').findIndex((text) => text.trim() === 'accounting {') + 1;
    expect(lines.some((text) => text.includes(`# Executing section accounting from file`) && text.endsWith(` line ${line}`))).toBe(true);
  });

  it('a module removed from the site is not in the trace', async () => {
    const { lines } = await traced((text) => text.replace(/(\taccounting \{[\s\S]*?)\t\tradutmp\n/, '$1'));
    expect(lines.some((text) => text.includes('[radutmp]'))).toBe(false);
    expect(lines.some((text) => text.includes('[detail]'))).toBe(true);
  });

  it('a preacct that rejects stops the trace before accounting', async () => {
    const { lines } = await traced((text) => text.replace('\tpreacct {\n', '\tpreacct {\n\t\treject\n'));
    expect(lines.some((text) => text.includes('} # preacct = reject'))).toBe(true);
    expect(lines.some((text) => text.includes('# Executing section accounting'))).toBe(false);
  });
});
