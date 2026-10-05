import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function buildPair() {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  pc1.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  pc2.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
  return { pc1, pc2, cable };
}

describe('tc qdisc netem loss — the egress of a real interface on a real cable', () => {
  it('shows no impairment on a freshly-connected interface', async () => {
    const { pc1 } = buildPair();
    const out = await pc1.executeCommand('tc qdisc show dev eth0');
    expect(out).not.toMatch(/loss/);
  });

  it('add applies a real loss rate on the egress of the interface it names, and only there', async () => {
    const { pc1, pc2, cable } = buildPair();
    const out = await pc1.executeCommand('tc qdisc add dev eth0 root netem loss 20%');
    expect(out).toBe('');
    expect(cable.getEgressNetem(pc1.getPort('eth0')!)?.lossRate).toBeCloseTo(0.2);
    expect(cable.getEgressNetem(pc2.getPort('eth0')!)).toBeUndefined();
    expect(cable.getPacketLossRate()).toBe(0);

    const show = await pc1.executeCommand('tc qdisc show dev eth0');
    expect(show).toMatch(/netem/);
    expect(show).toMatch(/loss 20%/);
    expect(await pc2.executeCommand('tc qdisc show dev eth0')).not.toMatch(/netem/);
  });

  it('change updates an already-configured loss rate', async () => {
    const { pc1, cable } = buildPair();
    await pc1.executeCommand('tc qdisc add dev eth0 root netem loss 20%');
    await pc1.executeCommand('tc qdisc change dev eth0 root netem loss 50%');
    expect(cable.getEgressNetem(pc1.getPort('eth0')!)?.lossRate).toBeCloseTo(0.5);
  });

  it('del removes the qdisc', async () => {
    const { pc1, cable } = buildPair();
    await pc1.executeCommand('tc qdisc add dev eth0 root netem loss 20%');
    await pc1.executeCommand('tc qdisc del dev eth0 root');
    expect(cable.getEgressNetem(pc1.getPort('eth0')!)).toBeUndefined();
    expect(await pc1.executeCommand('tc qdisc show dev eth0')).not.toMatch(/netem/);
  });

  it('accepts a combined delay+loss spec: the loss acts on the wire, the delay is kept as RTT metadata', async () => {
    const { pc1, cable } = buildPair();
    await pc1.executeCommand('tc qdisc add dev eth0 root netem delay 200ms loss 10%');
    const spec = cable.getEgressNetem(pc1.getPort('eth0')!);
    expect(spec?.lossRate).toBeCloseTo(0.1);
    expect(spec?.delayMs).toBe(200);
  });

  it('reports an error for an interface that does not exist', async () => {
    const { pc1 } = buildPair();
    const out = await pc1.executeCommand('tc qdisc add dev eth9 root netem loss 10%');
    expect(out).toMatch(/Cannot find device/);
  });

  it('reports an error for an interface with no cable connected', async () => {
    const pc = new LinuxPC('linux-pc', 'PC3');
    const out = await pc.executeCommand('tc qdisc add dev eth0 root netem loss 10%');
    expect(out).toMatch(/not connected to a cable/);
  });

  it('the configured loss rate actually drops frames on the wire (deterministic RNG)', async () => {
    const { pc1, cable } = buildPair();
    await pc1.executeCommand('tc qdisc add dev eth0 root netem loss 50%');

    cable.setRng(() => 0); // always below any positive loss rate → always drop
    const lossy = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(lossy).toContain('100% packet loss');

    cable.setRng(() => 0.99); // always above → never drop
    const clean = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(clean).toContain('0% packet loss');
  });
});
