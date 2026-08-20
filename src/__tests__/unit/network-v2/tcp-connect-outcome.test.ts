import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

async function buildPair() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { pc, srv };
}

const TARGET = new IPAddress('10.0.0.2');

describe('EndHost.tcpConnectOutcome — result derived from the wire (RFC 793)', () => {
  it("reports 'open' when the destination has a listener (sshd on 22)", async () => {
    const { pc } = await buildPair();
    expect(pc.tcpConnectOutcome(TARGET, 22)).toBe('open');
  });

  it("reports 'refused' when the destination sends a RST (no listener)", async () => {
    const { pc } = await buildPair();
    expect(pc.tcpConnectOutcome(TARGET, 9999)).toBe('refused');
  });

  it("reports 'timeout' when the destination host firewall silently drops the SYN", async () => {
    const { pc, srv } = await buildPair();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
    expect(pc.tcpConnectOutcome(TARGET, 22)).toBe('timeout');
  });

  it("reports 'refused' when the destination host firewall rejects the SYN (ICMP)", async () => {
    const { pc, srv } = await buildPair();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
    expect(pc.tcpConnectOutcome(TARGET, 22)).toBe('refused');
  });

  it("reports 'timeout' when there is no route to the destination", async () => {
    const { pc } = await buildPair();
    expect(pc.tcpConnectOutcome(new IPAddress('192.0.2.99'), 22)).toBe('timeout');
  });

  it('leaves no established or half-open socket behind after a probe (TIME-WAIT only)', async () => {
    const { pc } = await buildPair();
    pc.tcpConnectOutcome(TARGET, 22);
    const live = pc.getTcpStack().listSockets()
      .filter((s) => s.state === 'established' || s.state === 'syn-sent' || s.state === 'syn-received');
    expect(live).toHaveLength(0);
  });
});
