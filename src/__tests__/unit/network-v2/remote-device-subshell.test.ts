import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import {
  RemoteDeviceSubShell,
  CiscoPromptStrategy, HuaweiPromptStrategy, LinuxPromptStrategy,
} from '@/terminal/subshells/RemoteDeviceSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  EquipmentRegistry.resetInstance();
});

describe('RemoteDeviceSubShell — vendor-neutral interactive shell', () => {
  it('forwards Cisco IOS commands to the router and renders `Router#`', async () => {
    const router = new CiscoRouter('ciscoR1', 0, 0);
    router.setHostname('ciscoR1');
    const sub = new RemoteDeviceSubShell(router, 'admin', '10.0.0.6', CiscoPromptStrategy);
    expect(sub.getPrompt()).toBe('ciscoR1#');
    const r = await sub.processLine('show version');
    expect(r.exit).toBe(false);
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.output.join('\n')).toMatch(/IOS|Cisco|Version/i);
  });

  it('forwards Huawei VRP commands and renders `<hostname>`', async () => {
    const router = new HuaweiRouter('hwR1', 0, 0);
    router.setHostname('hwR1');
    const sub = new RemoteDeviceSubShell(router, 'admin', '10.0.0.8', HuaweiPromptStrategy);
    expect(sub.getPrompt()).toBe('<hwR1>');
    const r = await sub.processLine('display version');
    expect(r.exit).toBe(false);
    expect(r.output.join('\n')).toMatch(/VRP|Huawei|Version/i);
  });

  it('returns to caller on `exit` / `logout` / `quit` per strategy', async () => {
    const router = new CiscoRouter('ciscoR1', 0, 0);
    const sub = new RemoteDeviceSubShell(router, 'admin', '10.0.0.6', CiscoPromptStrategy);
    const r = await sub.processLine('quit');
    expect(r.exit).toBe(true);
    expect(r.output.join('\n')).toMatch(/closed/);
  });

  it('calls onExit when the user logs out', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    let popped = false;
    const sub = new RemoteDeviceSubShell(pc, 'alice', '10.0.0.2', LinuxPromptStrategy, () => { popped = true; });
    await sub.processLine('exit');
    expect(popped).toBe(true);
  });

  it('Ctrl+D triggers exit via handleKey', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const sub = new RemoteDeviceSubShell(pc, 'alice', '10.0.0.2');
    expect(sub.handleKey({ key: 'd', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })).toBe(true);
    expect(sub.handleKey({ key: 'd', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });
});
