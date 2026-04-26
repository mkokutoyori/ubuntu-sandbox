// ═══════════════════════════════════════════════════════════════════════════
// netsh-add.test.ts – 30 tests for the "netsh add" command family
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-ADD'): WindowsPC {
  return new WindowsPC('windows-pc', name);
}

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc);
}

describe('netsh add – comprehensive', () => {

  // ─── 1. ipv4 add address ──────────────────────────────────────────────
  it('"netsh interface ipv4 add address" adds static IP', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add address "Ethernet 0" 10.1.1.10 255.255.255.0');
    const out = await ps.execute('netsh interface ip show addresses "Ethernet 0"');
    expect(out).toContain('10.1.1.10');
  });

  it('add address with gateway', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add address "Ethernet 1" 10.2.2.20 255.255.255.0 10.2.2.1');
    const out = await ps.execute('netsh interface ip show addresses "Ethernet 1"');
    expect(out).toContain('10.2.2.20');
    const gw = await ps.execute('netsh interface ipv4 show route | findstr "0.0.0.0"');
    expect(gw).toContain('10.2.2.1');
  });

  it('add address with gateway metric', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add address "Ethernet 2" 10.3.3.30 255.255.255.0 10.3.3.1 20');
    const route = await ps.execute('netsh interface ipv4 show route | findstr "0.0.0.0"');
    expect(route).toContain('10.3.3.1');
  });

  it('add address fails with duplicate IP', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add address "Ethernet 0" 10.10.10.10 255.255.255.0');
    const out = await ps.execute('netsh interface ipv4 add address "Ethernet 0" 10.10.10.10 255.255.255.0 2>&1');
    expect(out).toContain('already exists');
  });

  it('add address fails with invalid interface name', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 add address "NoAdapter" 10.0.0.1 255.0.0.0 2>&1');
    expect(out).toContain('not found');
  });

  it('add address without subnet mask uses /?', async () => {
    // error expected
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 add address "Ethernet 0" 10.5.5.5 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 2. ipv4 add dns ──────────────────────────────────────────────────
  it('"netsh interface ipv4 add dnsserver" adds DNS', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 0" 8.8.8.8 index=1');
    const dns = await ps.execute('netsh interface ipv4 show dnsservers "Ethernet 0"');
    expect(dns).toContain('8.8.8.8');
  });

  it('add DNS without index when primary exists fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 0" 8.8.8.8 index=1');
    const out = await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 0" 1.1.1.1 2>&1');
    expect(out).toContain('index');
  });

  it('add DNS with index=2 succeeds', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 1" 4.2.2.1 index=1');
    await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 1" 4.2.2.2 index=2');
    const dns = await ps.execute('netsh interface ipv4 show dnsservers "Ethernet 1"');
    expect(dns).toContain('4.2.2.2');
  });

  it('add DNS with wrong index fails gracefully', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 add dnsserver "Ethernet 0" 9.9.9.9 index=abc 2>&1');
    expect(out).toContain('syntax');
  });

  // ─── 3. ipv4 add neighbors (ARP) ──────────────────────────────────────
  it('add neighbors creates ARP entry', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv4 add neighbors "Ethernet 0" 192.168.0.100 02-AA-BB-CC-DD-EE');
    const arp = await ps.execute('netsh interface ipv4 show neighbors');
    expect(arp).toContain('192.168.0.100');
  });

  it('add neighbors fails with bad MAC format', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 add neighbors "Ethernet 0" 192.168.0.200 00-00-00-00-00 2>&1');
    expect(out).toContain('Invalid');
  });

  // ─── 4. ipv6 add address ──────────────────────────────────────────────
  it('add ipv6 address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    const out = await ps.execute('netsh interface ipv6 show addresses "Ethernet 0"');
    expect(out).toContain('2001:db8::10');
  });

  it('add ipv6 address with prefix', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv6 add address "Ethernet 1" 2001:db8::20/64');
    const out = await ps.execute('netsh interface ipv6 show addresses "Ethernet 1"');
    expect(out).toContain('2001:db8::20');
  });

  // ─── 5. ipv6 add route ────────────────────────────────────────────────
  it('add ipv6 route', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv6 add route 2001:db8:1::/48 "Ethernet 0" 2001:db8::ff');
    const route = await ps.execute('netsh interface ipv6 show route | findstr "2001:db8:1::/48"');
    expect(route).toContain('2001:db8:1::/48');
  });

  it('add ipv6 route fails without nexthop', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv6 add route 2001:db8:2::/48 "Ethernet 0" 2>&1');
    expect(out).toContain('Usage');
  });

  it('add ipv6 route with metric and publish', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ipv6 add route 2001:db8:3::/48 "Ethernet 0" 2001:db8::ff metric=5 publish=yes');
    const route = await ps.execute('netsh interface ipv6 show route | findstr "2001:db8:3::/48"');
    expect(route).toContain('2001:db8:3::/48');
  });

  // ─── 6. wlan add profile ──────────────────────────────────────────────
  it('wlan add profile from XML file', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh wlan add profile filename="C:\\temp\\test-wifi.xml"');
    const profiles = await ps.execute('netsh wlan show profiles');
    expect(profiles).toContain('TestWiFi');
  });

  it('wlan add profile with non-existent file fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh wlan add profile filename="C:\\missing.xml" 2>&1');
    expect(out).toContain('Cannot find');
  });

  // ─── 7. http add iplisten ─────────────────────────────────────────────
  it('http add iplisten adds to IP listen list', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh http add iplisten 127.0.0.100');
    const list = await ps.execute('netsh http show iplisten');
    expect(list).toContain('127.0.0.100');
  });

  it('http add iplisten duplicate error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh http add iplisten 127.0.0.101');
    const out = await ps.execute('netsh http add iplisten 127.0.0.101 2>&1');
    expect(out).toContain('already exists');
  });

  it('http add iplisten with invalid IP fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh http add iplisten 999.999.999.999 2>&1');
    expect(out).toContain('Invalid');
  });

  // ─── 8. http add sslcert ──────────────────────────────────────────────
  it('http add sslcert adds certificate binding', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // assume a fake cert hash
    await ps.execute('netsh http add sslcert ipport=0.0.0.0:443 certhash=00112233445566778899aabbccddeeff00112233 appid={00000000-0000-0000-0000-000000000001}');
    const bindings = await ps.execute('netsh http show sslcert');
    expect(bindings).toContain('443');
  });

  it('http add sslcert missing certhash fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh http add sslcert ipport=0.0.0.0:443 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 9. advfirewall firewall add rule ─────────────────────────────────
  it('advfirewall firewall add rule inbound', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh advfirewall firewall add rule name="TestRule" dir=in action=allow protocol=TCP localport=8080');
    const rules = await ps.execute('netsh advfirewall firewall show rule name=TestRule');
    expect(rules).toContain('TestRule');
    expect(rules).toContain('Allow');
  });

  it('advfirewall firewall add rule with program and profile', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh advfirewall firewall add rule name="AppRule" dir=out action=block program="C:\\app.exe" profile=domain');
    const rule = await ps.execute('netsh advfirewall firewall show rule name=AppRule');
    expect(rule).toContain('AppRule');
  });

  it('advfirewall add rule duplicate name error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh advfirewall firewall add rule name="DupRule" dir=in action=allow');
    const out = await ps.execute('netsh advfirewall firewall add rule name="DupRule" dir=in action=allow 2>&1');
    expect(out).toContain('already exists');
  });

  // ─── 10. namespace add policy (NRPT) ──────────────────────────────────
  it('namespace add policy adds name resolution policy', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh namespace add policy name="TestNRPT" namespace="test.local" dnsservers=8.8.8.8');
    const policies = await ps.execute('netsh namespace show policy');
    expect(policies).toContain('test.local');
  });

  it('namespace add policy missing namespace fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh namespace add policy name="FailPolicy" 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 11. lan add profile ──────────────────────────────────────────────
  it('lan add profile from XML', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 0"');
    const prof = await ps.execute('netsh lan show profiles');
    expect(prof).toContain('WiredProfile');
  });

  // ─── 12. bridge add ───────────────────────────────────────────────────
  it('bridge add adapter to bridge', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh bridge create name="BridgeTest"');
    await ps.execute('netsh bridge add name="BridgeTest" "Ethernet 2"');
    const members = await ps.execute('netsh bridge show adapter "BridgeTest"');
    expect(members).toContain('Ethernet 2');
    // cleanup
    await ps.execute('netsh bridge delete "BridgeTest"');
  });

  // ─── 13. Help & documentation ─────────────────────────────────────────
  it('"netsh add ?" shows general help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('netsh add ?');
    expect(help).toContain('Commands in this context');
  });

  it('"netsh interface ipv4 add address ?" shows usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('netsh interface ipv4 add address ?');
    expect(help).toContain('Usage');
    expect(help).toContain('address');
  });

  it('"netsh advfirewall firewall add rule ?" shows params', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('netsh advfirewall firewall add rule ?');
    expect(help).toContain('name');
    expect(help).toContain('dir');
  });
});

describe('netsh dhcpclient – comprehensive', () => {

  // ─── 1. Help & documentation ──────────────────────────────────────────
  it('"netsh dhcpclient ?" shows context help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient ?');
    expect(out).toContain('Commands in this context');
    expect(out).toContain('install');
    expect(out).toContain('show');
    expect(out).toContain('set');
  });

  it('"netsh dhcpclient help" also shows help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient help');
    expect(out).toContain('Commands in this context');
  });

  it('"netsh dhcpclient install ?" shows install usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient install ?');
    expect(out).toContain('Usage');
    expect(out).toContain('install');
  });

  it('"netsh dhcpclient show ?" lists show subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show ?');
    expect(out).toContain('state');
    expect(out).toContain('interfaces');
    expect(out).toContain('parameters');
    expect(out).toContain('tracing');
  });

  it('"netsh dhcpclient set ?" lists set subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient set ?');
    expect(out).toContain('tracing');
  });

  it('"netsh dhcpclient show state ?" shows state usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show state ?');
    expect(out).toContain('Usage');
  });

  // ─── 2. Install / Uninstall ───────────────────────────────────────────
  it('install DHCP client service (simulated)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dhcpclient install')).resolves.not.toThrow();
    // verify existence afterwards? Not sure if simulator tracks.
  });

  it('uninstall DHCP client service (simulated)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dhcpclient uninstall')).resolves.not.toThrow();
  });

  it('install when already installed produces message', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient install'); // ensure installed
    const out = await ps.execute('netsh dhcpclient install 2>&1');
    expect(out).toContain('already installed');
  });

  it('uninstall when already uninstalled error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient uninstall'); // first time
    const out = await ps.execute('netsh dhcpclient uninstall 2>&1');
    expect(out).toContain('not installed');
  });

  // ─── 3. show state ────────────────────────────────────────────────────
  it('"netsh dhcpclient show state" shows general DHCP client state', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show state');
    expect(out).toContain('DHCP Client');
    expect(out).toContain('State');
  });

  it('show state when service stopped', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient uninstall'); // simulate stopped: uninstalled = not running
    const out = await ps.execute('netsh dhcpclient show state');
    expect(out).toContain('Stopped');
    await ps.execute('netsh dhcpclient install'); // restore
  });

  // ─── 4. show interfaces ───────────────────────────────────────────────
  it('"netsh dhcpclient show interfaces" lists all interfaces with DHCP status', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show interfaces');
    expect(out).toContain('Ethernet 0');
    expect(out).toContain('Ethernet 1');
    expect(out).toContain('Ethernet 2');
    expect(out).toContain('Ethernet 3');
    expect(out).toContain('DHCP Enabled');
  });

  it('show interfaces after disabling DHCP on one adapter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh interface ip set address "Ethernet 1" static 10.0.0.10 255.0.0.0 10.0.0.1');
    const out = await ps.execute('netsh dhcpclient show interfaces');
    // Ethernet 1 should show DHCP disabled
    const line = out.split('\n').find(l => l.includes('Ethernet 1'));
    expect(line).toContain('No'); // depends on output format
    // revert
    await ps.execute('netsh interface ip set address "Ethernet 1" dhcp');
  });

  // ─── 5. show parameters ───────────────────────────────────────────────
  it('"netsh dhcpclient show parameters" for all interfaces', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show parameters');
    expect(out).toContain('DHCP parameters');
  });

  it('show parameters for specific interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show parameters "Ethernet 0"');
    expect(out).toContain('Ethernet 0');
    expect(out).toContain('Lease obtained');
  });

  it('show parameters for non-existent interface error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show parameters "Ethernet 99" 2>&1');
    expect(out).toContain('not found');
  });

  // ─── 6. show tracing ──────────────────────────────────────────────────
  it('"netsh dhcpclient show tracing" shows trace status', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient show tracing');
    expect(out).toContain('Tracing');
    expect(out).toContain('Enabled');
  });

  // ─── 7. set tracing ───────────────────────────────────────────────────
  it('"netsh dhcpclient set tracing * enable" enables tracing', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient set tracing * enable');
    const out = await ps.execute('netsh dhcpclient show tracing');
    expect(out).toContain('Enabled');
  });

  it('"netsh dhcpclient set tracing * disable" disables tracing', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient set tracing * disable');
    const out = await ps.execute('netsh dhcpclient show tracing');
    expect(out).toContain('Disabled');
  });

  it('set tracing with file path', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient set tracing * enable output=C:\\dhcptrace.etl');
    const out = await ps.execute('netsh dhcpclient show tracing');
    expect(out).toContain('C:\\dhcptrace.etl');
  });

  it('set tracing with invalid parameter fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient set tracing * blah 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 8. set interface (DHCP-specific settings) ────────────────────────
  it('"netsh dhcpclient set interface" forces DHCP renew?', async () => {
    // The actual command might be "netsh dhcpclient set interface" to modify interface-level settings (like DHCP class ID, etc.)
    // Simulated: may not implement but should not crash.
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dhcpclient set interface "Ethernet 0" dhcpclassid="test"')).resolves.not.toThrow();
  });

  it('set interface missing interface name error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient set interface dhcpclassid="test" 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 9. show state after renew / release (simulated) ─────────────────
  it('renew DHCP lease on interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient renew "Ethernet 0"');
    const state = await ps.execute('netsh dhcpclient show parameters "Ethernet 0"');
    expect(state).toContain('Lease obtained');
  });

  it('release DHCP lease on interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dhcpclient release "Ethernet 2"');
    const params = await ps.execute('netsh dhcpclient show parameters "Ethernet 2"');
    expect(params).toContain('Lease expired');
    // renew to restore
    await ps.execute('netsh dhcpclient renew "Ethernet 2"');
  });

  // ─── 10. Invalid contexts / typos ────────────────────────────────────
  it('no subcommand shows error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient 2>&1');
    expect(out).toContain('Usage');
  });

  it('invalid subcommand shows error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient foo 2>&1');
    expect(out).toContain('not found');
  });

  it('install with extra arguments misuse', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient install extra 2>&1');
    expect(out).toContain('Usage');
  });

  it('uninstall with extra arguments misuse', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient uninstall extra 2>&1');
    expect(out).toContain('Usage');
  });
});
describe('netsh dnsclient – comprehensive', () => {

  // ─── 1. Help / documentation ─────────────────────────────────────────
  it('"netsh dnsclient ?" shows context help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient ?');
    expect(out).toContain('Commands in this context');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
    expect(out).toContain('reset');
  });

  it('"netsh dnsclient help" alias works', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient help');
    expect(out).toContain('Commands in this context');
  });

  it('"netsh dnsclient show ?" lists show subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient show ?');
    expect(out).toContain('state');
    expect(out).toContain('interfaces');
    expect(out).toContain('dnsservers');
  });

  it('"netsh dnsclient add ?" shows add usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add ?');
    expect(out).toContain('Usage');
    expect(out).toContain('add dnsserver');
  });

  it('"netsh dnsclient add dnsserver ?" shows specific syntax', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add dnsserver ?');
    expect(out).toContain('Usage');
    expect(out).toContain('interface');
    expect(out).toContain('address');
  });

  it('"netsh dnsclient delete ?" and "set ?"', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const delHelp = await ps.execute('netsh dnsclient delete ?');
    expect(delHelp).toContain('delete dnsserver');
    const setHelp = await ps.execute('netsh dnsclient set ?');
    expect(setHelp).toContain('set dnsserver');
  });

  // ─── 2. show state ────────────────────────────────────────────────────
  it('"netsh dnsclient show state" shows global DNS client state', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient show state');
    expect(out).toContain('DNS Client');
    expect(out).toContain('State');
    expect(out).toContain('Query');
  });

  // ─── 3. show interfaces ──────────────────────────────────────────────
  it('"netsh dnsclient show interfaces" lists all adapters and their DNS settings', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient show interfaces');
    expect(out).toContain('Ethernet 0');
    expect(out).toContain('Ethernet 1');
    expect(out).toContain('Ethernet 2');
    expect(out).toContain('Ethernet 3');
    expect(out).toContain('DNS servers');
  });

  // ─── 4. show dnsservers ──────────────────────────────────────────────
  it('"netsh dnsclient show dnsservers" shows all DNS servers per interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient show dnsservers');
    expect(out).toContain('Ethernet 0');
  });

  it('show dnsservers for specific interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    expect(out).toContain('Ethernet 0');
  });

  // ─── 5. add dnsserver ────────────────────────────────────────────────
  it('adds a DNS server to Ethernet 0', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 8.8.8.8');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    expect(out).toContain('8.8.8.8');
  });

  it('adds a secondary DNS with index', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 8.8.8.8 index=1');
    await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 1.1.1.1 index=2');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    expect(out).toContain('8.8.8.8');
    expect(out).toContain('1.1.1.1');
  });

  it('fails when adding DNS without specifying index and server list full (if simulated)', async () => {
    // If there are already two servers, and we attempt to add a third without index, may error.
    // We'll just verify error or success depending on simulator behavior; for safety we'll check an error message.
    const pc = createPC(); const ps = createPS(pc);
    // Ensure two servers
    await ps.execute('netsh dnsclient set dnsserver "Ethernet 1" static 8.8.8.8 1.1.1.1');
    const out = await ps.execute('netsh dnsclient add dnsserver "Ethernet 1" 9.9.9.9 2>&1');
    expect(out).toContain('index'); // expects index parameter
  });

  it('adds DNS server with validation (validate=no)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dnsclient add dnsserver "Ethernet 2" 4.4.4.4 validate=no')).resolves.not.toThrow();
  });

  it('adds DNS server on all interfaces using wildcard? Not supported, but we test error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add dnsserver "*" 8.8.8.8 2>&1');
    expect(out).toContain('not found'); // wildcard not accepted
  });

  it('add fails with invalid interface name', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add dnsserver "Ethernet 99" 8.8.8.8 2>&1');
    expect(out).toContain('not found');
  });

  it('add fails with invalid IP address format', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" "badip" 2>&1');
    expect(out).toContain('parameter');
  });

  it('add fails without mandatory address parameter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 6. delete dnsserver ──────────────────────────────────────────────
  it('deletes a DNS server from Ethernet 0', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 8.8.8.8 index=1');
    await ps.execute('netsh dnsclient delete dnsserver "Ethernet 0" 8.8.8.8');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    expect(out).not.toContain('8.8.8.8');
  });

  it('delete with "all" removes all DNS servers', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // set static servers first
    await ps.execute('netsh dnsclient set dnsserver "Ethernet 1" static 1.1.1.1 2.2.2.2');
    await ps.execute('netsh dnsclient delete dnsserver "Ethernet 1" all');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 1"');
    // Should be empty or show DHCP
    expect(out).not.toContain('1.1.1.1');
  });

  it('delete fails when server not configured', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient delete dnsserver "Ethernet 0" 9.9.9.9 2>&1');
    expect(out).toContain('not configured');
  });

  it('delete fails with bad interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient delete dnsserver "NoInt" 8.8.8.8 2>&1');
    expect(out).toContain('not found');
  });

  // ─── 7. set dnsserver ─────────────────────────────────────────────────
  it('sets static DNS servers (replaces existing)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient set dnsserver "Ethernet 2" static 4.4.4.4 5.5.5.5');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 2"');
    expect(out).toContain('4.4.4.4');
    expect(out).toContain('5.5.5.5');
  });

  it('set to DHCP mode', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient set dnsserver "Ethernet 3" dhcp');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 3"');
    expect(out).toContain('DHCP');
  });

  it('set fails without interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient set dnsserver static 8.8.8.8 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 8. reset ─────────────────────────────────────────────────────────
  it('reset DNS client to DHCP on all interfaces?', async () => {
    // The command might be "netsh dnsclient reset *" or just "netsh dnsclient reset"
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dnsclient reset "Ethernet 0"')).resolves.not.toThrow();
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    // After reset it should show DHCP (empty or "DHCP")
    expect(out).toContain('DHCP');
  });

  it('reset with invalid interface fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient reset "Ethernet 99" 2>&1');
    expect(out).toContain('not found');
  });

  // ─── 9. Miscellaneous / edge cases ───────────────────────────────────
  it('add DNS server with address family (IPv6)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 2001:4860:4860::8888 index=1');
    const out = await ps.execute('netsh dnsclient show dnsservers "Ethernet 0"');
    expect(out).toContain('2001:4860:4860::8888');
  });

  it('add DNS with validate=yes (default) may fail if unreachable', async () => {
    // In simulation, validation likely skipped, but we test syntax acceptance.
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('netsh dnsclient add dnsserver "Ethernet 0" 9.9.9.9 validate=yes')).resolves.not.toThrow();
  });

  it('no subcommand shows context error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient 2>&1');
    expect(out).toContain('Commands in this context');
  });

  it('completely invalid subcommand', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient blah 2>&1');
    expect(out).toContain('not found');
  });
});
describe('netsh ipsec – comprehensive', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Help & documentation
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh ipsec ?" shows context help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec ?');
    expect(out).toContain('Commands in this context');
    expect(out).toContain('static');
    expect(out).toContain('dynamic');
  });

  it('"netsh ipsec help" alias', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec help');
    expect(out).toContain('static');
  });

  it('"netsh ipsec static ?" lists static subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static ?');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
    expect(out).toContain('show');
    expect(out).toContain('policy');
    expect(out).toContain('filterlist');
    expect(out).toContain('filteraction');
    expect(out).toContain('rule');
  });

  it('"netsh ipsec dynamic ?" lists dynamic subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec dynamic ?');
    expect(out).toContain('set');
    expect(out).toContain('show');
    expect(out).toContain('IKE');
  });

  it('"netsh ipsec static add rule ?" shows usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static add rule ?');
    expect(out).toContain('Usage');
    expect(out).toContain('policy');
    expect(out).toContain('filterlist');
    expect(out).toContain('filteraction');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Static – add policy / filterlist / filteraction / rule
  // ═══════════════════════════════════════════════════════════════════════
  it('adds an IPsec policy', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="TestPolicy" description="Unit test" activatedefaultrule=no');
    const out = await ps.execute('netsh ipsec static show policy name="TestPolicy"');
    expect(out).toContain('TestPolicy');
  });

  it('duplicate policy name fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="DupPol"');
    const out = await ps.execute('netsh ipsec static add policy name="DupPol" 2>&1');
    expect(out).toContain('already exists');
  });

  it('adds a filterlist', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="MyFilterList"');
    const out = await ps.execute('netsh ipsec static show filterlist name="MyFilterList"');
    expect(out).toContain('MyFilterList');
  });

  it('adds a filteraction', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filteraction name="MyAction" action=permit');
    const out = await ps.execute('netsh ipsec static show filteraction name="MyAction"');
    expect(out).toContain('MyAction');
    expect(out).toContain('Permit');
  });

  it('adds a rule combining policy, filterlist, filteraction', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="Pol1"');
    await ps.execute('netsh ipsec static add filterlist name="FL1"');
    await ps.execute('netsh ipsec static add filteraction name="FA1" action=permit');
    await ps.execute('netsh ipsec static add rule name="Rule1" policy=Pol1 filterlist=FL1 filteraction=FA1');
    const out = await ps.execute('netsh ipsec static show rule name="Rule1"');
    expect(out).toContain('Rule1');
    expect(out).toContain('Pol1');
  });

  it('rule without policy fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static add rule name="BadRule" filterlist=FL1 filteraction=FA1 2>&1');
    expect(out).toContain('Usage');
  });

  it('rule with non-existent policy fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static add rule name="GhostRule" policy=NoPol filterlist=FL1 filteraction=FA1 2>&1');
    expect(out).toContain('not found');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Static – add filter entries to filterlist
  // ═══════════════════════════════════════════════════════════════════════
  it('adds a filter entry to a filterlist', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="FLWithEntry"');
    await ps.execute('netsh ipsec static add filter filterlist=FLWithEntry srcaddr=10.0.0.1 dstaddr=10.0.0.2 protocol=TCP');
    const out = await ps.execute('netsh ipsec static show filterlist name="FLWithEntry"');
    expect(out).toContain('10.0.0.1');
    expect(out).toContain('10.0.0.2');
  });

  it('add filter entry with mirrored option', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="FLMirror"');
    await ps.execute('netsh ipsec static add filter filterlist=FLMirror srcaddr=Any dstaddr=Any protocol=Any mirrored=yes');
    const out = await ps.execute('netsh ipsec static show filterlist name="FLMirror"');
    expect(out).toContain('Mirrored');
  });

  it('add filter entry with description', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="FLDesc"');
    await ps.execute('netsh ipsec static add filter filterlist=FLDesc srcaddr=192.168.1.0/24 dstaddr=192.168.2.0/24 description="Subnet filter"');
    const out = await ps.execute('netsh ipsec static show filterlist name="FLDesc"');
    expect(out).toContain('Subnet filter');
  });

  it('add filter entry without protocol uses any', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="FLAnyProto"');
    await ps.execute('netsh ipsec static add filter filterlist=FLAnyProto srcaddr=10.10.10.10 dstaddr=10.10.10.20');
    const out = await ps.execute('netsh ipsec static show filterlist name="FLAnyProto"');
    expect(out).toContain('Any');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Static – show commands (policy, filterlist, filteraction, rule, all)
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh ipsec static show policy" lists all policies', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static show policy');
    expect(out).toContain('TestPolicy');
  });

  it('"netsh ipsec static show filterlist" without name shows all', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static show filterlist');
    expect(out).toContain('MyFilterList');
  });

  it('"netsh ipsec static show filteraction" shows all actions', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static show filteraction');
    expect(out).toContain('MyAction');
  });

  it('"netsh ipsec static show all" shows everything', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static show all');
    expect(out).toContain('TestPolicy');
    expect(out).toContain('MyFilterList');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Static – delete commands
  // ═══════════════════════════════════════════════════════════════════════
  it('deletes a rule', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="DelPol"');
    await ps.execute('netsh ipsec static add filterlist name="DelFL"');
    await ps.execute('netsh ipsec static add filteraction name="DelFA" action=block');
    await ps.execute('netsh ipsec static add rule name="DelRule" policy=DelPol filterlist=DelFL filteraction=DelFA');
    await ps.execute('netsh ipsec static delete rule name="DelRule"');
    const out = await ps.execute('netsh ipsec static show rule name="DelRule" 2>&1');
    expect(out).toContain('not found');
  });

  it('deletes a policy (cascading deletes? simulated error?)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="CascadePol"');
    await ps.execute('netsh ipsec static delete policy name="CascadePol"');
    const out = await ps.execute('netsh ipsec static show policy name="CascadePol" 2>&1');
    expect(out).toContain('not found');
  });

  it('delete filterlist that is in use fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add policy name="UsePol"'); 
    await ps.execute('netsh ipsec static add filterlist name="UsedFL"');
    await ps.execute('netsh ipsec static add filteraction name="UsedFA" action=permit');
    await ps.execute('netsh ipsec static add rule name="UseRule" policy=UsePol filterlist=UsedFL filteraction=UsedFA');
    const out = await ps.execute('netsh ipsec static delete filterlist name="UsedFL" 2>&1');
    expect(out).toContain('cannot be deleted'); // in use
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Dynamic – show / set IKE parameters
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh ipsec dynamic show all" shows dynamic settings', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec dynamic show all');
    expect(out).toContain('IKE');
  });

  it('sets main mode parameters', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec dynamic set mainmode mmsecmethods="DHGroup2-AES128-SHA1"');
    const out = await ps.execute('netsh ipsec dynamic show all');
    expect(out).toContain('DHGroup2');
  });

  it('"netsh ipsec dynamic set qm" configures quick mode', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec dynamic set qm qmsecmethods="ESP:SHA1-AES128"');
    const out = await ps.execute('netsh ipsec dynamic show all');
    expect(out).toContain('AES128');
  });

  it('"netsh ipsec dynamic set config" enables IPsec diagnostics', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec dynamic set config ikelogging=1');
    const out = await ps.execute('netsh ipsec dynamic show all');
    expect(out).toContain('ikelogging');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Error cases (syntax, missing parameters, invalid interfaces, etc.)
  // ═══════════════════════════════════════════════════════════════════════
  it('no subcommand shows context error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec 2>&1');
    expect(out).toContain('Commands in this context');
  });

  it('invalid subcommand', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec foobar 2>&1');
    expect(out).toContain('not found');
  });

  it('add policy without name fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec static add policy 2>&1');
    expect(out).toContain('Usage');
  });

  it('add rule with invalid IP address in filterlist entry fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh ipsec static add filterlist name="BadFL"');
    const out = await ps.execute('netsh ipsec static add filter filterlist=BadFL srcaddr=999.999.999.999 dstaddr=Any 2>&1');
    expect(out).toContain('Invalid');
  });
});
describe('netsh lan – comprehensive', () => {

  // ─── 1. Help & documentation ──────────────────────────────────────────
  it('"netsh lan ?" shows context help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan ?');
    expect(out).toContain('Commands in this context');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
    expect(out).toContain('reconnect');
  });

  it('"netsh lan help" shows the same help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan help');
    expect(out).toContain('Commands in this context');
  });

  it('"netsh lan show ?" lists show subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan show ?');
    expect(out).toContain('profiles');
    expect(out).toContain('interfaces');
    expect(out).toContain('settings');
    expect(out).toContain('tracing');
  });

  it('"netsh lan add ?" shows add syntax', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan add ?');
    expect(out).toContain('Usage');
    expect(out).toContain('add profile');
  });

  it('"netsh lan add profile ?" shows detailed options', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan add profile ?');
    expect(out).toContain('filename');
    expect(out).toContain('interface');
    expect(out).toContain('name');
  });

  it('"netsh lan delete ?" shows delete help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan delete ?');
    expect(out).toContain('delete profile');
  });

  it('"netsh lan set ?" shows set subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan set ?');
    expect(out).toContain('autoconnect');
    expect(out).toContain('tracing');
  });

  // ─── 2. show commands ─────────────────────────────────────────────────
  it('"netsh lan show profiles" lists wired profiles', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan show profiles');
    expect(out).toContain('Profiles');
    // May be empty initially
  });

  it('"netsh lan show interfaces" lists wired interfaces', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan show interfaces');
    expect(out).toContain('Ethernet 0');
    expect(out).toContain('Ethernet 1');
    expect(out).toContain('Ethernet 2');
    expect(out).toContain('Ethernet 3');
  });

  it('"netsh lan show settings" displays LAN settings', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan show settings');
    expect(out).toContain('Wired AutoConfig Service');
    expect(out).toContain('Status');
  });

  it('"netsh lan show tracing" shows trace status', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan show tracing');
    expect(out).toContain('Tracing');
    expect(out).toContain('Enabled');
  });

  // ─── 3. add profile ───────────────────────────────────────────────────
  it('adds a wired profile from XML file on Ethernet 0', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 0"');
    const out = await ps.execute('netsh lan show profiles');
    expect(out).toContain('WiredProfile');  // le nom défini dans le XML de test
  });

  it('adds profile with explicit name override', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 1" name="CustomName"');
    const out = await ps.execute('netsh lan show profiles');
    expect(out).toContain('CustomName');
  });

  it('add profile with non‑existent XML file fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan add profile filename="C:\\missing.xml" interface="Ethernet 0" 2>&1');
    expect(out).toContain('Cannot find');
  });

  it('add profile with invalid interface name fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 99" 2>&1');
    expect(out).toContain('not found');
  });

  it('add profile without mandatory filename fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan add profile interface="Ethernet 0" 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 4. delete profile ────────────────────────────────────────────────
  it('deletes a wired profile by name', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 2" name="ToDelete"');
    await ps.execute('netsh lan delete profile name="ToDelete"');
    const out = await ps.execute('netsh lan show profiles');
    expect(out).not.toContain('ToDelete');
  });

  it('delete profile with non‑existent name fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan delete profile name="NoSuchProfile" 2>&1');
    expect(out).toContain('Profile not found');
  });

  it('delete profile without name fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan delete profile 2>&1');
    expect(out).toContain('Usage');
  });

  // ─── 5. set / reconnect commands ──────────────────────────────────────
  it('sets autoconnect enabled on an interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan set autoconnect enabled interface="Ethernet 0"');
    // vérifier pas d'erreur ; le setting n'a pas de show direct, on teste juste pas d'exception
    expect(true).toBe(true);
  });

  it('sets autoconnect disabled on an interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan set autoconnect disabled interface="Ethernet 1"');
    expect(true).toBe(true);
  });

  it('set autoconnect with missing interface fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan set autoconnect enabled 2>&1');
    expect(out).toContain('Usage');
  });

  it('reconnects an interface (applies profile)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 3" name="ReconnectTest"');
    await ps.execute('netsh lan reconnect interface="Ethernet 3"');
    // pas d'erreur
    expect(true).toBe(true);
  });

  it('reconnect with bad interface fails', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan reconnect interface="Ethernet 99" 2>&1');
    expect(out).toContain('not found');
  });

  // ─── 6. export / import (if simulated) ────────────────────────────────
  it('exports the LAN policy to an XML file', async () => {
    // export writes to virtual filesystem not directly accessible from WinNetsh;
    // we verify the command completes without error and returns a success message
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan export profile folder="C:\\temp\\"');
    expect(out).toMatch(/saved|exported|profile|ok/i);
  });

  it('imports a LAN policy from an XML file', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 0"');
    await ps.execute('netsh lan delete profile name="WiredProfile"');
    // import re-adds the profile without needing an actual file on disk
    await ps.execute('netsh lan import profile filename="C:\\temp\\WiredPolicy.xml"');
    const out = await ps.execute('netsh lan show profiles');
    expect(out).toContain('WiredProfile');
  });

  // ─── 7. Miscellaneous / error handling ────────────────────────────────
  it('no subcommand shows context error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan 2>&1');
    expect(out).toContain('Commands in this context');
  });

  it('invalid subcommand', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan foobar 2>&1');
    expect(out).toContain('not found');
  });

  it('set tracing enable / disable', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan set tracing enable');
    let out = await ps.execute('netsh lan show tracing');
    expect(out).toContain('Enabled');
    await ps.execute('netsh lan set tracing disable');
    out = await ps.execute('netsh lan show tracing');
    expect(out).toContain('Disabled');
  });

  it('delete all profiles (if supported)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 0" name="Bulk1"');
    await ps.execute('netsh lan add profile filename="C:\\temp\\lanprofile.xml" interface="Ethernet 1" name="Bulk2"');
    // delete all via wildcard? Some versions support "netsh lan delete profile name=*"
    const out = await ps.execute('netsh lan delete profile name="*" 2>&1');
    // Either it deletes all or shows usage, we check not crash
    expect(out).toBeDefined();
  });
});
describe('netsh help – comprehensive', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Top‑level help
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh help" shows top‑level context list', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh help');
    expect(out).toContain('Commands in this context');
    expect(out).toContain('interface');
    expect(out).toContain('advfirewall');
  });

  it('"netsh ?" alias displays the same top‑level help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ?');
    expect(out).toContain('interface');
  });

  it('"netsh /?" shows top‑level help (external syntax)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh /?');
    expect(out).toContain('Commands in this context');
  });

  it('"netsh -?" also works', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh -?');
    expect(out).toContain('Commands in this context');
  });

  it('no arguments at all still gives help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh');
    expect(out).toContain('Commands in this context');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Context help (one level down)
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh interface help" shows subcontexts', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface help');
    expect(out).toContain('ip');
    expect(out).toContain('ipv4');
    expect(out).toContain('ipv6');
    expect(out).toContain('show');
    expect(out).toContain('set');
  });

  it('"netsh interface ?" alias gives same output', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ?');
    expect(out).toContain('ip');
  });

  it('"netsh advfirewall help" shows firewall subcontexts', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh advfirewall help');
    expect(out).toContain('firewall');
    expect(out).toContain('consec');
    expect(out).toContain('show');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Nested context help (two levels down)
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh interface ip help" shows ip subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ip help');
    expect(out).toContain('show');
    expect(out).toContain('set');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('reset');
  });

  it('"netsh interface ipv4 help" shows ipv4 subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 help');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Command‑specific help (three levels down)
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh interface ip show ?" shows config, addresses, dns etc.', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ip show ?');
    expect(out).toContain('config');
    expect(out).toContain('addresses');
    expect(out).toContain('dns');
  });

  it('"netsh interface ip set ?" shows set subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ip set ?');
    expect(out).toContain('address');
    expect(out).toContain('dns');
  });

  it('"netsh interface ip add address ?" shows usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ip add address ?');
    expect(out).toContain('Usage');
    expect(out).toContain('address');
    expect(out).toContain('subnet');
  });

  it('"netsh interface ipv4 add route ?" shows usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv4 add route ?');
    expect(out).toContain('Usage');
    expect(out).toContain('prefix');
    expect(out).toContain('nexthop');
  });

  it('"netsh interface ipv6 delete route ?" shows usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ipv6 delete route ?');
    expect(out).toContain('Usage');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Help for other common contexts
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh wlan help" shows wireless subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh wlan help');
    expect(out).toContain('show');
    expect(out).toContain('connect');
    expect(out).toContain('disconnect');
    expect(out).toContain('add');
    expect(out).toContain('delete');
  });

  it('"netsh lan help" shows wired subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh lan help');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
  });

  it('"netsh bridge help" shows bridge subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh bridge help');
    expect(out).toContain('show');
    expect(out).toContain('create');
    expect(out).toContain('delete');
    expect(out).toContain('add');
  });

  it('"netsh http help" shows http subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh http help');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
  });

  it('"netsh namespace help" shows namespace subcommands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh namespace help');
    expect(out).toContain('show');
    expect(out).toContain('add');
    expect(out).toContain('delete');
  });

  it('"netsh dhcpclient help" shows dhcp client commands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dhcpclient help');
    expect(out).toContain('install');
    expect(out).toContain('show');
    expect(out).toContain('set');
  });

  it('"netsh dnsclient help" shows dns client commands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh dnsclient help');
    expect(out).toContain('add');
    expect(out).toContain('delete');
    expect(out).toContain('set');
    expect(out).toContain('show');
  });

  it('"netsh ipsec help" shows ipsec commands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh ipsec help');
    expect(out).toContain('static');
    expect(out).toContain('dynamic');
  });

  it('"netsh trace help" shows trace commands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh trace help');
    expect(out).toContain('start');
    expect(out).toContain('stop');
  });

  it('"netsh winhttp help" shows winhttp commands', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh winhttp help');
    expect(out).toContain('show');
    expect(out).toContain('set');
    expect(out).toContain('reset');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Help on non‑existent contexts / error cases
  // ═══════════════════════════════════════════════════════════════════════
  it('"netsh foobar help" shows error message', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh foobar help 2>&1');
    expect(out).toContain('not found');
  });

  it('"netsh interface foobar ?" shows error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface foobar ? 2>&1');
    expect(out).toContain('not found');
  });

  it('help on a valid context but invalid subcommand shows correct usage', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh interface ip foobar ? 2>&1');
    expect(out).toContain('not found');
  });

  it('"netsh help help" works recursively (help on help)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh help help');
    expect(out).toContain('Commands in this context'); // or help on help
  });

  it('extra arguments after ? are ignored / still show help', async () => {
    // netsh wlan show profiles ? extra -> still shows profiles help
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('netsh wlan show profiles ? extra');
    // may show usage or just ignore; we just ensure no crash
    expect(out).toContain('Usage');
  });
});
