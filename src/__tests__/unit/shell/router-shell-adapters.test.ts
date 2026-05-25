import { describe, expect, beforeEach, test } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { ShellFactory } from '@/shell/ShellFactory';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';

describe('Phase 1B router adapters wired into the factory', () => {
  beforeEach(() => {
    EquipmentRegistry.getInstance().clear();
    reinstallDefaultShells();
  });

  test('cisco-ios is registered and reports the IOS prompt', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    expect(ShellFactory.has('cisco-ios')).toBe(true);
    const shell = ShellFactory.create('cisco-ios', { device: r, user: 'admin' });
    expect(shell.kind).toBe('cisco-ios');
    expect(shell.getPrompt()).toMatch(/R1[#>]/);
  });

  test('huawei-vrp is registered and reports the VRP prompt', async () => {
    const r = new HuaweiRouter('HW1', 0, 0);
    expect(ShellFactory.has('huawei-vrp')).toBe(true);
    const shell = ShellFactory.create('huawei-vrp', { device: r, user: 'admin' });
    expect(shell.kind).toBe('huawei-vrp');
    expect(shell.getPrompt()).toMatch(/<HW1>/);
  });

  test('cisco-ios honours `quit` as an exit word (VRP-style alias)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    const shell = ShellFactory.create('cisco-ios', { device: r, user: 'admin' });
    shell.activate();
    const result = await shell.processLine('quit');
    expect(result.exit).toBe(true);
  });

  test('huawei-vrp honours both `quit` and `exit`', async () => {
    const r = new HuaweiRouter('HW1', 0, 0);
    const shell = ShellFactory.create('huawei-vrp', { device: r, user: 'admin' });
    shell.activate();
    expect((await shell.processLine('quit')).exit).toBe(true);
    expect((await shell.processLine('exit')).exit).toBe(true);
  });

  test('CrossVendorRemoteShell can host a cisco-ios primary now', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    const x = new CrossVendorRemoteShell({
      device: r, user: 'admin', remoteHost: '10.0.0.5', primaryKind: 'cisco-ios',
    });
    expect(x.getPrompt()).toMatch(/R1[#>]/);
  });

  test('CrossVendorRemoteShell can host a huawei-vrp primary now', async () => {
    const r = new HuaweiRouter('HW1', 0, 0);
    const x = new CrossVendorRemoteShell({
      device: r, user: 'admin', remoteHost: '10.0.0.6', primaryKind: 'huawei-vrp',
    });
    expect(x.getPrompt()).toMatch(/<HW1>/);
  });
});
