/*
 * Probe: the built-in comparisons of the server and the preprocess hacks were missing. Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_expr/paircmp.c (presufcmp: Prefix and Suffix compare against the current User-Name; on a match, unless the check
 * list says Strip-User-Name = No, the user name is replaced by a Stripped-User-Name that the later lookups use; packetcmp for
 * Packet-Type; genericcmp for Client-IP-Address, Packet-Src-IP-Address, Packet-Dst-IP-Address, Packet-Src-Port, Packet-Dst-Port and
 * Virtual-Server), src/modules/rlm_preprocess/rlm_preprocess.c (rad_mangle: with_ntdomain_hack cuts DOMAIN\name, with_specialix_
 * jetstream_hack cuts the 10-character prefix and its slash, Service-Type = Framed-User is added when Framed-Protocol is present
 * without one; ascend_nasport_hack with ascend_channels_per_line; cisco_vsa_hack; Event-Timestamp and CHAP-Challenge added to the
 * request; the order of mod_authorize), raddb/mods-config/preprocess/hints (DEFAULT Suffix == \".ppp\", Strip-User-Name = Yes ...).
 * with_cablelabs_vsa_hack is accepted and does nothing in the source; with_alvarion_vsa_hack renumbers a vendor the simulator's
 * dictionary does not have and is refused when set.
 *
 * Discriminated with git stash on src: the file does not even load on the base (the Cisco case imports the new NO_PREPROCESS); with that
 * case removed, 8 of 11 fall before the fix, and three pass either way and are named: the witness (a plain user name logs in), the
 * removed hints (bob.ppp is unknown before as after) and Strip-User-Name = No (the name stays whole before as after).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { applyPreprocess, NO_PREPROCESS } from '@/network/devices/linux/freeradius/PreprocessModule';
import { newContext } from '@/network/devices/linux/freeradius/Unlang';
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
const MODULE = '/etc/freeradius/3.0/mods-enabled/preprocess';
const PRE = '/etc/freeradius/3.0/mods-config/preprocess';
const login = (user: string, password: string, extra = '', server = '10.0.0.2') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n${extra}' | radclient -x ${server} auth shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const asciiIf = (condition: string, message: string) => (text: string) =>
  text.replace('\t\tpap\n\t}', `\t\tif (${condition}) {\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "${message}"\n\t\t\t}\n\t\t}\n\t\tpap\n\t}`);

async function labWith(users: string, setup: (target: LinuxServer) => void = () => undefined, siteEdit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, siteEdit(site(made.target)));
  setup(made.target);
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

const option = (setting: string) => (target: LinuxServer) => write(target, MODULE, (vfsOf(target).readFile(MODULE) ?? '').replace(/\n\}\n?$/, `\n\t${setting}\n}\n`));
const BOB = 'bob Cleartext-Password := "builder"\n';

describe('built-in comparisons and the preprocess hacks', () => {
  it('witness: a plain user name logs in', async () => {
    const { client } = await labWith(BOB);
    expect(await client.executeCommand(login('bob', 'builder'))).toContain('Received Access-Accept');
  });

  it('the shipped hints: bob.ppp matches Suffix == ".ppp", the name is stripped to bob for the users file, and the hint is set', async () => {
    const { client } = await labWith(BOB);
    expect(await client.executeCommand(login('bob.ppp', 'builder'))).toContain('Received Access-Accept');
    const users = 'bob Cleartext-Password := "builder"\nDEFAULT Hint == "PPP", Service-Type == Framed-User, Framed-Protocol == PPP, Cleartext-Password := "pppsecret"\n';
    const hinted = await labWith(users);
    expect(await hinted.client.executeCommand(login('zed.ppp', 'pppsecret'))).toContain('Received Access-Accept');
  });

  it('without the hints, bob.ppp is an unknown user', async () => {
    const { client } = await labWith(BOB, (target) => write(target, `${PRE}/hints`, ''));
    expect(await client.executeCommand(login('bob.ppp', 'builder'))).toContain('Received Access-Reject');
  });

  it('Strip-User-Name = No in the check list keeps the name whole: bob.ppp is not bob', async () => {
    const { client } = await labWith(BOB, (target) => write(target, `${PRE}/hints`, 'DEFAULT Suffix == ".ppp", Strip-User-Name = No\n\tHint = "PPP"\n'));
    expect(await client.executeCommand(login('bob.ppp', 'builder'))).toContain('Received Access-Reject');
  });

  it('Prefix strips the front: ppp-bob is bob', async () => {
    const { client } = await labWith(BOB, (target) => write(target, `${PRE}/hints`, 'DEFAULT Prefix == "ppp-", Strip-User-Name = Yes\n\tHint = "PPP"\n'));
    expect(await client.executeCommand(login('ppp-bob', 'builder'))).toContain('Received Access-Accept');
  });

  it('the packet attributes compare in the users file, the huntgroups and the conditions: source, destination, ports, client, server, type', async () => {
    const users = 'DEFAULT Packet-Src-IP-Address == 10.0.0.1, Packet-Dst-IP-Address == 10.0.0.2, Packet-Dst-Port == 1812, Client-IP-Address == 10.0.0.1, Virtual-Server == default, Packet-Type == Access-Request, Cleartext-Password := "ip"\n';
    const { client } = await labWith(users);
    expect(await client.executeCommand(login('anyone', 'ip'))).toContain('Received Access-Accept');
    const other = await labWith('DEFAULT Packet-Src-IP-Address == 10.0.0.9, Cleartext-Password := "ip"\n');
    expect(await other.client.executeCommand(login('anyone', 'ip'))).toContain('Received Access-Reject');
    const hunt = await labWith('DEFAULT Huntgroup-Name == "lab", Cleartext-Password := "ip"\n', (target) => write(target, `${PRE}/huntgroups`, 'lab\tPacket-Src-IP-Address == 10.0.0.1\n'));
    expect(await hunt.client.executeCommand(login('anyone', 'ip'))).toContain('Received Access-Accept');
    const cond = await labWith(BOB, () => undefined, asciiIf('&Packet-Src-Port > 0 && &Packet-Dst-Port == 1812', 'ports'));
    expect(await cond.client.executeCommand(login('bob', 'builder'))).toContain('Reply-Message = "ports"');
  });

  it('with_ntdomain_hack cuts DOMAIN\\name; without it the name stays whole', async () => {
    const attempt = async (made: { client: LinuxServer }) => {
      write(made.client, '/tmp/nt.txt', 'User-Name = "CORP\\\\bob"\nUser-Password = "builder"\n');
      return made.client.executeCommand('radclient -f /tmp/nt.txt 10.0.0.2 auth shared');
    };
    expect(await attempt(await labWith(BOB, option('with_ntdomain_hack = yes')))).toContain('Received Access-Accept');
    expect(await attempt(await labWith(BOB))).toContain('Received Access-Reject');
  });

  it('with_specialix_jetstream_hack cuts the ten characters and the slash', async () => {
    const { client } = await labWith(BOB, option('with_specialix_jetstream_hack = yes'));
    expect(await client.executeCommand(login('abcdefghij/bob', 'builder'))).toContain('Received Access-Accept');
  });

  it('with_ascend_hack renumbers NAS-Port with ascend_channels_per_line: 20105 is channel 5 of line 1, port 4', async () => {
    const run = async (setting: string[]) => {
      const { client } = await labWith(BOB, (target) => setting.forEach((line) => option(line)(target)), asciiIf('&NAS-Port == 4', 'ascend'));
      return client.executeCommand(login('bob', 'builder', 'NAS-Port = 20105\\n'));
    };
    expect(await run(['with_ascend_hack = yes'])).toContain('Reply-Message = "ascend"');
    expect(await run([])).not.toContain('Reply-Message = "ascend"');
  });

  it('with_cisco_vsa_hack adds the attribute a Cisco-AVPair names inside its value, and strips the name from other Cisco VSAs', () => {
    const request = [{ type: 'vendor-specific' as const, value: 'Framed-Protocol=PPP', vendor: { id: 9, type: 1 } }, { type: 'vendor-specific' as const, value: 'h323-conf-id=abc', vendor: { id: 9, type: 24 } }];
    const files = (ciscoVsa: boolean) => ({ ...NO_PREPROCESS, options: { ...NO_PREPROCESS.options, ciscoVsa } });
    const hacked = newContext('anyone', request);
    applyPreprocess(files(true), hacked, '10.0.0.1', 0, () => []);
    expect(hacked.request.some((attribute) => attribute.type === 'framed-protocol' && attribute.value === 1)).toBe(true);
    expect(hacked.request.filter((attribute) => attribute.vendor?.type === 24).map((attribute) => attribute.value)).toEqual(['abc']);
    const plain = newContext('anyone', request);
    applyPreprocess(files(false), plain, '10.0.0.1', 0, () => []);
    expect(plain.request.some((attribute) => attribute.type === 'framed-protocol')).toBe(false);
  });

  it('Service-Type = Framed-User is added when Framed-Protocol is present without one; Event-Timestamp and CHAP-Challenge are added', async () => {
    const users = 'DEFAULT Service-Type == Framed-User, Cleartext-Password := "framed"\n';
    const { client } = await labWith(users);
    expect(await client.executeCommand(login('anyone', 'framed', 'Framed-Protocol = PPP\\n'))).toContain('Received Access-Accept');
    expect(await client.executeCommand(login('anyone', 'framed'))).toContain('Received Access-Reject');
    const stamped = await labWith(BOB, () => undefined, asciiIf('&Event-Timestamp > 0', 'stamped'));
    expect(await stamped.client.executeCommand(login('bob', 'builder'))).toContain('Reply-Message = "stamped"');
    const chap = await labWith(BOB, () => undefined, asciiIf('&CHAP-Challenge', 'challenge'));
    expect(await chap.client.executeCommand(`printf 'User-Name = "bob"\\nCHAP-Password = "builder"\\n' | radclient -x 10.0.0.2 auth shared`)).toContain('Reply-Message = "challenge"');
  });

  it('with_alvarion_vsa_hack is refused naming why; with_cablelabs_vsa_hack is accepted and does nothing; a bad boolean or channel count is refused', async () => {
    const { target } = await lab();
    option('with_alvarion_vsa_hack = yes')(target);
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/with_alvarion_vsa_hack is not implemented in this simulator/);
    write(target, MODULE, (vfsOf(target).readFile(MODULE) ?? '').replace('\twith_alvarion_vsa_hack = yes\n', '\twith_cablelabs_vsa_hack = yes\n'));
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: true });
    option('with_ntdomain_hack = maybe')(target);
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/Invalid value 'maybe' for boolean variable with_ntdomain_hack$/);
    write(target, MODULE, (vfsOf(target).readFile(MODULE) ?? '').replace('\twith_ntdomain_hack = maybe\n', '\tascend_channels_per_line = many\n'));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/Invalid value 'many' for variable ascend_channels_per_line$/);
  });
});
