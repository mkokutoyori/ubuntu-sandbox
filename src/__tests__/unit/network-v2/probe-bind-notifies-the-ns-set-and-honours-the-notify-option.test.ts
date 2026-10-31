/*
 * Probe — a BIND primary notifies the servers of its NS set, and the `notify` family of options decides who.
 *
 * Measured first (BIND 9.18 primary for lab.test, NS ns1 (itself, the SOA MNAME) + ns2 + ns3, no also-notify):
 * after `rndc reload` with a higher serial the secondaries kept the old serial — the engine sent NOTIFY only to
 * the addresses written in `also-notify`. The BIND 9 reference manual says the opposite: `notify yes` (the
 * default) sends NOTIFY to the servers of the zone's NS RRset except the one named in the SOA MNAME, and to
 * the also-notify addresses; `explicit` sends only to also-notify; `no` sends none; `notify-to-soa yes` stops
 * excluding the MNAME (the manual's wording is read through the bind-users thread "NS also in SOA doesn't
 * get NOTIFY", 2011-10, and the DISA STIG finding V-72411, which quote it; the manual page itself could not
 * be fetched whole). And `notify`, `notify-to-soa` and a zone-level
 * `allow-query` were refused by the parser as "unknown option", although BIND accepts them in primary and
 * secondary zones and refuses them in hint and forward zones ("option 'x' is not allowed in 'hint' zone 'y'").
 * A lab with two NS records and no also-notify therefore never replicated until a refresh timer.
 *
 * Discrimination (git stash of NamedConfig.ts and Bind9Service.ts): 10 of the 12 cases fall before the change.
 * Two pass either way:
 *  - "transfers the zone to a new secondary at startup" — WITNESS: the lab itself is sound, so a stale serial
 *    accuses the notification and not the transfer.
 *  - "notifies the also-notify addresses when nothing else is configured" — NON-REGRESSION: the one path that
 *    already worked must keep working.
 * The negative cases (notify no, notify explicit, the SOA primary excluded) carry a positive control inside
 * the same lab — a server that MUST be notified and is waited for — so that "stayed at serial 1" is read only
 * after a notification had the time to arrive, not as the mere absence of an answer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const PRIMARY_IP = '10.0.0.1';
const SECOND_IP = '10.0.0.2';
const WINDOWS_IP = '10.0.0.3';
const PC_IP = '10.0.0.100';

function zoneFile(serial: number, mname = 'ns1.lab.test.'): string {
  return [
    '$TTL 3600',
    `@ IN SOA ${mname} hostmaster.lab.test. ( ${serial} 7200 900 1209600 3600 )`,
    '  IN NS ns1.lab.test.',
    '  IN NS ns2.lab.test.',
    '  IN NS ns3.lab.test.',
    `ns1 IN A ${PRIMARY_IP}`,
    `ns2 IN A ${SECOND_IP}`,
    `ns3 IN A ${WINDOWS_IP}`,
    'www IN A 10.0.0.80',
    '',
  ].join('\n');
}

function primaryConf(zoneOptions: string, globalOptions = ''): string {
  return [
    `options { directory "/var/cache/bind"; recursion no; allow-query { any; }; ${globalOptions} };`,
    `zone "lab.test" { type primary; file "/etc/bind/db.lab.test"; ${zoneOptions} };`,
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function put(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

const powershell = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

interface Lab {
  readonly primary: LinuxServer;
  readonly second: LinuxServer;
  readonly windows: WindowsServer;
  readonly pc: LinuxPC;
}

async function buildLab(zoneOptions: string, globalOptions = '', mname = 'ns1.lab.test.'): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const primary = new LinuxServer('linux-server', 'PRIMARY');
  const second = new LinuxServer('linux-server', 'SECOND');
  const windows = new WindowsServer('WIN');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.255.0');
  [primary, second, windows, pc].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([PRIMARY_IP, SECOND_IP, WINDOWS_IP, PC_IP][index]), mask);
  });

  put(primary, '/etc/bind/named.conf', primaryConf(zoneOptions, globalOptions));
  put(primary, '/etc/bind/db.lab.test', zoneFile(1, mname));
  await primary.executeCommand('systemctl start named');

  put(second, '/etc/bind/named.conf', [
    'options { directory "/var/cache/bind"; recursion no; allow-query { any; }; };',
    `zone "lab.test" { type secondary; primaries { ${PRIMARY_IP}; }; file "/var/cache/bind/db.lab.test"; };`,
    '',
  ].join('\n'));
  await second.executeCommand('systemctl start named');

  windows.setCurrentUser('Administrator');
  await powershell(windows, 'Install-WindowsFeature DNS');
  await powershell(windows, `Add-DnsServerSecondaryZone -Name lab.test -ZoneFile lab.test.dns -MasterServers ${PRIMARY_IP}`);
  return { primary, second, windows, pc };
}

async function publishSerial(lab: Lab, serial: number, mname = 'ns1.lab.test.'): Promise<void> {
  put(lab.primary, '/etc/bind/db.lab.test', zoneFile(serial, mname));
  await lab.primary.executeCommand('rndc reload lab.test');
}

async function serialAt(lab: Lab, server: string): Promise<number> {
  const out = await lab.pc.executeCommand(`dig @${server} lab.test SOA +norecurse`);
  return Number(out.match(/SOA\s+\S+\s+\S+\s+(\d+)\s/)?.[1] ?? NaN);
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reachesSerial(lab: Lab, server: string, serial: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serialAt(lab, server) === serial) return true;
    await pause(100);
  }
  return false;
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('a BIND primary notifies the servers of its NS set', () => {
  it('transfers the zone to a new secondary at startup', async () => {
    const lab = await buildLab('');
    expect(await serialAt(lab, SECOND_IP)).toBe(1);
  });

  it('notifies the servers of the NS set by default, without any also-notify', async () => {
    const lab = await buildLab('');
    await publishSerial(lab, 2);
    expect(await reachesSerial(lab, SECOND_IP, 2)).toBe(true);
  });

  it('notifies a Windows DNS secondary that appears in the NS set', async () => {
    const lab = await buildLab('');
    await publishSerial(lab, 2);
    expect(await reachesSerial(lab, WINDOWS_IP, 2)).toBe(true);
  });

  it('notifies the also-notify addresses when nothing else is configured', async () => {
    const lab = await buildLab(`also-notify { ${SECOND_IP}; };`);
    await publishSerial(lab, 2);
    expect(await reachesSerial(lab, SECOND_IP, 2)).toBe(true);
  });

  it('sends nothing with notify no in the zone', async () => {
    const lab = await buildLab('notify no; also-notify { 10.0.0.2; };');
    expect(await lab.primary.executeCommand('named-checkconf')).toBe('');
    await publishSerial(lab, 2);
    await pause(1500);
    expect(await serialAt(lab, SECOND_IP)).toBe(1);
    expect(await serialAt(lab, WINDOWS_IP)).toBe(1);
  });

  it('sends only to also-notify with notify explicit', async () => {
    const lab = await buildLab('notify explicit; also-notify { 10.0.0.3; };');
    expect(await lab.primary.executeCommand('named-checkconf')).toBe('');
    await publishSerial(lab, 2);
    expect(await reachesSerial(lab, WINDOWS_IP, 2)).toBe(true);
    expect(await serialAt(lab, SECOND_IP)).toBe(1);
  });

  it('lets the zone notify override the options notify', async () => {
    const lab = await buildLab('notify yes;', 'notify no;');
    expect(await lab.primary.executeCommand('named-checkconf')).toBe('');
    await publishSerial(lab, 2);
    expect(await reachesSerial(lab, SECOND_IP, 2)).toBe(true);
  });

  it('does not notify the SOA primary name server unless notify-to-soa is on', async () => {
    const withoutOption = await buildLab('', '', 'ns2.lab.test.');
    await publishSerial(withoutOption, 2, 'ns2.lab.test.');
    expect(await reachesSerial(withoutOption, WINDOWS_IP, 2)).toBe(true);
    expect(await serialAt(withoutOption, SECOND_IP)).toBe(1);
  });

  it('notifies the SOA primary name server with notify-to-soa yes', async () => {
    const lab = await buildLab('notify-to-soa yes;', '', 'ns2.lab.test.');
    expect(await lab.primary.executeCommand('named-checkconf')).toBe('');
    await publishSerial(lab, 2, 'ns2.lab.test.');
    expect(await reachesSerial(lab, SECOND_IP, 2)).toBe(true);
  });

  it('refuses a query to a zone whose allow-query excludes the client, and only that zone', async () => {
    const lab = await buildLab('allow-query { 10.0.9.9; };');
    put(lab.primary, '/etc/bind/named.conf', [
      primaryConf('allow-query { 10.0.9.9; };'),
      'zone "open.test" { type primary; file "/etc/bind/db.open.test"; };',
      '',
    ].join('\n'));
    put(lab.primary, '/etc/bind/db.open.test', zoneFile(1).replace(/lab\.test/g, 'open.test'));
    await lab.primary.executeCommand('systemctl restart named');
    expect(await lab.primary.executeCommand('named-checkconf')).toBe('');
    const refused = await lab.pc.executeCommand(`dig @${PRIMARY_IP} www.lab.test A +norecurse`);
    expect(refused).toContain('status: REFUSED');
    const open = await lab.pc.executeCommand(`dig @${PRIMARY_IP} www.open.test A +norecurse`);
    expect(open).toMatch(/www\.open\.test\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80/);
  });

  it('answers queries for a zone whose allow-query admits the client', async () => {
    const lab = await buildLab(`allow-query { ${PC_IP}; };`);
    const answered = await lab.pc.executeCommand(`dig @${PRIMARY_IP} www.lab.test A +norecurse`);
    expect(answered).toMatch(/www\.lab\.test\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80/);
  });

  it('refuses notify in a hint zone with the manual wording', async () => {
    const lab = await buildLab('');
    put(lab.primary, '/etc/bind/named.conf', 'zone "." { type hint; file "/etc/bind/db.hints"; notify no; };\n');
    expect(await lab.primary.executeCommand('named-checkconf')).toContain("option 'notify' is not allowed in 'hint' zone '.'");
  });
});
