/**
 * ping / tracert / Test-NetConnection fidelity — one network engine,
 * honest output (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §2).
 *
 * Pins:
 *   - tracert never fabricates hops the network did not report,
 *   - tracert -d keeps the header and trailer (only name resolution is off),
 *   - tracert honors -h instead of a silent hard cap,
 *   - ping's interface-down check looks at the egress port, not eth0,
 *   - ping statistics block matches real Windows (no merged extra line),
 *   - Test-NetConnection resolves hostnames through DNS like ping does.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { PowerShellExecutor, type PSDeviceContext } from '@/network/devices/windows/PowerShellExecutor';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const psShell = (d: WindowsPC) => {
  const sub = PowerShellSubShell.create(d).subShell;
  return async (line: string) => (await sub.processLine(line)).output.join('\n');
};

// ═══════════════════════════════════════════════════════════════════
// tracert — honest hop reporting
// ═══════════════════════════════════════════════════════════════════

describe('tracert does not fabricate hops', () => {
  it('with a configured but unreachable gateway, hop 1 is not a fake gateway reply', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.0.1')); // nothing is cabled — gateway can't answer
    const out = await pc.executeCommand('tracert -h 4 -w 50 9.9.9.9');
    // The gateway never answered a probe, so it must never appear as a
    // responding hop with an RTT.
    expect(out).not.toMatch(/1\s+(<1|\d+) ms.*10\.0\.0\.1/);
  });

  it('shows timeout rows up to -h when nothing answers, not a fabricated 3-hop story', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.0.1'));
    const out = await pc.executeCommand('tracert -h 5 -w 50 9.9.9.9');
    const timeoutRows = out.split('\n').filter((l) => l.includes('Request timed out'));
    expect(timeoutRows.length).toBe(5);
  });
});

describe('tracert -d keeps the standard format', () => {
  it('still prints the Tracing route header and Trace complete trailer', async () => {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const peer = new LinuxPC('PC2', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('eth0')!);
    new Cable('c2').connect(peer.getPort('eth0')!, sw.getPort('eth1')!);
    win.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    await peer.executeCommand('ifconfig eth0 10.0.0.6 netmask 255.255.255.0');

    const out = await win.executeCommand('tracert -d 10.0.0.6');
    expect(out).toContain('Tracing route to 10.0.0.6');
    expect(out).toContain('Trace complete.');
    expect(out).toContain('10.0.0.6');
  });
});

describe('tracert honors -h beyond the historical hard cap of 8', () => {
  it('announces and probes the requested hop budget', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.0.1'));
    const out = await pc.executeCommand('tracert -h 12 -w 20 9.9.9.9');
    expect(out).toContain('over a maximum of 12 hops');
    const timeoutRows = out.split('\n').filter((l) => l.includes('Request timed out'));
    expect(timeoutRows.length).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ping — egress-aware failure detection, honest statistics
// ═══════════════════════════════════════════════════════════════════

describe('ping interface-down check uses the real egress, not eth0', () => {
  it('pings fine through eth1 when eth0 is administratively down', async () => {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const peer = new LinuxPC('PC2', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW1');
    // eth0 stays down/unplugged; the network lives on eth1.
    new Cable('c1').connect(win.getPort('eth1')!, sw.getPort('eth0')!);
    new Cable('c2').connect(peer.getPort('eth0')!, sw.getPort('eth1')!);
    win.getPort('eth0')!.setAdminDown(true);
    win.configureInterface('eth1', new IPAddress('10.1.0.5'), new SubnetMask('255.255.255.0'));
    await peer.executeCommand('ifconfig eth0 10.1.0.6 netmask 255.255.255.0');

    const out = await win.executeCommand('ping -n 1 10.1.0.6');
    expect(out).toContain('Reply from 10.1.0.6');
    expect(out).not.toContain('transmit failed');
  });
});

describe('ping statistics block matches Windows', () => {
  it('a fully lost ping reports per-request timeouts and a plain statistics block', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('ping -n 2 -w 50 10.0.0.99');
    // Real Windows never appends "Request timed out. Destination host
    // unreachable." as a merged line inside the statistics block.
    expect(out).not.toMatch(/Request timed out\. Destination host unreachable\./);
    expect(out).toContain('Lost = 2 (100% loss)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test-NetConnection / Test-Connection — same resolver as ping
// ═══════════════════════════════════════════════════════════════════

async function buildDnsLab() {
  const win = new WindowsPC('windows-pc', 'WINPC', 0, 0);
  const dns = new LinuxServer('linux-server', 'DNS1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c-d').connect(dns.getPort('eth0')!, sw.getPort('eth1')!);
  win.configureInterface('eth0', new IPAddress('192.168.1.20'), new SubnetMask('255.255.255.0'));
  dns.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  await win.executeCommand('netsh interface ip set dns "Ethernet 0" static 192.168.1.10');
  dns.dnsService.addRecord({ name: 'webserver', type: 'A', value: '192.168.1.10', ttl: 3600 });
  dns.dnsService.start();
  return { win, dns };
}

describe('Test-NetConnection resolves DNS names like ping does', () => {
  it('interpreter path: PingSucceeded=True for a DNS-only name', async () => {
    const { win } = await buildDnsLab();
    // Sanity: cmd ping resolves it.
    const pingOut = await win.executeCommand('ping -n 1 webserver');
    expect(pingOut).toContain('Reply from 192.168.1.10');

    const out = await psShell(win)('Test-NetConnection webserver');
    expect(out).toContain('192.168.1.10');
    expect(out).toMatch(/PingSucceeded\s*:?\s*True/);
  });

  it('Test-Connection succeeds for a DNS-only name (interpreter path)', async () => {
    const { win } = await buildDnsLab();
    const out = await psShell(win)('Test-Connection webserver -Count 1');
    expect(out).toContain('192.168.1.10');
    expect(out).not.toContain('Failure');
  });
});
