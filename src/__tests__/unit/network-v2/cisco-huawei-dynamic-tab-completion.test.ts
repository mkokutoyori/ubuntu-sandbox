import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoTerminalSession, HuaweiTerminalSession } from '@/terminal/sessions';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type CliSessionHandle = {
  input: string;
  onTab(reverse?: boolean): void;
};

describe('Dynamic Tab candidates — Cisco (PRD item 2)', () => {
  it('cliTabCandidates lists the real ports of the device after "interface"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const candidates = sw.cliTabCandidates('interface Fa');
    expect(candidates).toContain('interface FastEthernet0/1');
    expect(candidates).toContain('interface FastEthernet0/8');
  });

  it('a unique real interface completes via Tab at the session level', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const candidates = sw.cliTabCandidates('interface FastEthernet0/3');
    expect(candidates).toEqual(['interface FastEthernet0/3']);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle & {
      vty: { state: { mode: string } } | null;
    };
    if (s.vty) s.vty.state.mode = 'config';
    s.input = 'interface FastEthernet0/3';
    s.onTab();
    expect(s.input).toBe('interface FastEthernet0/3 ');
  });

  it('cliTabCandidates lists only VLANs that really exist after "vlan"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('exit');
    const candidates = sw.cliTabCandidates('vlan 1');
    expect(candidates).toContain('vlan 1');
    expect(candidates).toContain('vlan 10');
    expect(candidates).not.toContain('vlan 20');
    expect(candidates.some(c => c === 'vlan 15')).toBe(false);
  });

  it('the ? help after "interface " includes the real ports', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const help = sw.cliHelp('interface ');
    expect(help).toContain('FastEthernet0/1');
    expect(help).toContain('FastEthernet0/8');
  });

  it('works for routers too (real router port names)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const names = r.getPorts().map(p => p.getName());
    expect(names.length).toBeGreaterThan(0);
    const candidates = r.cliTabCandidates(`interface ${names[0]}`);
    expect(candidates).toContain(`interface ${names[0]}`);
  });

  it('static keyword completion is untouched (regression control)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    expect(sw.cliTabComplete('sh')).toBe('show ');
    expect(sw.cliTabComplete('s')).toBeNull();
  });

  it('Cisco session: ambiguous Tab stays a silent no-op', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    expect(s.input).toBe('s');
  });

  it('Cisco session: unique prefix still completes through the vty path', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 'sh';
    s.onTab();
    expect(s.input).toBe('show ');
  });
});

describe('Dynamic Tab candidates — Huawei (PRD items 2 et 3)', () => {
  it('cliTabCandidates lists the real ports after "interface"', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
    const realPorts = sw.getPorts().map(p => p.getName()).filter(n => n.startsWith('Gig'));
    expect(realPorts.length).toBeGreaterThan(0);
    const candidates = sw.cliTabCandidates('interface Gig');
    for (const name of realPorts) {
      expect(candidates).toContain(`interface ${name}`);
    }
  });

  it('cliTabCandidates lists only existing VLANs after "vlan"', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
    sw.executeCommand('vlan batch 10 30');
    const candidates = sw.cliTabCandidates('vlan 3');
    expect(candidates).toContain('vlan 30');
    expect(candidates).not.toContain('vlan 20');
  });

  it('Huawei session: repeated Tab CYCLES ambiguous candidates (real VRP behavior)', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    expect(sw.cliTabCandidates('s').length).toBeGreaterThan(1);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    const first = s.input;
    expect(first).not.toBe('s');
    s.onTab();
    const second = s.input;
    expect(second).not.toBe(first);
    expect(second.toLowerCase().startsWith('s')).toBe(true);
  });

  it('Huawei session: Shift+Tab cycles backward', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    const first = s.input;
    s.onTab();
    s.onTab(true);
    expect(s.input).toBe(first);
  });

  it('Huawei session: unique candidate still completes with a trailing space', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 'sys';
    s.onTab();
    expect(s.input).toBe('system-view ');
  });

  it('shell-level tabComplete contract is unchanged: ambiguous → null (trie level)', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    expect(sw.cliTabComplete('s')).toBeNull();
  });
});
