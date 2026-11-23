/*
 * Probe: `show module config|methods|flags <name>` and `show config <path>` answered "not implemented". Source of truth: FreeRADIUS v3.2.x
 * src/main/command.c (command_show_module_methods prints the section names whose method slot the module fills, in the order of method_names:
 * authenticate authorize preacct accounting session pre-proxy post-proxy post-auth recv-coa send-coa; command_show_module_flags prints
 * thread-unsafe / reload-on-hup from the module type; command_show_module_config -> cprint_conf_parser prints the parse table in
 * order, strings as name = 'value', integers as %u, booleans yes/no; "No module name was given" / "No such module '%s'"; command_show_config
 * prints the value of the pair a dotted path names and fails silently on an unknown path, "No path was given"), and the module_t tables of
 * rlm_detail / rlm_preprocess / rlm_realm / rlm_eap (methods and HUP_SAFE) read in the source tree. The configuration listing is
 * implemented for detail (its parse table is the one rlm_detail declares, the values come from the settings the simulator evaluates);
 * the other modules answer that their parse table is not implemented (preprocess followed: its table is the one rlm_preprocess declares).
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix; the witness (the module list still answers) passes either way. The preprocess table, added later, is a ninth case that falls before it.
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
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  proto = tcp\n  secret = shared\n}\nclient net {\n  ipaddr = 192.168.0.0/16\n  secret = other\n  shortname = lan\n}\n');
  if (enableControl) write(target, `${ENABLED}/control-socket`, control);
  const restarted = await target.executeCommand('systemctl restart freeradius');
  return { client, target, restarted };
}

const radmin = async (server: LinuxServer, args: string) => {
  const output = (await server.executeCommand(`radmin ${args}`)).trim();
  const code = (await server.executeCommand('echo $?')).trim();
  return { output, code };
};



const ask = async (target: LinuxServer, command: string) => radmin(target, `-f ${SOCKET} -e "${command}"`);

describe('radmin: module methods, flags, config and show config', () => {
  it('witness: the module list still answers', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'show module list')).output).toContain('detail');
  });

  it('show module methods names the sections the module fills, in the order of the source', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'show module methods detail')).output).toBe(['authorize', 'preacct', 'accounting', 'pre-proxy', 'post-proxy', 'post-auth', 'recv-coa', 'send-coa'].join('\n'));
    expect((await ask(target, 'show module methods preprocess')).output).toBe('authorize\npreacct');
    expect((await ask(target, 'show module methods suffix')).output).toBe('authorize\npreacct\nrecv-coa');
  });

  it('show module flags prints reload-on-hup for a HUP-safe module and nothing for the others', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'show module flags detail')).output).toBe('reload-on-hup');
    expect((await ask(target, 'show module flags preprocess')).output).toBe('');
  });

  it('show module config detail prints the parse table with the defaults, then the values of the section', async () => {
    const { target } = await lab(true);
    const text = (await ask(target, 'show module config detail')).output;
    expect(text.split('\n')[0]).toBe('detail {');
    expect(text).toContain("\tfilename = '/var/log/freeradius/radacct/%{%{Packet-Src-IP-Address}:-%{Packet-Src-IPv6-Address}}/detail-%Y%m%d'");
    expect(text).toContain("\theader = '%t'");
    expect(text).toContain('\tpermissions = 384');
    expect(text).toContain('\tlocking = no');
    write(target, '/etc/freeradius/3.0/mods-enabled/detail', 'detail {\n  filename = /tmp/detail-x\n  locking = yes\n}\n');
    await target.executeCommand('systemctl restart freeradius');
    const custom = (await ask(target, 'show module config detail')).output;
    expect(custom).toContain("\tfilename = '/tmp/detail-x'");
    expect(custom).toContain('\tlocking = yes');
  });

  it('show module config preprocess prints the rlm_preprocess table in its order, with the values written', async () => {
    const { target } = await lab(true);
    const text = (await ask(target, 'show module config preprocess')).output.split('\n');
    expect(text[0]).toBe('preprocess {');
    expect(text).toContain('\twith_ascend_hack = no');
    expect(text).toContain('\tascend_channels_per_line = 23');
    expect(text.indexOf('\twith_cisco_vsa_hack = no')).toBeGreaterThan(text.indexOf('\twith_ntdomain_hack = no'));
    write(target, '/etc/freeradius/3.0/mods-enabled/preprocess', "preprocess {\n  huntgroups = /etc/freeradius/3.0/mods-config/preprocess/huntgroups\n  with_cisco_vsa_hack = yes\n  ascend_channels_per_line = 30\n}\n");
    await target.executeCommand('systemctl restart freeradius');
    const custom = (await ask(target, 'show module config preprocess')).output;
    expect(custom).toContain("\thuntgroups = '/etc/freeradius/3.0/mods-config/preprocess/huntgroups'");
    expect(custom).toContain('\twith_cisco_vsa_hack = yes');
    expect(custom).toContain('\tascend_channels_per_line = 30');
  });

  it('show module config answers for a module whose parse table is not implemented, naming the limit', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'show module config suffix')).output).toContain("cannot be shown: its parse table is not implemented in this simulator");
  });

  it('refuses a missing or unknown module name in the words of the source', async () => {
    const { target } = await lab(true);
    for (const what of ['config', 'methods', 'flags']) {
      expect((await ask(target, `show module ${what}`)).output).toBe('ERROR: No module name was given');
      expect((await ask(target, `show module ${what} nosuch`)).output).toBe("ERROR: No such module 'nosuch'");
    }
  });

  it('show config prints the value of the pair a dotted path names', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'show config security.status_server')).output).toBe('yes');
    expect((await ask(target, 'show config log.destination')).output).toBe('files');
  });

  it('show config fails silently on an unknown path and asks for a path when none is given', async () => {
    const { target } = await lab(true);
    const unknown = await ask(target, 'show config no.such.path');
    expect(unknown.output).toBe('');
    expect(unknown.code).toBe('1');
    expect((await ask(target, 'show config')).output).toBe('ERROR: No path was given');
  });
});
