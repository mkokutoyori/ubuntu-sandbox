/*
 * Probe — PowerShell cmdlets that resolve a name wait for a recursive DNS server's reply.
 *
 * Measured first (Windows client whose only DNS server is a BIND resolver that recurses root -> corp.test, a
 * name never resolved before on the client):
 * - Resolve-DnsName (default, -Type A, -Type MX, -Server), Test-NetConnection, Test-Connection and
 *   Invoke-WebRequest all failed: "DNS name does not exist", an empty RemoteAddress, "The remote name could
 *   not be resolved". nslookup, ping and dig on the same machine at the same second resolved the name. The
 *   cmdlets asked the server through the synchronous client query, which only sees a reply produced before the
 *   datagram call returns; a recursive server answers from a promise, so the reply landed on a socket the
 *   client had already closed. A name looked up by ping a moment earlier made the cmdlet work, hiding the
 *   defect from every test that primed the cache first.
 * The PowerShell runtime now hands the synchronous query a way to wait: the statement is replayed after the
 * runner awaited the real asynchronous query, exactly as a native command already is. Replaying runs the
 * statement again from its start, so the wait is only taken while nothing in the current pass has changed the
 * machine (every cmdlet other than the read-only verbs marks the pass); otherwise the synchronous query answers
 * as before. A try block and -ErrorAction SilentlyContinue/Ignore let the wait through; they still catch every
 * other error, including a command that does not exist.
 *
 * Discrimination (the probe run on the tree before the change): 12 of the 16 cases fall. Four pass either way:
 *  - "answers from an authoritative server on the synchronous path" — NON-REGRESSION: a server that replies
 *    before the datagram call returns never needed the wait.
 *  - "sends one datagram for one question" — STRUCTURAL: the synchronous path also sent a single datagram;
 *    the case guards the replay against asking the server twice.
 *  - "runs a statement that changes the machine once" — NON-REGRESSION: with no replay there was nothing to
 *    repeat; it guards the replay against running Add-Content again.
 *  - "still lets a try block catch a command that does not exist" — NON-REGRESSION: an early version of the
 *    change let every pending step through a try block and broke 17 existing cases that catch Get-Zork.
 * "still reports a name that does not exist" falls before only through its first assertion, the positive
 * control of the lab; its second assertion (the refusal) holds on both sides.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ROOT_IP = '10.0.0.1';
const CORP_IP = '10.0.0.20';
const RESOLVER_IP = '10.0.0.53';
const WIN_IP = '10.0.0.100';

const ROOT_ZONE = [
  '$TTL 3600',
  '. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 1 3600 900 604800 300 )',
  '. IN NS a.root-servers.net.',
  `a.root-servers.net. IN A ${ROOT_IP}`,
  'corp.test. IN NS ns.corp.test.',
  `ns.corp.test. IN A ${CORP_IP}`,
  '',
].join('\n');

const CORP_ZONE = [
  '$TTL 3600',
  '$ORIGIN corp.test.',
  '@ IN SOA ns.corp.test. hostmaster.corp.test. ( 1 3600 900 604800 300 )',
  '@ IN NS ns.corp.test.',
  `ns IN A ${CORP_IP}`,
  `web IN A ${CORP_IP}`,
  'alias IN CNAME web',
  '@ IN MX 10 mail',
  'mail IN A 10.0.0.25',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `t${n} IN A ${CORP_IP}`),
  '',
].join('\n');

const vfsOf = (server: LinuxServer): VirtualFileSystem =>
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

const put = (server: LinuxServer, path: string, content: string): void => {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
};

const namedConf = (zones: string, recursion: boolean): string =>
  `options { directory "/var/cache/bind"; recursion ${recursion ? 'yes' : 'no'}; allow-recursion { any; }; dnssec-validation no; };\n${zones}\n`;

async function lab(options: { dnsServer?: string; web?: boolean } = {}) {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const root = new LinuxServer('linux-server', 'ROOT');
  const corp = new LinuxServer('linux-server', 'CORP');
  const resolver = new LinuxServer('linux-server', 'RESOLVER');
  const win = new WindowsPC('windows-pc', 'WIN');
  win.powerOn();
  win.setCurrentUser('Administrator');
  const mask = new SubnetMask('255.255.255.0');
  const addresses = [ROOT_IP, CORP_IP, RESOLVER_IP, WIN_IP];
  [root, corp, resolver, win].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(addresses[index]), mask);
  });

  put(root, '/etc/bind/named.conf', namedConf('zone "." { type primary; file "/etc/bind/db.root"; };', false));
  put(root, '/etc/bind/db.root', ROOT_ZONE);
  await root.executeCommand('systemctl start named');

  put(corp, '/etc/bind/named.conf', namedConf('zone "corp.test" { type primary; file "/etc/bind/db.corp"; };', false));
  put(corp, '/etc/bind/db.corp', CORP_ZONE);
  await corp.executeCommand('systemctl start named');
  if (options.web) {
    await corp.executeCommand('apt install -y nginx');
    await corp.executeCommand('systemctl start nginx');
  }

  put(resolver, '/etc/bind/named.conf', namedConf('zone "." { type hint; file "/etc/bind/db.hints"; };', true));
  put(resolver, '/etc/bind/db.hints', `. 3600000 IN NS a.root-servers.net.\na.root-servers.net. 3600000 IN A ${ROOT_IP}\n`);
  await resolver.executeCommand('systemctl start named');

  const shell = PowerShellSubShell.create(win).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  await ps(`Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${options.dnsServer ?? RESOLVER_IP}`);
  return { win, corp, resolver, ps };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('PowerShell name resolution through a recursive server', () => {
  it('Resolve-DnsName resolves a name that needs recursion', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName t1.corp.test')).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
  });

  it('Resolve-DnsName -Type A resolves it too', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName t2.corp.test -Type A')).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
  });

  it('Resolve-DnsName -Type MX reads the mail exchanger through the resolver', async () => {
    const { ps } = await lab();
    const out = await ps('Resolve-DnsName corp.test -Type MX');
    expect(out).toMatch(/NameExchange\s*:\s*mail\.corp\.test/);
    expect(out).toMatch(/Preference\s*:\s*10/);
  });

  it('Resolve-DnsName -Server asks the named resolver', async () => {
    const { ps } = await lab();
    expect(await ps(`Resolve-DnsName t3.corp.test -Server ${RESOLVER_IP}`)).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
  });

  it('resolves through the cmd entry point powershell -Command as well', async () => {
    const { win } = await lab();
    const out = await win.executeCommand('powershell -Command "Resolve-DnsName t4.corp.test"');
    expect(out).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
  });

  it('Test-NetConnection fills RemoteAddress and the ping succeeds', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection t5.corp.test');
    expect(out).toMatch(/RemoteAddress\s*:\s*10\.0\.0\.20/);
    expect(out).toMatch(/PingSucceeded\s*:\s*True/);
  });

  it('Test-Connection reaches the host behind the name', async () => {
    const { ps } = await lab();
    const out = await ps('Test-Connection t6.corp.test -Count 1');
    expect(out).toMatch(/IPV4Address\s*:\s*10\.0\.0\.20/);
    expect(out).toMatch(/Status\s*:\s*Success/);
  });

  it('Invoke-WebRequest fetches a page from a host named through the resolver', async () => {
    const { ps } = await lab({ web: true });
    const out = await ps('(Invoke-WebRequest http://web.corp.test).StatusCode');
    expect(out.trim()).toBe('200');
  });

  it('resolves every name of a loop inside one statement', async () => {
    const { ps } = await lab();
    const out = await ps("foreach ($n in 't1','t2','t3') { (Resolve-DnsName \"$n.corp.test\").IPAddress }");
    expect(out.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual([CORP_IP, CORP_IP, CORP_IP]);
  });

  it('lets the wait cross a try block', async () => {
    const { ps } = await lab();
    const out = await ps("try { (Resolve-DnsName t7.corp.test).IPAddress } catch { 'caught' }");
    expect(out.trim()).toBe(CORP_IP);
  });

  it('ipconfig /displaydns lists the name the cmdlet resolved', async () => {
    const { ps, win } = await lab();
    await ps('Resolve-DnsName t8.corp.test');
    expect(await win.executeCommand('ipconfig /displaydns')).toMatch(/Record Name[ .]*: t8\.corp\.test/);
  });

  it('sends one datagram for one question, with no stray frame from a closed socket', async () => {
    const { ps, win } = await lab();
    await ps('Resolve-DnsName t1.corp.test');
    await win.executeCommand(`ping -n 1 ${RESOLVER_IP}`);
    const port = win.getPorts()[0];
    const before = port.getCounters().framesOut;
    await ps('Resolve-DnsName t2.corp.test');
    expect(port.getCounters().framesOut - before).toBe(1);
  });

  it('runs a statement that changes the machine once, even when it also resolves a name', async () => {
    const { ps } = await lab();
    await ps("function Add-Line { Add-Content C:\\ledger.txt 'ligne'; Resolve-DnsName t1.corp.test | Out-Null }");
    await ps('Add-Line');
    expect((await ps("(Get-Content C:\\ledger.txt) -join '|'")).trim()).toBe('ligne');
  });

  it('still lets a try block catch a command that does not exist', async () => {
    const { ps } = await lab();
    expect((await ps("try { Get-Zork } catch { 'caught' }")).trim()).toBe('caught');
  });

  it('answers from an authoritative server on the synchronous path', async () => {
    const { ps } = await lab({ dnsServer: CORP_IP });
    expect(await ps('Resolve-DnsName web.corp.test')).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
  });

  it('still reports a name that does not exist', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName t1.corp.test')).toMatch(/IPAddress\s*:\s*10\.0\.0\.20/);
    expect(await ps('Resolve-DnsName nothere.corp.test')).toContain('DNS name does not exist');
  });
});
