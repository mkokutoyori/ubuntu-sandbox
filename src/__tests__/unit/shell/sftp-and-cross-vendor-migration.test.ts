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
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';

describe('Linux ssh push lands on the remote real session for every vendor', () => {
  beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

  test('Cisco target push lands on a real CiscoTerminalSession', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const ciscoR = new CiscoRouter('ciscoR', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(linuxA.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(ciscoR.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    const child = createSessionForDevice(ciscoR, 'c')!;
    term.adoptRemoteChild(child, 'admin', '10.0.0.5');

    expect(term.foreground).toBeInstanceOf(CiscoTerminalSession);
    expect(term.foreground.isRemoteChild).toBe(true);
    expect(term.foreground.getPrompt()).toMatch(/ciscoR[#>]/);
  });

  test('Huawei target push lands on a real HuaweiTerminalSession', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const hwR = new HuaweiRouter('HW1', 0, 0);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    const child = createSessionForDevice(hwR, 'c')!;
    term.adoptRemoteChild(child, 'admin', '10.0.0.6');

    expect(term.foreground).toBeInstanceOf(HuaweiTerminalSession);
    expect(term.foreground.isRemoteChild).toBe(true);
    expect(term.foreground.getPrompt()).toMatch(/<HW1>/);
  });

  test('Windows target push lands on a real WindowsTerminalSession with the right user prompt', async () => {
    const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const winB = new WindowsPC('windows-pc', 'winB', 0, 0);

    const term = new LinuxTerminalSession('t', linuxA);
    await term.init();
    const child = createSessionForDevice(winB, 'c')!;
    term.adoptRemoteChild(child, 'User', '10.0.0.4');

    expect(term.foreground).toBeInstanceOf(WindowsTerminalSession);
    expect(term.foreground.isRemoteChild).toBe(true);
    expect(term.foreground.getPrompt()).toMatch(/C:\\Users\\User>/);
  });
});
