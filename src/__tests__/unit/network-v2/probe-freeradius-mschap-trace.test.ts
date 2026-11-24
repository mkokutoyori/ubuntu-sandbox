/*
 * Probe: the `-X` trace of an MS-CHAP request was absent (only the packets in and out). Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_mschap/rlm_mschap.c (authorize: "Found MS-CHAP attributes.  Setting 'Auth-Type  = mschap'", the Auth-Type is
 * set so the authenticate section's `Auth-Type MS-CHAP` group runs; authenticate: "Creating challenge hash with username",
 * "Client is using MS-CHAPv2", "Adding MS-CHAPv2 MPPE keys" on success, REDEBUG "MS-CHAP2-Response is incorrect" on a wrong
 * response), modcall.c group lines and the same virtual-server frame as the PAP trace. The text is built from the sources; no real
 * -X capture of an MS-CHAP exchange was reachable.
 *
 * Discriminated with git stash on src: 3 of 5 fall before the fix; two pass either way and are named: the witness (the exchange is
 * accepted and rejected as before) and the absence of a false 'No Auth-Type found' (vacuous on the base, where no block was printed at all;
 * it guards the after-fix trace against the misleading line the PAP block prints when no Auth-Type is known).
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

async function traced(password: string) {
  const made = await lab();
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  const output = await made.client.executeCommand(`radtest -t mschap alice ${password} 10.0.0.2 10 shared`);
  return { ...made, lines, output };
}

describe('the -X trace of an MS-CHAP request', () => {
  it('witness: a right password is accepted and a wrong one rejected', async () => {
    expect((await traced('wonderland')).output).toContain('Received Access-Accept');
    expect((await traced('wrong')).output).toContain('Access-Reject');
  });

  it('authorize announces the MS-CHAP attributes and sets the Auth-Type', async () => {
    const { lines } = await traced('wonderland');
    const found = lines.find((text) => text.includes('Found MS-CHAP attributes'));
    expect(found?.trim()).toBe("mschap: Found MS-CHAP attributes.  Setting 'Auth-Type  = mschap'");
    expect(lines).toContain('  Found Auth-Type = MS-CHAP');
  });

  it('runs the Auth-Type MS-CHAP group of the site with the module lines and a successful result', async () => {
    const { lines, target } = await traced('wonderland');
    const line = (vfsOf(target).readFile(SITES) ?? '').split('\n').findIndex((text) => text.includes('Auth-Type MS-CHAP')) + 1;
    expect(lines.some((text) => text.includes('# Executing group from file') && text.endsWith(` line ${line}`))).toBe(true);
    expect(lines).toContain('    Auth-Type MS-CHAP {');
    expect(lines).toContain('        mschap: Creating challenge hash with username: alice');
    expect(lines).toContain('        mschap: Client is using MS-CHAPv2');
    expect(lines).toContain('        mschap: Adding MS-CHAPv2 MPPE keys');
    expect(lines).toContain('      [mschap] = ok');
    expect(lines).toContain('    } # Auth-Type MS-CHAP = ok');
  });

  it('a wrong response prints the module error, a reject and the failure line', async () => {
    const { lines } = await traced('wrong');
    expect(lines).toContain('        mschap: ERROR: MS-CHAP2-Response is incorrect');
    expect(lines).toContain('      [mschap] = reject');
    expect(lines).toContain('    } # Auth-Type MS-CHAP = reject');
    expect(lines).toContain('  Failed to authenticate the user');
  });

  it('does not claim that no Auth-Type was found', async () => {
    const { lines } = await traced('wonderland');
    expect(lines.some((text) => text.includes('No Auth-Type found'))).toBe(false);
  });
});
