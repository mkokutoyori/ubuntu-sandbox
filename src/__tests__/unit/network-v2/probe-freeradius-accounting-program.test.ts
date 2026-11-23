/*
 * Probe: preacct and accounting were lists of module names, so the order of detail and radutmp and an update of the request had no
 * effect. Source of truth: FreeRADIUS v3.2.x src/main/auth.c rad_accounting (the preacct section, then the accounting section; a
 * reject or fail from preacct ends the request with no Accounting-Response), raddb/sites-available/default (preacct { preprocess
 * acct_unique ... }, accounting { detail ... radutmp ... }), raddb/policy.d/accounting (acct_unique runs in preacct and puts the
 * Acct-Unique-Session-Id into the request from the attributes it has at that moment), modcall.c (update request changes the list
 * the later modules read), rlm_detail (writes the request list as it is when it runs), rlm_radutmp (records the session from the
 * request list as it is when it runs). The modules read and write ONE request context per Accounting-Request.
 *
 * Discriminated with git stash on src: 6 of 9 fall before the fix; three pass either way and are named: the witness (the default site
 * writes the detail entry and records the session), the removal of detail and of acct_unique (a module left out of a section was
 * already not run) and the refusal of a construct the simulator lacks in session (foreach; refused before as after, the case moved from `update`, which session now runs).
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
const DIR = '/var/log/freeradius/radacct/10.0.0.1';
const acct = (status: string, session: string) => `printf 'User-Name = "alice"\\nAcct-Status-Type = ${status}\\nAcct-Session-Id = "${session}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 4\\nCalling-Station-Id = "original"\\n' | radclient -t 1 -r 1 10.0.0.2 acct shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const detailOf = async (target: LinuxServer): Promise<string> => {
  const name = (await target.executeCommand(`ls ${DIR} 2>/dev/null`)).trim().split(/\s+/).find((entry) => entry.startsWith('detail-')) ?? '';
  return name === '' ? '' : vfsOf(target).readFile(`${DIR}/${name}`) ?? '';
};
const inSection = (section: string, statements: string[], before: string) => (text: string) =>
  text.replace(new RegExp(`(\\t${section} \\{[\\s\\S]*?\\n)(\\t\\t${before}\\n)`), (_all, start: string, tail: string) => `${start}${statements.join('\n')}\n${tail}`);
const CHANGE = ['\t\tupdate request {', '\t\t\tCalling-Station-Id := "changed"', '\t\t}'];

async function labWith(edit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', 'alice Cleartext-Password := "wonderland"\n');
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

describe('the accounting programs', () => {
  it('witness: the default site writes the detail entry and records the session', async () => {
    const { client, target } = await labWith();
    expect(await client.executeCommand(acct('Start', 's1'))).toContain('Received Accounting-Response');
    expect(await detailOf(target)).toContain('Calling-Station-Id = "original"');
    expect(await target.executeCommand('radwho')).toContain('alice');
  });

  it('an update request before detail changes what detail writes; after detail it does not', async () => {
    const before = await labWith(inSection('accounting', CHANGE, 'detail'));
    await before.client.executeCommand(acct('Start', 's1'));
    expect(await detailOf(before.target)).toContain('Calling-Station-Id = "changed"');
    const after = await labWith(inSection('accounting', CHANGE, 'radutmp'));
    await after.client.executeCommand(acct('Start', 's1'));
    expect(await detailOf(after.target)).toContain('Calling-Station-Id = "original"');
  });

  it('an update request before radutmp changes the caller id the session records', async () => {
    const { client, target } = await labWith(inSection('accounting', CHANGE, 'radutmp'));
    await client.executeCommand(acct('Start', 's1'));
    expect(await target.executeCommand('radwho -c')).toContain('changed');
  });

  it('an if on the status type adds an attribute for a Start only', async () => {
    const statements = ['\t\tif (&Acct-Status-Type == Start) {', '\t\t\tupdate request {', '\t\t\t\tFilter-Id := "started"', '\t\t\t}', '\t\t}'];
    const { client, target } = await labWith(inSection('accounting', statements, 'detail'));
    await client.executeCommand(acct('Start', 's1'));
    await client.executeCommand(acct('Stop', 's1'));
    const text = await detailOf(target);
    const entries = text.split('\n\n').filter((entry) => entry.includes('Acct-Session-Id'));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('Filter-Id = "started"');
    expect(entries[1]).not.toContain('Filter-Id');
  });

  it('an update request in preacct is what the accounting section reads', async () => {
    const { client, target } = await labWith(inSection('preacct', CHANGE, 'acct_unique'));
    await client.executeCommand(acct('Start', 's1'));
    expect(await detailOf(target)).toContain('Calling-Station-Id = "changed"');
  });

  it('acct_unique takes the attributes the request has when it runs: the id depends on the order with an update of User-Name', async () => {
    const rename = ['\t\tupdate request {', '\t\t\tUser-Name := "other"', '\t\t}'];
    const idOf = async (edit: (text: string) => string) => {
      const made = await labWith(edit);
      await made.client.executeCommand(acct('Start', 's1'));
      return /Acct-Unique-Session-Id = "([0-9a-f]+)"/.exec(await detailOf(made.target))?.[1] ?? '';
    };
    const plain = await idOf((text) => text);
    const before = await idOf(inSection('preacct', rename, 'acct_unique'));
    const after = await idOf((text) => text.replace('\t\tacct_unique\n', `\t\tacct_unique\n${rename.join('\n')}\n`));
    expect(plain).toMatch(/^[0-9a-f]{32}$/);
    expect(after).toBe(plain);
    expect(before).not.toBe(plain);
  });

  it('reject in preacct ends the request: no detail entry, no session, no Accounting-Response', async () => {
    const { client, target } = await labWith((text) => text.replace('\t\tacct_unique\n', '\t\tacct_unique\n\t\treject\n'));
    expect(await client.executeCommand(acct('Start', 's1'))).toContain('No reply from server');
    expect(await detailOf(target)).toBe('');
    expect(await target.executeCommand('radwho')).not.toContain('alice');
  });

  it('without detail in accounting nothing is written, with acct_unique out of preacct the entry has no unique id', async () => {
    const noDetail = await labWith((text) => text.replace('\t\tdetail\n', ''));
    await noDetail.client.executeCommand(acct('Start', 's1'));
    expect(await detailOf(noDetail.target)).toBe('');
    const noUnique = await labWith((text) => text.replace('\t\tacct_unique\n', ''));
    await noUnique.client.executeCommand(acct('Start', 's1'));
    expect(await detailOf(noUnique.target)).not.toContain('Acct-Unique-Session-Id');
  });

  it('an unlang construct the simulator lacks is still refused naming it, in session as in authenticate', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('\tsession {\n', '\tsession {\n\t\tforeach &Reply-Message {\n\t\t}\n'));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/The unlang construct "foreach" is not implemented in this simulator$/);
  });
});
