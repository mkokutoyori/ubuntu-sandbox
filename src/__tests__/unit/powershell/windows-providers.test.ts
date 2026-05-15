/**
 * Smoke test for WindowsPSProviders — confirms that a PSInterpreter wired to
 * a real WindowsPC's managers can read/write the same simulated state as the
 * device (Phase 1 of the executor → interpreter migration).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function setup(): { pc: WindowsPC; interp: PSInterpreter } {
  const pc = new WindowsPC('windows-pc', 'WIN-PROV');
  pc.setCurrentUser('Administrator');
  const interp = new PSInterpreter(createWindowsPSProviders(pc));
  return { pc, interp };
}

describe('WindowsPSProviders — filesystem', () => {
  it('Set-Content writes to the device filesystem', () => {
    const { pc, interp } = setup();
    interp.executeInteractive('New-Item -Path C:\\probe -ItemType Directory -Force | Out-Null');
    interp.executeInteractive('Set-Content -Path C:\\probe\\hello.txt -Value "via interpreter"');
    const r = pc.getFileSystem().readFile('C:\\probe\\hello.txt');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('via interpreter');
  });

  it('Get-Content reads from the device filesystem', () => {
    const { pc, interp } = setup();
    pc.getFileSystem().mkdirp('C:\\probe');
    pc.getFileSystem().createFile('C:\\probe\\there.txt', 'planted by device');
    const out = interp.executeInteractive('Get-Content C:\\probe\\there.txt');
    expect(out).toContain('planted by device');
  });

  it('Test-Path reflects device filesystem state', () => {
    const { pc, interp } = setup();
    pc.getFileSystem().mkdirp('C:\\Windows\\System32');
    expect(interp.executeInteractive('Test-Path C:\\Windows\\System32').trim()).toBe('True');
    expect(interp.executeInteractive('Test-Path C:\\nope\\nope').trim()).toBe('False');
  });
});

// Provider-surface tests — Get-Service / Get-LocalUser cmdlets aren't migrated
// to the interpreter yet (Phase 2). For now we exercise the provider directly
// to confirm the device is plumbed in.
describe('WindowsPSProviders — services / users surfaces', () => {
  it('IServiceProvider.listServices returns built-ins from the device', () => {
    const pc = new WindowsPC('windows-pc', 'WIN-SVC');
    const services = createWindowsPSProviders(pc).services!.listServices();
    expect(services.length).toBeGreaterThan(0);
    expect(services[0]).toHaveProperty('name');
  });

  it('IUserProvider.listUsers includes Administrator', () => {
    const pc = new WindowsPC('windows-pc', 'WIN-USR');
    const users = createWindowsPSProviders(pc).users!.listUsers();
    expect(users.map(u => u.name.toLowerCase())).toContain('administrator');
  });
});

describe('AST cache', () => {
  it('repeated executeInteractive of the same source is fast', () => {
    const { interp } = setup();
    // Warm up
    interp.executeInteractive('1..10 | Measure-Object -Sum');
    // Same string 200 times — should be near-instant with the cache.
    const start = Date.now();
    for (let i = 0; i < 200; i++) interp.executeInteractive('1..10 | Measure-Object -Sum');
    const elapsed = Date.now() - start;
    // Without cache this used to take seconds; the cache should keep it under
    // a second on any halfway-reasonable machine.
    expect(elapsed).toBeLessThan(2000);
  });
});
