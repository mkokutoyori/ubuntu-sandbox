import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';
import {
  CiscoPromptStrategy,
  HuaweiPromptStrategy,
  WindowsPromptStrategy,
} from '@/terminal/subshells/RemoteDeviceSubShell';

describe('Phase 1B Linux pushRemoteDeviceWithStrategy uses CrossVendorRemoteShell', () => {
  beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

  test('Cisco target push wraps the new CrossVendorRemoteShell via adapter', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const ciscoR = new CiscoRouter('ciscoR', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(linuxA.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(ciscoR.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    term.pushRemoteDeviceWithStrategy(ciscoR, 'admin', '10.0.0.5', CiscoPromptStrategy);

    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect((active as ShellSubShellAdapter).inner.kind).toBe('ssh-remote');
    expect(term.getPrompt()).toMatch(/ciscoR[#>]/);
  });

  test('Huawei target push lands on `<HW1>` prompt via the new layer', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const hwR = new HuaweiRouter('HW1', 0, 0);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    term.pushRemoteDeviceWithStrategy(hwR, 'admin', '10.0.0.6', HuaweiPromptStrategy);

    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect(term.getPrompt()).toMatch(/<HW1>/);
  });

  test('Windows target push lands on the cmd prompt via the new layer', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const winB = new WindowsPC('windows-pc', 'winB', 0, 0);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    term.pushRemoteDeviceWithStrategy(winB, 'User', '10.0.0.4', WindowsPromptStrategy);

    expect(term.getPrompt()).toMatch(/C:\\Users\\User>/);
  });
});
