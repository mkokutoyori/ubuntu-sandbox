import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topo(): { a: LinuxPC; b: LinuxPC; cable: Cable } {
  const a = new LinuxPC('linux-pc', 'PC1');
  const b = new LinuxPC('linux-pc', 'PC2');
  a.configureInterface('eth0', new IPAddress('10.0.9.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.9.2'), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  return { a, b, cable };
}

describe('ip link reflects carrier loss (docs/PRD-Link-State.md §4 #3, P2)', () => {
  it('shows NO-CARRIER and state DOWN once the cable is unplugged', async () => {
    const { a, cable } = topo();
    cable.disconnect();
    const out = await a.executeCommand('ip link show eth0');
    expect(out).toContain('NO-CARRIER');
    expect(out).toContain('state DOWN');
  });

  it('does not show NO-CARRIER while the cable is plugged in', async () => {
    const { a } = topo();
    const out = await a.executeCommand('ip link show eth0');
    expect(out).not.toContain('NO-CARRIER');
    expect(out).toContain('state UP');
    expect(out).toContain('LOWER_UP');
  });

  it('keeps the admin UP flag after an unplug — the interface is not shut down', async () => {
    const { a, cable } = topo();
    cable.disconnect();
    const out = await a.executeCommand('ip link show eth0');
    expect(out).toMatch(/<[^>]*\bUP\b[^>]*>/);
  });

  it('an administratively downed interface is not reported as NO-CARRIER', async () => {
    const { a } = topo();
    await a.executeCommand('ip link set eth0 down');
    const out = await a.executeCommand('ip link show eth0');
    expect(out).not.toContain('NO-CARRIER');
  });
});

describe('sysfs mirrors the real carrier (docs/PRD-Link-State.md §4 #4, P2)', () => {
  it('carrier is 1 and operstate up while cabled', async () => {
    const { a } = topo();
    expect((await a.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('1');
    expect((await a.executeCommand('cat /sys/class/net/eth0/operstate')).trim()).toBe('up');
  });

  it('carrier drops to 0 and operstate to down once unplugged', async () => {
    const { a, cable } = topo();
    cable.disconnect();
    expect((await a.executeCommand('cat /sys/class/net/eth0/carrier')).trim()).toBe('0');
    expect((await a.executeCommand('cat /sys/class/net/eth0/operstate')).trim()).toBe('down');
  });
});
