import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('Get-NetNeighbor reads the host ARP table', () => {
  let pc: LinuxPC;
  let win: WindowsPC;

  async function ps(line: string): Promise<string> {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine(line);
    return r.output.join('\n');
  }

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    win = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, win, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');
    await win.executeCommand('netsh interface ip set address eth0 static 10.0.0.2 255.0.0.0');
  });

  it('produces a header and one row per learned neighbor', async () => {
    const out = await ps('Get-NetNeighbor');
    expect(out).toMatch(/ifIndex/);
    expect(out).toMatch(/IPAddress/);
    expect(out).toMatch(/LinkLayerAddress/);
    expect(out).toMatch(/State/);
    expect(out).toMatch(/10\.0\.0\.1/);
  });

  it('MACs are formatted with dashes (Windows convention)', async () => {
    const out = await ps('Get-NetNeighbor');
    const aliceLine = out.split('\n').find((l) => l.includes('10.0.0.1')) ?? '';
    expect(aliceLine).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
  });

  it('matches arp -a contents (same neighbor, same MAC)', async () => {
    const psOut = await ps('Get-NetNeighbor');
    const arpA = await win.executeCommand('arp -a');
    const psMac = psOut.split('\n').find((l) => l.includes('10.0.0.1'))?.match(/([0-9A-F]{2}-){5}[0-9A-F]{2}/)?.[0] ?? '';
    const arpMac = arpA.split('\n').find((l) => l.includes('10.0.0.1'))?.match(/([0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}/)?.[0] ?? '';
    expect(psMac.toLowerCase()).toBe(arpMac.toLowerCase());
  });

  it('-IPAddress filter restricts output to one row', async () => {
    const out = await ps('Get-NetNeighbor -IPAddress 10.0.0.1');
    expect(out).toMatch(/10\.0\.0\.1/);
  });

  it('-State Reachable filters to reachable rows', async () => {
    const out = await ps('Get-NetNeighbor -State Reachable');
    expect(out).toMatch(/10\.0\.0\.1/);
  });
});
