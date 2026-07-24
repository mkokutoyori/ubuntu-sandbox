import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

function topo(): { a: LinuxPC; b: LinuxPC; cable: Cable } {
  const a = new LinuxPC('linux-pc', 'PC1');
  const b = new LinuxPC('linux-pc', 'PC2');
  a.configureInterface('eth0', new IPAddress('10.0.5.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.5.2'), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  return { a, b, cable };
}

describe('established TCP sessions die with the link (docs/PRD-Link-State.md §4 #9, P5)', () => {
  it('an established connection is torn down when the cable is pulled', () => {
    const { a, b, cable } = topo();
    b.getTcpStack().listen(9000, { onAccept: () => {} });

    const sock = a.getTcpStack().connect('10.0.5.2', 9000);
    expect(sock).not.toBeNull();
    expect(a.getTcpStack().listSockets().length).toBeGreaterThan(0);

    cable.disconnect();

    expect(a.getTcpStack().listSockets()).toHaveLength(0);
  });

  it('the peer end is torn down too', () => {
    const { a, b, cable } = topo();
    b.getTcpStack().listen(9000, { onAccept: () => {} });
    a.getTcpStack().connect('10.0.5.2', 9000);
    expect(b.getTcpStack().listSockets().length).toBeGreaterThan(0);

    cable.disconnect();

    expect(b.getTcpStack().listSockets()).toHaveLength(0);
  });

  it('listeners survive — a server keeps its bound port across a link failure', () => {
    const { b, cable } = topo();
    b.getTcpStack().listen(9000, { onAccept: () => {} });
    cable.disconnect();
    expect(b.getTcpStack().listListeners().map((l) => l.localPort)).toContain(9000);
  });

  it('a session over a still-connected interface is not disturbed', () => {
    const a = new LinuxPC('linux-pc', 'PC1');
    const b = new LinuxPC('linux-pc', 'PC2');
    const c = new LinuxPC('linux-pc', 'PC3');
    const mask = new SubnetMask('255.255.255.0');
    a.configureInterface('eth0', new IPAddress('10.0.5.1'), mask);
    a.configureInterface('eth1', new IPAddress('10.0.4.1'), mask);
    b.configureInterface('eth0', new IPAddress('10.0.5.2'), mask);
    c.configureInterface('eth0', new IPAddress('10.0.4.2'), mask);
    const keep = new Cable('c1');
    keep.connect(a.getPort('eth0')!, b.getPort('eth0')!);
    const doomed = new Cable('c2');
    doomed.connect(a.getPort('eth1')!, c.getPort('eth0')!);

    b.getTcpStack().listen(9000, { onAccept: () => {} });
    a.getTcpStack().connect('10.0.5.2', 9000);
    const before = a.getTcpStack().listSockets().length;
    expect(before).toBeGreaterThan(0);

    doomed.disconnect();

    expect(a.getTcpStack().listSockets()).toHaveLength(before);
  });
});
