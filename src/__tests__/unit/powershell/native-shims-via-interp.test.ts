/**
 * Native CLI commands as interpreter cmdlets (Phase 4b). Pins the
 * behaviour so future bypass-list trims don't accidentally regress.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell() {
  const pc = new WindowsPC('windows-pc', 'WIN-NATIVE');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('Native CLI shims via interpreter', () => {
  it('ipconfig produces adapter information', async () => {
    const sh = createShell();
    const out = await run(sh, 'ipconfig');
    expect(out.toLowerCase()).toMatch(/ipv4|ethernet|adapter/);
  });

  it('ver returns the Windows version string', async () => {
    const sh = createShell();
    const out = await run(sh, 'ver');
    expect(out.toLowerCase()).toContain('microsoft windows');
  });

  it('systeminfo returns rich host info', async () => {
    const sh = createShell();
    const out = await run(sh, 'systeminfo');
    expect(out.toLowerCase()).toMatch(/host name|os name|microsoft windows/);
  });

  it('arp -a shows the ARP table or an empty header', async () => {
    const sh = createShell();
    const out = await run(sh, 'arp -a');
    expect(out.toLowerCase()).toMatch(/internet address|no arp entries|interface/);
  });

  it('route print returns the routing table header', async () => {
    const sh = createShell();
    const out = await run(sh, 'route print');
    expect(out.toLowerCase()).toMatch(/active routes|interface list|network destination/);
  });

  it('getmac returns at least one MAC row', async () => {
    const sh = createShell();
    const out = await run(sh, 'getmac');
    expect(out).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/i);
  });

  it('netsh interface show interface lists the interfaces', async () => {
    const sh = createShell();
    const out = await run(sh, 'netsh interface show interface');
    expect(out.toLowerCase()).toMatch(/admin state|interface/);
  });
});
