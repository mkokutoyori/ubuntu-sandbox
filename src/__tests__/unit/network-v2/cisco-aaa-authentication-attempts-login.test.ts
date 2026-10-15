/**
 * Cisco IOS Security Command Reference: `aaa authentication attempts login number-of-attempts` (1-25) — "the
 * maximum number of unsuccessful login attempts that are permitted on a line before it is closed". Without it a
 * vty gives three attempts. The CIS benchmark audits this value on bank routers.
 *
 * Lab: a Cisco router with a local user and vty lines open to telnet and SSH, reached by a LinuxPC over a real
 * cable. The probe counts what the client sees: how many wrong passwords the line tolerates, then whether the
 * right one is still accepted.
 *
 * Ours, not in the reference: SSH uses the lesser of this value and `ip ssh authentication-retries`.
 *
 * Measured with src stashed to HEAD: the command was refused (Invalid input), so 4 of the 6 cases fall (limit 5,
 * limit 2, range/running-config/no form, help). Witnesses: the default of three tries, and the SSH case, whose
 * scripted client does not retry, so it cannot discriminate and only guards against a regression.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function lab(extra: string[] = []): Promise<{ router: CiscoRouter; pc: LinuxPC }> {
  const router = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P1');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, router.getPorts()[0]);
  for (const line of [
    'enable', 'configure terminal', 'hostname R1', 'ip domain-name lab',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'exit',
    'crypto key generate rsa modulus 2048', ...extra, 'end',
  ]) await router.executeCommand(line);
  for (let i = 0; i < 14; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
  return { router, pc };
}

const wrong = (count: number): string => 'admin\nnope\n'.repeat(count);

describe('aaa authentication attempts login', () => {
  it('witness (default, passes either way): three wrong passwords close the line before the right one', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('telnet 10.0.0.2', `${wrong(3)}admin\ncisco\nshow clock\nexit\n`);
    expect(out).toContain('% Bad passwords');
    expect(out).not.toMatch(/UTC/);
  });

  it('a limit of 5 tolerates four wrong passwords and then lets the right one in', async () => {
    const { pc } = await lab(['aaa authentication attempts login 5']);
    const out = await pc.executeCommand('telnet 10.0.0.2', `${wrong(4)}admin\ncisco\nshow clock\nexit\n`);
    expect(out).not.toContain('% Bad passwords');
    expect(out).toMatch(/UTC/);
  });

  it('a limit of 2 closes the line at the second wrong password', async () => {
    const { pc } = await lab(['aaa authentication attempts login 2']);
    const out = await pc.executeCommand('telnet 10.0.0.2', `${wrong(2)}admin\ncisco\nshow clock\nexit\n`);
    expect(out).toContain('% Bad passwords');
    expect(out).not.toMatch(/UTC/);
  });

  it('witness (passes either way, the scripted ssh client never retries): SSH with a limit of 1 does not let a wrong first password through', async () => {
    const { pc } = await lab(['aaa authentication attempts login 1']);
    const out = await pc.executeCommand('ssh admin@10.0.0.2', 'nope\ncisco\nshow clock\nexit\n');
    expect(out).not.toMatch(/UTC/);
  });

  it('the value is range-checked, shown in the running-config and removed by its no form', async () => {
    const { router } = await lab();
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    expect(await router.executeCommand('aaa authentication attempts login 26')).toContain('Invalid input');
    expect(await router.executeCommand('aaa authentication attempts login 0')).toContain('Invalid input');
    await router.executeCommand('aaa authentication attempts login 7');
    expect(await router.executeCommand('do show running-config | include attempts')).toContain('aaa authentication attempts login 7');
    await router.executeCommand('no aaa authentication attempts login');
    expect(await router.executeCommand('do show running-config | include attempts')).not.toContain('attempts login');
  });

  it('help names the range', async () => {
    const { router } = await lab();
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    expect(await router.executeCommand('aaa authentication attempts login ?')).toContain('<1-25>');
  });
});
