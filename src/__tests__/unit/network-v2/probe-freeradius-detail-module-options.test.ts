/*
 * Probe: the detail module had no configuration, only defaults. Source of truth: FreeRADIUS v3.2.x rlm_detail.c (module_config:
 * filename, header, permissions, group, locking, dates_as_integer, escape_filenames, log_packet_header; the suppress{} section
 * checked with dict_attrbyname => "No such attribute '%s'"; detail_write), src/main/util.c (rad_filename_make_safe: control
 * characters become '_', repeated slashes and "./" "../" after a slash are dropped; rad_filename_escape: A-Za-z0-9_ kept, '-' doubled,
 * everything else "-" + hex), src/lib/conffile.c (boolean wording; `$INCLUDE dir/`), raddb/radiusd.conf.in (`modules { $INCLUDE
 * mods-enabled/ }`) and raddb/mods-available/detail. Expansion supported in filename and header: %{Attribute}, the
 * %{%{A}:-%{B}} alternative, %t and the strftime letters; the Packet-Src/Dst-IP-Address and -Port pseudo attributes.
 *
 * Discriminated with git stash on src/network: 8 of 9 fall before the fix; one passes either way and is named: the witness
 * (the stock detail module writes under the client address).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const MODULE = '/etc/freeradius/3.0/mods-enabled/detail';
const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

async function lab(moduleBody: string) {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const server = new LinuxServer('linux-server', 'AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  vfsOf(server).writeFile(CLIENTS_CONF_PATH, 'client nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n', 0, 0, 0o022);
  nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
  vfsOf(server).writeFile(MODULE, `detail {\n${moduleBody}\n}\n`, 0, 0, 0o022);
  const reload = await server.executeCommand('systemctl reload freeradius');
  return { nas, server, reload };
}

const read = (server: LinuxServer, path: string) => vfsOf(server).readFile(path) ?? '';
const STOCK = '\tfilename = /var/log/freeradius/radacct/%{%{Packet-Src-IP-Address}:-%{Packet-Src-IPv6-Address}}/detail-%Y%m%d\n\theader = "%t"';

describe('the detail module reads its own configuration', () => {
  it('witness: the stock filename writes detail-<date> under the client address', async () => {
    const { nas, server } = await lab(STOCK);
    nas.getRadiusAccountingClient().startSession('alice');
    expect(await server.executeCommand('ls /var/log/freeradius/radacct/10.0.0.1')).toMatch(/detail-\d{8}/);
  });

  it('filename expands %{User-Name}', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/freeradius/radacct/by-user/%{User-Name}/detail\n\theader = "%t"');
    nas.getRadiusAccountingClient().startSession('alice');
    expect(read(server, '/var/log/freeradius/radacct/by-user/alice/detail')).toContain('Acct-Status-Type = Start');
  });

  it('header is expanded for each entry', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/d\n\theader = "from %{Packet-Src-IP-Address} for %{User-Name}"');
    nas.getRadiusAccountingClient().startSession('alice');
    expect(read(server, '/var/log/d').split('\n')[0]).toBe('from 10.0.0.1 for alice');
  });

  it('log_packet_header adds the packet source and destination', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/d\n\theader = "%t"\n\tlog_packet_header = yes');
    nas.getRadiusAccountingClient().startSession('alice');
    const text = read(server, '/var/log/d');
    expect(text).toContain('\tPacket-Src-IP-Address = 10.0.0.1');
    expect(text).toContain('\tPacket-Dst-IP-Address = 10.0.0.2');
    expect(text).toContain('\tPacket-Dst-Port = 1813');
  });

  it('suppress{} removes the attribute from the entry', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/d\n\theader = "%t"\n\tsuppress {\n\t\tUser-Name\n\t}');
    nas.getRadiusAccountingClient().startSession('alice');
    const text = read(server, '/var/log/d');
    expect(text).toContain('Acct-Status-Type = Start');
    expect(text).not.toContain('User-Name');
  });

  it('permissions sets the mode of the file', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/d\n\theader = "%t"\n\tpermissions = 0640');
    nas.getRadiusAccountingClient().startSession('alice');
    expect(await server.executeCommand('stat -c %a /var/log/d')).toContain('640');
  });

  it('escape_filenames = yes escapes the expanded value (rad_filename_escape), the literal path untouched', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/by/%{User-Name}\n\theader = "%t"\n\tescape_filenames = yes');
    nas.getRadiusAccountingClient().startSession('al-ice x');
    expect(read(server, '/var/log/by/al--ice-20x')).toContain('Acct-Status-Type = Start');
  });

  it('without escaping, rad_filename_make_safe drops "../" after a slash', async () => {
    const { nas, server } = await lab('\tfilename = /var/log/by/%{User-Name}/detail\n\theader = "%t"');
    nas.getRadiusAccountingClient().startSession('a/../b');
    expect(read(server, '/var/log/by/a/b/detail')).toContain('Acct-Status-Type = Start');
  });

  it('an unknown suppressed attribute stops the reload with the module wording', async () => {
    const { reload } = await lab('\tfilename = /var/log/d\n\tsuppress {\n\t\tFoo-Bar\n\t}');
    expect(reload).toContain("/etc/freeradius/3.0/mods-enabled/detail[1]: No such attribute 'Foo-Bar'");
  });
});
