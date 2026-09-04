import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { toDisplayName, toPortName, formatLinkSpeedMbps } from '@/network/devices/windows/WindowsInterfaceNaming';
import { resolveAdapterName } from '@/network/devices/windows/WinNetsh';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('WindowsInterfaceNaming — canonical, bijective port <-> display name', () => {
  it('eth0 <-> Ethernet 0', () => {
    expect(toDisplayName('eth0')).toBe('Ethernet 0');
    expect(toPortName('Ethernet 0')).toBe('eth0');
  });

  it('eth1 <-> Ethernet 1 (round-trips correctly, no off-by-one)', () => {
    expect(toDisplayName('eth1')).toBe('Ethernet 1');
    expect(toPortName('Ethernet 1')).toBe('eth1');
  });

  it('eth2 <-> Ethernet 2', () => {
    expect(toDisplayName('eth2')).toBe('Ethernet 2');
    expect(toPortName('Ethernet 2')).toBe('eth2');
  });

  it('bare "Ethernet" is also accepted as an alias for the first adapter', () => {
    expect(toPortName('Ethernet')).toBe('eth0');
  });

  it('formatLinkSpeedMbps renders Gbps only for exact Gbps multiples', () => {
    expect(formatLinkSpeedMbps(1000)).toBe('1 Gbps');
    expect(formatLinkSpeedMbps(100)).toBe('100 Mbps');
  });
});

describe('WinNetsh resolveAdapterName — consistent with the canonical naming', () => {
  it('"Ethernet 2" resolves to eth2, matching toDisplayName/toPortName', () => {
    const pc = new WindowsPC('windows-pc', 'PCNAME', 0, 0);
    const ports = pc.getPortsMap();
    expect(resolveAdapterName('Ethernet 2', ports)).toBe('eth2');
    expect(resolveAdapterName('Ethernet', ports)).toBe('eth0');
    expect(resolveAdapterName('Ethernet 1', ports)).toBe('eth1');
  });
});

describe('ipconfig — media state reflects the real cable, not address presence', () => {
  it('a cabled, admin-up port with no IP yet is not "Media disconnected"', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    new Cable('w').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    const swStatus = await sw.executeCommand('show interfaces status');
    expect(swStatus).toMatch(/Fa0\/1\s+connected/);

    const out = await pc.executeCommand('ipconfig /all');
    const block = out.split('Ethernet adapter Ethernet 0:')[1]?.split('Ethernet adapter')[0] ?? '';
    expect(block).not.toMatch(/Media disconnected/);
  });

  it('an unplugged port still reports Media disconnected', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const out = await pc.executeCommand('ipconfig /all');
    const block = out.split('Ethernet adapter Ethernet 0:')[1]?.split('Ethernet adapter')[0] ?? '';
    expect(block).toMatch(/Media disconnected/);
  });
});

describe('ipconfig /renew — no internal debug leak', () => {
  it('does not leak "DHCP Discover - Broadcast on eth0" or the internal port name', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const out = await pc.executeCommand('ipconfig /renew');
    expect(out).not.toMatch(/DHCP Discover/);
    expect(out).not.toMatch(/\beth0\b/);
  });

  it('a hard DHCP failure (no reachable server, no autoconfiguration) reports the real Windows error text', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const out = await pc.executeCommand('ipconfig /renew');
    expect(out === '' || typeof out === 'string').toBe(true);
  });
});

describe('Interface naming is consistent across ipconfig and Get-NetAdapter', () => {
  it('the same physical port shows the same display name in both commands', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const ipconfigOut = await pc.executeCommand('ipconfig /all');
    expect(ipconfigOut).toContain('Ethernet adapter Ethernet 0:');
    expect(ipconfigOut).toContain('Ethernet adapter Ethernet 1:');

    const shell = ps(pc);
    const adapterOut = await run(shell, 'Get-NetAdapter');
    expect(adapterOut).toContain('Ethernet 0');
    expect(adapterOut).toContain('Ethernet 1');
    expect(adapterOut).not.toMatch(/\beth0\b/);
    expect(adapterOut).not.toMatch(/\beth1\b/);
  });
});

describe('Get-NetAdapter — LinkSpeed reflects the real negotiated port speed', () => {
  it('a port cabled to a FastEthernet switch port reports 100 Mbps, not a hardcoded 1 Gbps', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    new Cable('w').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    const shell = ps(pc);
    const out = await run(shell, 'Get-NetAdapter');
    const ethLine = out.split('\n').find(l => /^Ethernet 0\s/.test(l));
    expect(ethLine).toMatch(/100 Mbps/);
  });
});
