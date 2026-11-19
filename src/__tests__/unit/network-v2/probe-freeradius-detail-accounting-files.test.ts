/*
 * Probe: an Accounting-Request was journalled in memory and nothing reached disk. Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_detail/rlm_detail.c (detail_write: the header line, then one tab-indented "Attr = value" per attribute, then
 * "\tTimestamp = <seconds>" and a blank line; mod_accounting calls it in compat mode, so no Packet-Type line and no User-Password;
 * defaults: filename ${radacctdir}/%{Packet-Src-IP-Address}/detail-%Y%m%d, header "%t" (ctime), permissions 0600) and
 * raddb/mods-available/detail; dictionary.rfc2866 for the value names (Acct-Status-Type = Start, Acct-Terminate-Cause =
 * User-Request). radacctdir comes from radiusd.conf (${logdir}/radacct). Acct-Unique-Session-Id (the acct_unique module) is not
 * added: its key list and digest are not in the files read, said in TODO.md.
 *
 * Discriminated with git stash on src/network: 5 of 7 fall before the fix; two pass either way and are named: the witness (the
 * server answers the Accounting-Request, so the session reaches its journal in memory) and "a stopped daemon writes nothing"
 * (nothing was written for anything).
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

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

function lab() {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const server = new LinuxServer('linux-server', 'AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  server.getRadiusServer().setSharedSecret('shared');
  nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
  return { nas, server };
}

const DIR = '/var/log/freeradius/radacct/10.0.0.1';
const detailOf = async (server: LinuxServer) => {
  const name = (await server.executeCommand(`ls ${DIR}`)).trim().split(/\s+/).find((entry) => entry.startsWith('detail-')) ?? '';
  return { name, text: vfsOf(server).readFile(`${DIR}/${name}`) ?? '' };
};

describe('detail accounting files', () => {
  it('witness: the server journals the session in memory', () => {
    const { nas, server } = lab();
    nas.getRadiusAccountingClient().startSession('alice');
    expect(server.getRadiusServer().listAccountingSessions()).toHaveLength(1);
  });

  it('writes ${radacctdir}/<client address>/detail-<date> on a Start', async () => {
    const { nas, server } = lab();
    nas.getRadiusAccountingClient().startSession('alice');
    expect((await detailOf(server)).name).toMatch(/^detail-\d{8}$/);
  });

  it('the entry starts with a ctime header and carries the attributes in the radclient notation', async () => {
    const { nas, server } = lab();
    nas.getRadiusAccountingClient().startSession('alice');
    const { text } = await detailOf(server);
    expect(text.split('\n')[0]).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(text).toContain('\tUser-Name = "alice"');
    expect(text).toContain('\tAcct-Status-Type = Start');
    expect(text).toMatch(/\tAcct-Session-Id = "[^"]+"/);
  });

  it('ends the entry with Timestamp in seconds and a blank line, and writes no Packet-Type (compat mode)', async () => {
    const { nas, server } = lab();
    nas.getRadiusAccountingClient().startSession('alice');
    const { text } = await detailOf(server);
    expect(text).toMatch(/\tTimestamp = \d+\n\n$/);
    expect(text).not.toContain('Packet-Type');
  });

  it('appends one entry per Accounting-Request: Start then Stop with its cause', async () => {
    const { nas, server } = lab();
    const sessionId = nas.getRadiusAccountingClient().startSession('alice')!;
    nas.getRadiusAccountingClient().stopSession(sessionId, 'user-request');
    const { text } = await detailOf(server);
    expect(text.match(/\tAcct-Status-Type = /g)).toHaveLength(2);
    expect(text).toContain('\tAcct-Status-Type = Stop');
    expect(text).toContain('\tAcct-Terminate-Cause = User-Request');
  });

  it('the file is created with permissions 0600', async () => {
    const { nas, server } = lab();
    nas.getRadiusAccountingClient().startSession('alice');
    const { name } = await detailOf(server);
    expect(await server.executeCommand(`stat -c %a ${DIR}/${name}`)).toContain('600');
  });

  it('a stopped daemon writes nothing', async () => {
    const { nas, server } = lab();
    await server.executeCommand('systemctl stop freeradius');
    nas.getRadiusAccountingClient().startSession('alice');
    expect((await detailOf(server)).text).toBe('');
  });
});
