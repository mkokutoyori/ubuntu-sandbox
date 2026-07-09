import { describe, it, expect, beforeEach } from 'vitest';
import { ghostRemainder, FullLineSource, LastWordSource } from '@/terminal/completion';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoTerminalSession, HuaweiTerminalSession } from '@/terminal/sessions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type GhostHandle = {
  input: string;
  isBooting?: boolean;
  getGhostSuggestion(): string | null;
  acceptGhost(): boolean;
  setGhostTextEnabled(v: boolean): void;
  isGhostTextEnabled(): boolean;
  toggleGhostText(): boolean;
};

describe('ghostRemainder (core)', () => {
  it('returns the remainder when exactly one candidate extends the input', () => {
    const source = new FullLineSource(() => ['show']);
    expect(ghostRemainder('sh', source)).toBe('ow');
  });

  it('returns null on ambiguity, empty input, or non-extending candidate', () => {
    expect(ghostRemainder('s', new FullLineSource(() => ['show', 'shutdown']))).toBeNull();
    expect(ghostRemainder('', new FullLineSource(() => ['show']))).toBeNull();
    expect(ghostRemainder('show', new FullLineSource(() => ['show']))).toBeNull();
    expect(ghostRemainder('xyz', new FullLineSource(() => []))).toBeNull();
  });

  it('works with last-word sources (keeps the left of the line)', () => {
    const source = new LastWordSource(() => ['ifconfig']);
    expect(ghostRemainder('sudo ifco', source)).toBe('nfig');
  });

  it('matches case-insensitively but keeps the candidate casing in the remainder', () => {
    const source = new FullLineSource(() => ['SELECT']);
    expect(ghostRemainder('sel', source)).toBe('ECT');
  });
});

describe('ghost suggestion — equipment sessions', () => {
  it('Cisco: typing "sh" shows the ghost "ow" and ArrowRight-accept applies it', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = false;
    s.setGhostTextEnabled(true);
    s.input = 'sh';
    expect(s.getGhostSuggestion()).toBe('ow');
    expect(s.acceptGhost()).toBe(true);
    expect(s.input).toBe('show');
  });

  it('Cisco: no ghost on ambiguous input', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = false;
    s.setGhostTextEnabled(true);
    s.input = 's';
    expect(s.getGhostSuggestion()).toBeNull();
    expect(s.acceptGhost()).toBe(false);
  });

  it('Cisco: no ghost while booting', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = true;
    s.setGhostTextEnabled(true);
    s.input = 'sh';
    expect(s.getGhostSuggestion()).toBeNull();
  });

  it('Huawei: typing "sys" shows the ghost for system-view', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = false;
    s.setGhostTextEnabled(true);
    s.input = 'sys';
    expect(s.getGhostSuggestion()).toBe('tem-view');
  });

  it('Cisco: ghost includes dynamic candidates (unique real interface)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle & {
      vty: { state: { mode: string } } | null;
    };
    s.isBooting = false;
    s.setGhostTextEnabled(true);
    if (s.vty) s.vty.state.mode = 'config';
    s.input = 'interface FastEthernet0/3';
    expect(s.getGhostSuggestion()).toBeNull();
    s.input = 'interface FastEthernet0/';
    expect(s.getGhostSuggestion()).toBeNull();
  });

  it('Linux: unique command ghost at the prompt', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const s = new LinuxTerminalSession('t1', pc) as unknown as GhostHandle;
    s.setGhostTextEnabled(true);
    s.input = 'ifco';
    expect(s.getGhostSuggestion()).toBe('nfig');
  });

  it('Linux: no ghost while a sub-shell is active', async () => {
    const pc = new LinuxPC('linux-pc', 'PC2');
    const s = new LinuxTerminalSession('t2', pc) as unknown as GhostHandle & {
      executeCommand(line: string): Promise<void>;
    };
    s.setGhostTextEnabled(true);
    await s.executeCommand('nslookup');
    s.input = 'ifco';
    expect(s.getGhostSuggestion()).toBeNull();
  });
});

describe('ghost text — per-terminal opt-in (default OFF)', () => {
  it('is disabled by default: no ghost even with a unique completion', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = false;
    s.input = 'sh';
    expect(s.isGhostTextEnabled()).toBe(false);
    expect(s.getGhostSuggestion()).toBeNull();
    expect(s.acceptGhost()).toBe(false);
  });

  it('enabling then disabling flips the ghost on and off', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as GhostHandle;
    s.isBooting = false;
    s.input = 'sh';
    s.setGhostTextEnabled(true);
    expect(s.getGhostSuggestion()).toBe('ow');
    s.setGhostTextEnabled(false);
    expect(s.getGhostSuggestion()).toBeNull();
  });

  it('toggleGhostText flips and returns the new state', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const s = new LinuxTerminalSession('t1', pc) as unknown as GhostHandle;
    s.input = 'ifco';
    expect(s.getGhostSuggestion()).toBeNull();
    expect(s.toggleGhostText()).toBe(true);
    expect(s.getGhostSuggestion()).toBe('nfig');
    expect(s.toggleGhostText()).toBe(false);
    expect(s.getGhostSuggestion()).toBeNull();
  });

  it('the opt-in is per-terminal: enabling one session does not affect another', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const a = new CiscoTerminalSession('a', sw) as unknown as GhostHandle;
    const b = new CiscoTerminalSession('b', sw) as unknown as GhostHandle;
    a.isBooting = false; b.isBooting = false;
    a.input = 'sh'; b.input = 'sh';
    a.setGhostTextEnabled(true);
    expect(a.getGhostSuggestion()).toBe('ow');
    expect(b.isGhostTextEnabled()).toBe(false);
    expect(b.getGhostSuggestion()).toBeNull();
  });
});
