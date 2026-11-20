/*
 * Probe: `freeradius -X` printed the packets and nothing of what the server did with them. Source of truth: FreeRADIUS v3.2.x
 * src/main/auth.c rad_virtual_server ("Virtual server %s received request", the attributes, "server %s {", "} # server %s",
 * "Virtual server sending reply"), src/main/modules.c ("# Executing section %s from file %s line %d", "# Executing group from file
 * %s line %d"), src/main/modcall.c ("%s {", "[%s] = %s", "} # %s = %s" with the rcode names reject fail ok handled invalid
 * userlock notfound noop updated), auth.c rad_check_password ("Found Auth-Type = %s", "No Auth-Type found: rejecting the user via
 * Post-Auth-Type = Reject", "Failed to authenticate the user"), rlm_pap.c ("Login attempt with password", "Comparing with \"known
 * good\" Cleartext-Password", "Comparing with \"known-good\" MD5-Password", "User authenticated successfully", the ERROR lines of a
 * failed comparison, the WARNINGs of a missing known-good password), rlm_chap.c, rlm_files.c ("Matched entry %s at line %d"),
 * rlm_logintime.c, rlm_eap. The sections, their order, their file and line and the Auth-Type blocks come from the site that is read,
 * the result of each module from what the module did with this request. The text is built from the sources, no capture of a real
 * -X session was reachable from here; post-auth and the proxy sections are not traced.
 *
 * Discriminated with git stash on src: 9 of 10 fall before the fix; the one that passes either way is the case with the debug
 * off (no -X, nothing printed).
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
const ENABLED = '/etc/freeradius/3.0/sites-enabled/default';
const ALICE = (password: string) => `printf 'User-Name = "alice"\\nUser-Password = "${password}"\\n' | radclient 10.0.0.2 auth shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const lineOf = (target: LinuxServer, text: string) => site(target).split('\n').findIndex((line) => line.trim() === text) + 1;

async function traced(users: string, command: (c: string) => string, edit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  await made.client.executeCommand(command('x'));
  return { ...made, lines };
}

const trim = (lines: string[]) => lines.map((line) => line.trim());
const indexOfTrimmed = (lines: string[], text: string) => trim(lines).indexOf(text);

describe('freeradius -X per-request trace', () => {
  it('an accepted PAP login: the section, its modules in the site order with their results, the Auth-Type block, the reply', async () => {
    const { lines, target } = await traced('alice Cleartext-Password := "wonderland"\n\tReply-Message = "hello"\n', () => ALICE('wonderland'));
    const at = (text: string) => indexOfTrimmed(lines, text);
    const authorizeLine = lineOf(target, 'authorize {');
    expect(at('Virtual server default received request')).toBeGreaterThan(-1);
    expect(at('server default {')).toBeGreaterThan(at('Virtual server default received request'));
    expect(trim(lines)).toContain(`# Executing section authorize from file ${ENABLED} line ${authorizeLine}`);
    const order = ['authorize {', '[preprocess] = ok', '[chap] = noop', '[mschap] = noop', '[eap] = noop', '[files] = ok', '[logintime] = noop', '[pap] = updated', '} # authorize = updated'].map(at);
    expect(order.every((value) => value > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const after = ['Found Auth-Type = PAP', 'Auth-Type PAP {', 'pap: Login attempt with password', 'pap: Comparing with "known good" Cleartext-Password', 'pap: User authenticated successfully', '[pap] = ok', '} # Auth-Type PAP = ok', '} # server default', 'Virtual server sending reply'].map(at);
    expect(after.every((value) => value > -1)).toBe(true);
    expect([...after].sort((a, b) => a - b)).toEqual(after);
    expect(after[0]).toBeGreaterThan(order[order.length - 1]);
    expect(lines.slice(at('Virtual server sending reply') + 1)[0]).toContain('Reply-Message = "hello"');
  });

  it('the indentation is the one of modcall: the section inside the server block, a module result one level in, its own messages one more', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland"\n', () => ALICE('wonderland'));
    const indent = (text: string) => (lines.find((line) => line.trim() === text) ?? '').search(/\S/);
    expect(indent('server default {')).toBe(0);
    expect(indent('} # server default')).toBe(0);
    expect(indent('authorize {')).toBe(4);
    expect(indent('[preprocess] = ok')).toBe(6);
    expect(indent('eap: No EAP-Message, not doing EAP')).toBe(8);
  });

  it('a wrong password: the comparison fails with the ERROR line, the block ends reject, and the user is not authenticated', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland"\n', () => ALICE('nope'));
    const text = trim(lines);
    expect(text).toContain('pap: ERROR: Cleartext password does not match "known good" password');
    expect(text).toContain('[pap] = reject');
    expect(text).toContain('} # Auth-Type PAP = reject');
    expect(text.indexOf('Failed to authenticate the user')).toBeGreaterThan(text.indexOf('} # Auth-Type PAP = reject'));
  });

  it('an unknown user: pap warns that it has no known good password, no Auth-Type is found and the request is rejected', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland"\n', () => `printf 'User-Name = "ghost"\\nUser-Password = "x"\\n' | radclient 10.0.0.2 auth shared`);
    const text = trim(lines);
    expect(text).toContain('[files] = noop');
    expect(text).toContain('pap: WARNING: No "known good" password found for the user.  Not setting Auth-Type');
    expect(text).toContain('[pap] = noop');
    expect(text).toContain('} # authorize = ok');
    expect(text).toContain('ERROR: No Auth-Type found: rejecting the user via Post-Auth-Type = Reject');
    expect(text).not.toContain('Found Auth-Type = PAP');
  });

  it('the modules of the trace are the ones of the site: one left out of authorize is not in the trace, and the order is the site\'s', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland"\n', () => ALICE('wonderland'), (text) => text.replace('\t\tchap\n\t\tmschap\n', '\t\tmschap\n'));
    const text = trim(lines);
    expect(text).not.toContain('[chap] = noop');
    expect(text).toContain('[mschap] = noop');
  });

  it('a hashed known-good password is named in the comparison line', async () => {
    const { lines } = await traced('alice MD5-Password := "5f4dcc3b5aa765d61d8327deb882cf99"\n', () => ALICE('password'));
    expect(trim(lines)).toContain('pap: Comparing with "known-good" MD5-Password');
  });

  it('a CHAP request: chap sets the Auth-Type, the CHAP block authenticates', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland"\n', () => `printf 'User-Name = "alice"\\nCHAP-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`);
    const text = trim(lines);
    expect(text).toContain('chap: &control:Auth-Type := CHAP');
    expect(text).toContain('[chap] = ok');
    expect(text).toContain('Found Auth-Type = CHAP');
    expect(text).toContain('chap: CHAP user "alice" authenticated successfully');
    expect(text).toContain('} # Auth-Type CHAP = ok');
  });

  it('every users entry that matched is named with its line, and Login-Time shows its checks', async () => {
    const { lines } = await traced('alice Cleartext-Password := "wonderland", Login-Time := "Al"\n\tFall-Through = Yes\nDEFAULT Cleartext-Password := "wonderland"\n\tReply-Message = "all"\n', () => ALICE('wonderland'));
    const text = trim(lines);
    expect(text).toContain('files: /etc/freeradius/3.0/users: Matched entry alice at line 1');
    expect(text).toContain('files: /etc/freeradius/3.0/users: Matched entry DEFAULT at line 3');
    expect(text).toContain('logintime: Checking Login-Time');
  });

  it('Login-Time with time left: the module is updated and says the Session-Timeout it set', async () => {
    const made = await lab('10.0.0.1', 'alice Cleartext-Password := "wonderland", Login-Time := "Wk0900-1700"\n');
    await made.target.executeCommand('date -s "2030-01-02 10:00:00" >/dev/null');
    const lines: string[] = [];
    made.target.followRadiusDebug((line) => lines.push(line));
    await made.client.executeCommand(ALICE('wonderland'));
    const text = trim(lines.map((line) => line.replace(/^\(\d+\) /, '')));
    expect(text).toContain('[logintime] = updated');
    expect(text).toContain('logintime: reply:Session-Timeout set to 25260');
  });

  it('the debug off: a request prints nothing, and there is no per-request cost to see', async () => {
    const made = await lab('10.0.0.1', 'alice Cleartext-Password := "wonderland"\n');
    const lines: string[] = [];
    const stop = made.target.followRadiusDebug((line) => lines.push(line));
    stop();
    expect(await made.client.executeCommand(ALICE('wonderland'))).toContain('Received Access-Accept');
    expect(lines).toEqual([]);
  });
});
