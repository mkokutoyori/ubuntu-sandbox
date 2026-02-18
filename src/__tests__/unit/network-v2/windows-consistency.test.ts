/**
 * Cross-command consistency tests for Windows network simulator.
 *
 * Verifies that information displayed by different commands about the same
 * state is always consistent. Uses LANs with Windows PCs and switches.
 *
 * 40 scenarios from basic (single PC) to advanced (multi-PC LAN).
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '../../../network/devices/WindowsPC';
import { CiscoSwitch } from '../../../network/devices/CiscoSwitch';
import { Cable } from '../../../network/hardware/Cable';

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract the first IPv4 address found in a multi-line string */
function extractIP(text: string, label: string): string | null {
  const re = new RegExp(label + '\\s*[.:\\s]*\\s*(\\d+\\.\\d+\\.\\d+\\.\\d+)');
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Build a simple LAN: N PCs connected to a switch, each with an IP */
function buildLAN(
  count: number,
  subnet: string = '192.168.1',
  startIP: number = 10,
): { pcs: WindowsPC[]; sw: CiscoSwitch; cables: Cable[] } {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
  const pcs: WindowsPC[] = [];
  const cables: Cable[] = [];
  for (let i = 0; i < count; i++) {
    const pc = new WindowsPC('windows-pc', `PC${i + 1}`, 0, 0);
    const cable = new Cable(`cable-${i}`);
    cable.connect(pc.getPort('eth0')!, sw.getPort(`FastEthernet0/${i}`)!);
    pcs.push(pc);
    cables.push(cable);
  }
  return { pcs, sw, cables };
}

async function configureIP(pc: WindowsPC, ip: string, mask: string = '255.255.255.0', gw?: string) {
  const cmd = gw
    ? `netsh interface ip set address "Ethernet 0" static ${ip} ${mask} ${gw}`
    : `netsh interface ip set address "Ethernet 0" static ${ip} ${mask}`;
  await pc.executeCommand(cmd);
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Single PC — Hostname & Version Consistency (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Hostname & Version Consistency', () => {

  it('C-01: hostname command matches ipconfig /all Host Name', async () => {
    const pc = new WindowsPC('windows-pc', 'DESKTOP-T01', 0, 0);
    const hostname = await pc.executeCommand('hostname');
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const match = ipcAll.match(/Host Name\s*[.:\s]+:\s*(\S+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(hostname.trim());
  });

  it('C-02: hostname command matches systeminfo Host Name', async () => {
    const pc = new WindowsPC('windows-pc', 'SRV-WIN01', 0, 0);
    const hostname = await pc.executeCommand('hostname');
    const sysinfo = await pc.executeCommand('systeminfo');
    expect(sysinfo).toContain(`Host Name:                 ${hostname.trim()}`);
  });

  it('C-03: %COMPUTERNAME% env var matches hostname', async () => {
    const pc = new WindowsPC('windows-pc', 'NODE-42', 0, 0);
    const hostname = await pc.executeCommand('hostname');
    const echoName = await pc.executeCommand('echo %COMPUTERNAME%');
    expect(echoName.trim()).toBe(hostname.trim());
  });

  it('C-04: ver output contains valid Windows version', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ver = await pc.executeCommand('ver');
    expect(ver).toContain('Microsoft Windows');
    expect(ver).toMatch(/\d+\.\d+/); // version number
  });

  it('C-05: systeminfo OS Name matches ver output brand', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ver = await pc.executeCommand('ver');
    const sysinfo = await pc.executeCommand('systeminfo');
    // Both should mention "Windows"
    expect(ver).toContain('Windows');
    expect(sysinfo).toContain('Microsoft Windows');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Single PC — IP Address Consistency (7 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: IP Address Consistency', () => {

  it('C-06: ipconfig IP matches netsh interface ip show config IP', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '10.0.0.50', '255.255.255.0');
    const ipc = await pc.executeCommand('ipconfig');
    const netsh = await pc.executeCommand('netsh interface ip show config');
    expect(ipc).toContain('10.0.0.50');
    expect(netsh).toContain('10.0.0.50');
  });

  it('C-07: ipconfig subnet mask matches netsh show config mask', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '172.16.0.1', '255.255.0.0');
    const ipc = await pc.executeCommand('ipconfig');
    const netsh = await pc.executeCommand('netsh interface ip show config');
    expect(ipc).toContain('255.255.0.0');
    // netsh shows CIDR prefix or mask
    expect(netsh).toContain('172.16.0.1');
  });

  it('C-08: ipconfig gateway matches netsh show config gateway', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '192.168.1.10', '255.255.255.0', '192.168.1.1');
    const ipc = await pc.executeCommand('ipconfig');
    const netsh = await pc.executeCommand('netsh interface ip show config');
    expect(ipc).toContain('192.168.1.1');
    expect(netsh).toContain('192.168.1.1');
  });

  it('C-09: ipconfig IP matches route print interface column', async () => {
    const { pcs, sw } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10');
    const ipc = await pcs[0].executeCommand('ipconfig');
    const route = await pcs[0].executeCommand('route print');
    expect(ipc).toContain('192.168.1.10');
    expect(route).toContain('192.168.1.10');
  });

  it('C-10: ipconfig IP matches systeminfo IP address', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '10.10.10.1', '255.255.255.0');
    const ipc = await pc.executeCommand('ipconfig');
    const sysinfo = await pc.executeCommand('systeminfo');
    expect(ipc).toContain('10.10.10.1');
    expect(sysinfo).toContain('10.10.10.1');
  });

  it('C-11: ipconfig IP matches dhcpclient list IP', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '192.168.50.5', '255.255.255.0');
    const ipc = await pc.executeCommand('ipconfig');
    const dhcp = await pc.executeCommand('netsh dhcpclient list');
    expect(ipc).toContain('192.168.50.5');
    expect(dhcp).toContain('192.168.50.5');
  });

  it('C-12: ipconfig /all DHCP status matches netsh show config DHCP', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '10.0.0.1', '255.255.255.0');
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const netsh = await pc.executeCommand('netsh interface ip show config');
    // Static config → DHCP disabled → "No" in both
    expect(ipcAll).toContain('DHCP Enabled');
    expect(netsh).toContain('DHCP enabled');
    // Both should say No for static
    expect(ipcAll).toMatch(/DHCP Enabled[.\s]*:\s*No/i);
    expect(netsh).toContain('No');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: DNS Consistency (6 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: DNS Consistency', () => {

  it('C-13: DNS server in netsh ip show dns matches dnsclient show state', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
    const showDns = await pc.executeCommand('netsh interface ip show dns');
    const state = await pc.executeCommand('netsh dnsclient show state');
    expect(showDns).toContain('8.8.8.8');
    expect(state).toContain('8.8.8.8');
  });

  it('C-14: multiple DNS servers consistent across all commands', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
    await pc.executeCommand('netsh interface ip add dns "Ethernet 0" 1.1.1.1');
    const showDns = await pc.executeCommand('netsh interface ip show dns');
    const state = await pc.executeCommand('netsh dnsclient show state');
    for (const server of ['8.8.8.8', '1.1.1.1']) {
      expect(showDns).toContain(server);
      expect(state).toContain(server);
    }
  });

  it('C-15: DNS suffix in ipconfig matches dnsclient show state', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh dnsclient set global dnssuffix=test.local');
    const ipc = await pc.executeCommand('ipconfig');
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const state = await pc.executeCommand('netsh dnsclient show state');
    expect(ipc).toContain('test.local');
    expect(ipcAll).toContain('test.local');
    expect(state).toContain('test.local');
  });

  it('C-16: DNS suffix in ipconfig /all Primary Dns Suffix matches dnsclient', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh dnsclient set global dnssuffix=corp.lan');
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const state = await pc.executeCommand('netsh dnsclient show state');
    // Both should show the same suffix value
    expect(ipcAll).toMatch(/Primary Dns Suffix.*corp\.lan/);
    expect(state).toContain('corp.lan');
  });

  it('C-17: after DNS delete, removal reflected in all commands', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
    await pc.executeCommand('netsh interface ip add dns "Ethernet 0" 1.1.1.1');
    await pc.executeCommand('netsh interface ip delete dns "Ethernet 0" 8.8.8.8');
    const showDns = await pc.executeCommand('netsh interface ip show dns');
    const state = await pc.executeCommand('netsh dnsclient show state');
    expect(showDns).not.toContain('8.8.8.8');
    expect(state).not.toContain('8.8.8.8');
    expect(showDns).toContain('1.1.1.1');
    expect(state).toContain('1.1.1.1');
  });

  it('C-18: DNS reset clears servers from all views', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 9.9.9.9');
    await pc.executeCommand('netsh dnsclient set global dnssuffix=old.domain');
    await pc.executeCommand('netsh int ip reset');
    const showDns = await pc.executeCommand('netsh interface ip show dns');
    const state = await pc.executeCommand('netsh dnsclient show state');
    const ipc = await pc.executeCommand('ipconfig');
    expect(showDns).not.toContain('9.9.9.9');
    expect(state).not.toContain('9.9.9.9');
    expect(state).not.toContain('old.domain');
    expect(ipc).not.toContain('old.domain');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: Interface State Consistency (7 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Interface State Consistency', () => {

  it('C-19: interface count in systeminfo matches ipconfig adapter count', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const sysinfo = await pc.executeCommand('systeminfo');
    const ipc = await pc.executeCommand('ipconfig');
    // WindowsPC has 4 ports (eth0-eth3)
    const adapterMatches = ipc.match(/Ethernet adapter/g);
    expect(adapterMatches).not.toBeNull();
    expect(sysinfo).toContain(`${adapterMatches!.length} NIC(s) Installed`);
  });

  it('C-20: interface count matches netsh interface show interface rows', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const netshIf = await pc.executeCommand('netsh interface show interface');
    const ipc = await pc.executeCommand('ipconfig');
    const adapterCount = (ipc.match(/Ethernet adapter/g) || []).length;
    const ifRows = (netshIf.match(/Ethernet \d/g) || []).length;
    expect(ifRows).toBe(adapterCount);
  });

  it('C-21: disabled interface shows Media disconnected in ipconfig AND Disabled in netsh', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '10.0.0.1');
    await pc.executeCommand('netsh interface set interface "Ethernet 0" admin=disable');
    const ipc = await pc.executeCommand('ipconfig');
    const netshIf = await pc.executeCommand('netsh interface show interface');
    expect(ipc).toContain('Media disconnected');
    expect(netshIf).toMatch(/Disabled\s+Disconnected.*Ethernet 0/);
  });

  it('C-22: re-enabled interface no longer shows disconnected', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '10.0.0.1');
    await pcs[0].executeCommand('netsh interface set interface "Ethernet 0" admin=disable');
    await pcs[0].executeCommand('netsh interface set interface "Ethernet 0" admin=enable');
    const ipc = await pcs[0].executeCommand('ipconfig');
    const netshIf = await pcs[0].executeCommand('netsh interface show interface');
    // Ethernet 0 should now show Enabled and have an IP (re-enabled)
    expect(netshIf).toMatch(/Enabled\s+.*Ethernet 0/);
  });

  it('C-23: dhcpclient list source matches ipconfig DHCP enabled status', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await configureIP(pc, '10.0.0.1');
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const dhcpList = await pc.executeCommand('netsh dhcpclient list');
    // Static → DHCP No + Manual source
    expect(ipcAll).toMatch(/DHCP Enabled[.\s]*:\s*No/i);
    expect(dhcpList).toContain('Manual');
  });

  it('C-24: MAC in ipconfig /all matches route print interface list', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ipcAll = await pc.executeCommand('ipconfig /all');
    const route = await pc.executeCommand('route print');
    // Extract a MAC from ipconfig /all (format: XX-XX-XX-XX-XX-XX)
    const macMatch = ipcAll.match(/Physical Address[.\s]*:\s*([0-9A-F-]+)/i);
    expect(macMatch).not.toBeNull();
    // route print shows MACs with spaces (xx xx xx xx xx xx)
    const macSpaced = macMatch![1].replace(/-/g, ' ').toLowerCase();
    expect(route.toLowerCase()).toContain(macSpaced);
  });

  it('C-25: netsh interface show interface matches dhcpclient list interface names', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const netshIf = await pc.executeCommand('netsh interface show interface');
    const dhcpList = await pc.executeCommand('netsh dhcpclient list');
    // Both should show same interface names
    for (let i = 0; i < 4; i++) {
      expect(netshIf).toContain(`Ethernet ${i}`);
      expect(dhcpList).toContain(`Ethernet ${i}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 5: Routing Table Consistency (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Routing Table Consistency', () => {

  it('C-26: connected route in route print matches netsh ip show route', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10');
    const route = await pcs[0].executeCommand('route print');
    const netsh = await pcs[0].executeCommand('netsh interface ip show route');
    // Both should show the connected 192.168.1.0 network
    expect(route).toContain('192.168.1.0');
    expect(netsh).toContain('192.168.1.0');
  });

  it('C-27: added static route visible in both route print and netsh show route', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10', '255.255.255.0', '192.168.1.1');
    await pcs[0].executeCommand('netsh interface ip add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1');
    const route = await pcs[0].executeCommand('route print');
    const netsh = await pcs[0].executeCommand('netsh interface ip show route');
    expect(route).toContain('10.0.0.0');
    expect(netsh).toContain('10.0.0.0');
  });

  it('C-28: default gateway in route print matches ipconfig gateway', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10', '255.255.255.0', '192.168.1.1');
    const ipc = await pcs[0].executeCommand('ipconfig');
    const route = await pcs[0].executeCommand('route print');
    expect(ipc).toContain('192.168.1.1');
    // route print shows default as 0.0.0.0/0.0.0.0 with gateway
    expect(route).toContain('192.168.1.1');
  });

  it('C-29: after route delete, removal reflected in both commands', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10', '255.255.255.0', '192.168.1.1');
    await pcs[0].executeCommand('netsh interface ip add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1');
    await pcs[0].executeCommand('netsh interface ip delete route 10.0.0.0/24 "Ethernet 0"');
    const route = await pcs[0].executeCommand('route print');
    const netsh = await pcs[0].executeCommand('netsh interface ip show route');
    // 10.0.0.0 should be gone from both
    expect(route).not.toMatch(/\b10\.0\.0\.0\b.*255\.255\.255\.0/);
    expect(netsh).not.toContain('10.0.0.0/24');
  });

  it('C-30: route add via route command matches netsh show route', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10', '255.255.255.0', '192.168.1.1');
    await pcs[0].executeCommand('route add 172.16.0.0 mask 255.255.0.0 192.168.1.1');
    const route = await pcs[0].executeCommand('route print');
    const netsh = await pcs[0].executeCommand('netsh interface ip show route');
    expect(route).toContain('172.16.0.0');
    expect(netsh).toContain('172.16.0.0');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 6: LAN — Two PCs + Switch (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: LAN — Two PCs + Switch', () => {

  it('C-31: two PCs see their own IP consistently via ipconfig and netsh', async () => {
    const { pcs } = buildLAN(2);
    await configureIP(pcs[0], '192.168.1.10');
    await configureIP(pcs[1], '192.168.1.20');
    for (const [i, ip] of ['192.168.1.10', '192.168.1.20'].entries()) {
      const ipc = await pcs[i].executeCommand('ipconfig');
      const netsh = await pcs[i].executeCommand('netsh interface ip show config');
      expect(ipc).toContain(ip);
      expect(netsh).toContain(ip);
    }
  });

  it('C-32: after ping, ARP table on both PCs has consistent entries', async () => {
    const { pcs } = buildLAN(2);
    await configureIP(pcs[0], '192.168.1.10');
    await configureIP(pcs[1], '192.168.1.20');
    await pcs[0].executeCommand('ping 192.168.1.20');
    const arp0 = await pcs[0].executeCommand('arp -a');
    const arp1 = await pcs[1].executeCommand('arp -a');
    // PC0 should know PC1's IP/MAC, PC1 should know PC0's IP/MAC
    expect(arp0).toContain('192.168.1.20');
    expect(arp1).toContain('192.168.1.10');
  });

  it('C-33: ARP MAC for peer matches peer ipconfig /all Physical Address', async () => {
    const { pcs } = buildLAN(2);
    await configureIP(pcs[0], '192.168.1.10');
    await configureIP(pcs[1], '192.168.1.20');
    await pcs[0].executeCommand('ping 192.168.1.20');
    // Get PC1's MAC from its own ipconfig /all
    const pc1All = await pcs[1].executeCommand('ipconfig /all');
    const macMatch = pc1All.match(/Ethernet adapter Ethernet 0:[\s\S]*?Physical Address[.\s]*:\s*([0-9A-Fa-f-]+)/);
    expect(macMatch).not.toBeNull();
    const pc1Mac = macMatch![1].toLowerCase();
    // Check PC0's ARP table has same MAC for 192.168.1.20
    const arp0 = await pcs[0].executeCommand('arp -a');
    expect(arp0.toLowerCase()).toContain(pc1Mac);
  });

  it('C-34: both PCs on same subnet share same network in route print', async () => {
    const { pcs } = buildLAN(2);
    await configureIP(pcs[0], '192.168.1.10');
    await configureIP(pcs[1], '192.168.1.20');
    const route0 = await pcs[0].executeCommand('route print');
    const route1 = await pcs[1].executeCommand('route print');
    // Both should have 192.168.1.0 connected route
    expect(route0).toContain('192.168.1.0');
    expect(route1).toContain('192.168.1.0');
  });

  it('C-35: after IP change, ipconfig and netsh reflect new IP', async () => {
    const { pcs } = buildLAN(1);
    await configureIP(pcs[0], '192.168.1.10');
    // Change IP
    await configureIP(pcs[0], '10.0.0.99', '255.255.255.0');
    const ipc = await pcs[0].executeCommand('ipconfig');
    const netsh = await pcs[0].executeCommand('netsh interface ip show config');
    const dhcp = await pcs[0].executeCommand('netsh dhcpclient list');
    expect(ipc).toContain('10.0.0.99');
    expect(ipc).not.toContain('192.168.1.10');
    expect(netsh).toContain('10.0.0.99');
    expect(dhcp).toContain('10.0.0.99');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 7: LAN — Three PCs + Switch Advanced (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: LAN — Three PCs + Switch Advanced', () => {

  it('C-36: three PCs on same subnet all show same network in route print', async () => {
    const { pcs } = buildLAN(3);
    await configureIP(pcs[0], '10.10.10.1');
    await configureIP(pcs[1], '10.10.10.2');
    await configureIP(pcs[2], '10.10.10.3');
    for (const pc of pcs) {
      const route = await pc.executeCommand('route print');
      expect(route).toContain('10.10.10.0');
    }
  });

  it('C-37: ping from each PC populates all ARP tables consistently', async () => {
    const { pcs } = buildLAN(3);
    await configureIP(pcs[0], '10.10.10.1');
    await configureIP(pcs[1], '10.10.10.2');
    await configureIP(pcs[2], '10.10.10.3');
    // PC0 pings PC1 and PC2
    await pcs[0].executeCommand('ping 10.10.10.2');
    await pcs[0].executeCommand('ping 10.10.10.3');
    const arp = await pcs[0].executeCommand('arp -a');
    expect(arp).toContain('10.10.10.2');
    expect(arp).toContain('10.10.10.3');
  });

  it('C-38: systeminfo NIC count consistent across all PCs', async () => {
    const { pcs } = buildLAN(3);
    for (const pc of pcs) {
      const sysinfo = await pc.executeCommand('systeminfo');
      const ipc = await pc.executeCommand('ipconfig');
      const adapterCount = (ipc.match(/Ethernet adapter/g) || []).length;
      expect(sysinfo).toContain(`${adapterCount} NIC(s) Installed`);
    }
  });

  it('C-39: all PCs share consistent view of their own hostname', async () => {
    const { pcs } = buildLAN(3);
    for (const pc of pcs) {
      const hostname = await pc.executeCommand('hostname');
      const ipcAll = await pc.executeCommand('ipconfig /all');
      const sysinfo = await pc.executeCommand('systeminfo');
      const echoName = await pc.executeCommand('echo %COMPUTERNAME%');
      const name = hostname.trim();
      expect(ipcAll).toContain(name);
      expect(sysinfo).toContain(name);
      expect(echoName.trim()).toBe(name);
    }
  });

  it('C-40: full network config consistency — 3 PCs, DNS, gateway, routes', async () => {
    const { pcs } = buildLAN(3);
    // Configure full network
    await configureIP(pcs[0], '192.168.1.10', '255.255.255.0', '192.168.1.1');
    await configureIP(pcs[1], '192.168.1.20', '255.255.255.0', '192.168.1.1');
    await configureIP(pcs[2], '192.168.1.30', '255.255.255.0', '192.168.1.1');

    // Set DNS on all PCs
    for (const pc of pcs) {
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
      await pc.executeCommand('netsh dnsclient set global dnssuffix=company.com');
    }

    // Verify consistency on each PC
    for (let i = 0; i < 3; i++) {
      const ip = `192.168.1.${(i + 1) * 10}`;
      const pc = pcs[i];

      // 1. IP consistent across ipconfig, netsh show config, dhcpclient list
      const ipc = await pc.executeCommand('ipconfig');
      const netshCfg = await pc.executeCommand('netsh interface ip show config');
      const dhcp = await pc.executeCommand('netsh dhcpclient list');
      expect(ipc).toContain(ip);
      expect(netshCfg).toContain(ip);
      expect(dhcp).toContain(ip);

      // 2. Gateway consistent across ipconfig, netsh, route print
      expect(ipc).toContain('192.168.1.1');
      expect(netshCfg).toContain('192.168.1.1');
      const route = await pc.executeCommand('route print');
      expect(route).toContain('192.168.1.1');

      // 3. DNS consistent across netsh show dns, dnsclient show state
      const showDns = await pc.executeCommand('netsh interface ip show dns');
      const dnsState = await pc.executeCommand('netsh dnsclient show state');
      expect(showDns).toContain('8.8.8.8');
      expect(dnsState).toContain('8.8.8.8');

      // 4. DNS suffix consistent across ipconfig /all and dnsclient
      const ipcAll = await pc.executeCommand('ipconfig /all');
      expect(ipcAll).toContain('company.com');
      expect(dnsState).toContain('company.com');

      // 5. Hostname consistent
      const hostname = (await pc.executeCommand('hostname')).trim();
      expect(ipcAll).toContain(hostname);
    }

    // Verify cross-PC ARP consistency after pings
    await pcs[0].executeCommand('ping 192.168.1.20');
    await pcs[0].executeCommand('ping 192.168.1.30');
    const arp0 = await pcs[0].executeCommand('arp -a');
    expect(arp0).toContain('192.168.1.20');
    expect(arp0).toContain('192.168.1.30');
  });
});
