/*
 * Probe: radmin and the control listener were absent. Source of truth: FreeRADIUS v3.2.x src/main/radmin.c (options, the ENOENT
 * hint printed when the control socket cannot be opened, "Could not find control socket in"), src/main/command.c
 * (command_show_clients: one address per line, /prefix only for a network, `verbose` prints a client block; Unknown command
 * wording), raddb/sites-available/control-socket (listen { type = control socket = ${run_dir}/${name}.sock }, not enabled by default).
 * The control listener is read from the site (top level or in a server); its keys other than type/socket/mode are refused naming
 * them. Commands the real radmin has and the simulator lacks are refused naming the limit; unknown words get the source's wording.
 *
 * `show client config <ipaddr>` prints the client's configuration section (command.c cprint_conf_section: `name1 name2 {`, one tab per
 * level, `name = value` in file order), finds the client by longest prefix, and answers `Must specify <ipaddr>` / `No such client` /
 * `Unknown argument X.`; the `listen` option is refused. The `Failed parsing IP address` suffix of the real answer is not reproduced.
 *
 * Discriminated with git stash on src: the first 9 cases fall 8 of 9 before the commit that added radmin (the witness passes either way:
 * a top-level control listener was ignored before, so the daemon starts and answers a request the same way); the 4 cases for show client
 * config and the 2 for show module list all fall on the commit that precedes them. `show module list` names the modules
 * the simulator loads from the configuration (detail, preprocess, the realm instances): the others of a real list (pap, chap, files...)
 * have no configuration section here.
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
import { CLIENTS_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const ENABLED = '/etc/freeradius/3.0/sites-enabled';
const SOCKET = '/var/run/freeradius/freeradius.sock';

async function lab(enableControl: boolean, control = 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\nclient net {\n  ipaddr = 192.168.0.0/16\n  secret = other\n  shortname = lan\n}\n');
  if (enableControl) write(target, `${ENABLED}/control-socket`, control);
  const restarted = await target.executeCommand('systemctl restart freeradius');
  return { client, target, restarted };
}

const radmin = async (server: LinuxServer, args: string) => {
  const output = (await server.executeCommand(`radmin ${args}`)).trim();
  const code = (await server.executeCommand('echo $?')).trim();
  return { output, code };
};

describe('radmin and the control listener', () => {
  it('witness: the daemon runs and answers a request with the control site enabled', async () => {
    const { client, restarted } = await lab(true);
    expect(restarted).not.toContain('not implemented');
    expect(await client.executeCommand(`printf 'User-Name = "x"\\nUser-Password = "y"\\n' | radclient -r 1 10.0.0.2 auth shared`)).toContain('Access-Reject');
  });

  it('show client list prints one address per line, a network with its prefix', async () => {
    const { target } = await lab(true);
    expect(await radmin(target, '-f ' + SOCKET + ' -e "show client list"')).toEqual({ output: '10.0.0.1\n192.168.0.0/16', code: '0' });
  });

  it('show client list verbose prints a block per client with its secret and number', async () => {
    const { target } = await lab(true);
    const { output } = await radmin(target, '-f ' + SOCKET + ' -e "show client list verbose"');
    expect(output).toContain('client lab {');
    expect(output).toContain('\tipaddr = 10.0.0.1');
    expect(output).toContain('\tsecret = shared');
    expect(output).toContain('\tshortname = lan');
    expect(output).toContain('\tnumber = 1');
  });

  it('without -f the socket is read from the enabled site', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-e "show client list"')).output).toContain('10.0.0.1');
  });

  it('refuses to connect when the control site is not enabled, with the source hint', async () => {
    const { target } = await lab(false);
    const { output, code } = await radmin(target, '-f ' + SOCKET + ' -e "show client list"');
    expect(output).toContain(`radmin: Failed connecting to ${SOCKET}: No such file or directory`);
    expect(output).toContain('ln -s sites-available/control-socket sites-enabled/control-socket');
    expect(code).toBe('1');
  });

  it('without -f and without a control listener the configuration has no socket to read', async () => {
    const { target } = await lab(false);
    expect((await radmin(target, '-e "show client list"')).output).toBe('radmin: Could not find control socket in /etc/freeradius/3.0/radiusd.conf');
  });

  it('an unknown word gets the source wording, a real command the simulator lacks is refused naming the limit', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "frobnicate"')).output).toBe("ERROR: Unknown command 'frobnicate'");
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module config detail"')).output).toContain('not implemented in this simulator');
  });

  it('refuses a control listener key the simulator cannot honour, naming it', async () => {
    const { restarted } = await lab(true, 'listen {\n  type = control\n  socket = /tmp/x.sock\n  uid = radius\n}\n');
    expect(restarted).toContain('The control listener setting "uid" is not implemented in this simulator');
  });

  it('refuses an option it cannot honour instead of ignoring it', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-i commands.txt')).output).toBe('radmin: -i is not implemented in this simulator');
  });

  it('show client config prints the client section as written, pairs in file order', async () => {
    const { target } = await lab(true);
    expect(await radmin(target, '-f ' + SOCKET + ' -e "show client config 10.0.0.1"')).toEqual({ output: 'client lab {\n\tipaddr = 10.0.0.1\n\tsecret = shared\n}', code: '0' });
  });

  it('show client config finds a network client by longest prefix and keeps its other pairs', async () => {
    const { target } = await lab(true);
    const { output } = await radmin(target, '-f ' + SOCKET + ' -e "show client config 192.168.7.9"');
    expect(output).toBe('client net {\n\tipaddr = 192.168.0.0/16\n\tsecret = other\n\tshortname = lan\n}');
  });

  it('show client config answers the source errors', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client config"')).output).toBe('ERROR: Must specify <ipaddr>');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client config 172.16.0.1"')).output).toBe('ERROR: No such client');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client config 10.0.0.1 sctp"')).output).toBe('ERROR: Unknown argument sctp.');
  });

  it('refuses the listen option, naming the limit', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client config 10.0.0.1 listen 10.0.0.2 1812"')).output).toContain('listen is not implemented in this simulator');
  });

  it('show module list prints the module instances of the configuration, a named instance as name (type)', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module list"')).output).toBe(
      ['detail', 'preprocess', 'IPASS (realm)', 'suffix (realm)', 'bangpath (realm)', 'realmpercent (realm)', 'ntdomain (realm)'].join('\n'),
    );
  });

  it('show module list follows the files of mods-enabled: an added instance appears', async () => {
    const { target } = await lab(true);
    write(target, '/etc/freeradius/3.0/mods-enabled/realm', (vfsOf(target).readFile('/etc/freeradius/3.0/mods-enabled/realm') ?? '') + 'realm extra {\n  format = suffix\n  delimiter = "#"\n}\n');
    await target.executeCommand('systemctl restart freeradius');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module list"')).output.split('\n')).toContain('extra (realm)');
  });
});
