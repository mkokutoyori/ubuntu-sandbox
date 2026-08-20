/**
 * FHRP data plane — the part that makes HSRP/VRRP/GLBP actually usable
 * as a default gateway, beyond the control-plane election:
 *
 *  - the active/master answers ARP for the VIP with the VIRTUAL MAC
 *    (RFC 2281 §5.3, RFC 5798 §8.1.2), sourced from the virtual MAC;
 *  - frames addressed to an owned virtual MAC are accepted and routed;
 *  - IP packets destined to an owned VIP are delivered locally
 *    (ICMP echo against the gateway VIP);
 *  - a gratuitous ARP announces the virtual MAC on takeover
 *    (RFC 5798 §6.4.1);
 *  - GLBP's AVG hands out AVF virtual MACs per load-balancing mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function configureHsrp(
  r: CiscoRouter, iface: string, ip: string, group: number, vip: string,
  priority: number, preempt = true,
): Promise<void> {
  r.getPort(iface)!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
  await run(r, [
    'enable', 'configure terminal', `interface ${iface}`,
    `standby ${group} ip ${vip}`,
    `standby ${group} priority ${priority}`,
    ...(preempt ? [`standby ${group} preempt`] : []),
    'no shutdown', 'end',
  ]);
}

/** H1 —— SW —— R1 (active, prio 200) / R2 (standby, prio 100), VIP 10.0.1.254 */
async function buildHsrpLan() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const h1 = new LinuxPC('linux-pc', 'H1');
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(h1.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.1.1', 1, '10.0.1.254', 200);
  await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.1.2', 1, '10.0.1.254', 100);
  await run(h1, [
    'ip link set eth0 up',
    'ip addr add 10.0.1.10/24 dev eth0',
    'ip route add default via 10.0.1.254',
  ]);
  return { r1, r2, sw, h1 };
}

describe('HSRP data plane', () => {
  it('active router answers ARP for the VIP with the virtual MAC', async () => {
    const { r1, h1 } = await buildHsrpLan();
    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');

    expect(await h1.executeCommand('ping -c 1 10.0.1.254')).toContain('0% packet loss');

    const arp = await h1.executeCommand('arp -n');
    // Virtual MAC 0000.0c07.ac01, not R1's burned-in port MAC.
    expect(arp.toLowerCase()).toContain('00:00:0c:07:ac:01');
  });

  it('standby router stays silent for the VIP', async () => {
    const { r2 } = await buildHsrpLan();
    const g = r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g?.state).not.toBe('active');
    expect(r2.getHsrpAgent().vipArpOwner('GigabitEthernet0/0', '10.0.1.254', '10.0.1.10'))
      .toBeNull();
  });

  it('routes traffic sent to the virtual MAC (VIP as default gateway)', async () => {
    const { r1, r2, h1 } = await buildHsrpLan();
    // Second LAN behind both routers, host H2 replies via R1's real IP.
    const h2 = new LinuxPC('linux-pc', 'H2');
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    new Cable('d').connect(r1.getPort('GigabitEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    new Cable('e').connect(r2.getPort('GigabitEthernet0/1')!, sw2.getPort('FastEthernet0/2')!);
    new Cable('f').connect(h2.getPort('eth0')!, sw2.getPort('FastEthernet0/3')!);
    await run(r1, ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
      'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'end']);
    await run(r2, ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
      'ip address 10.0.2.2 255.255.255.0', 'no shutdown', 'end']);
    await run(h2, [
      'ip link set eth0 up',
      'ip addr add 10.0.2.10/24 dev eth0',
      'ip route add default via 10.0.2.1',
    ]);

    // H1's gateway is the VIP: the echo crosses R1 via the virtual MAC.
    expect(await h1.executeCommand('ping -c 1 10.0.2.10')).toContain('0% packet loss');
  });

  it('fails over: standby takes the VIP after hold time and serves it', async () => {
    const { r1, r2, h1 } = await buildHsrpLan();
    // Shrink hold time so the real-timer expiry sweep fires quickly.
    await run(r1, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'standby 1 timers 1 2', 'end']);
    await run(r2, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'standby 1 timers 1 2', 'end']);
    expect(await h1.executeCommand('ping -c 1 10.0.1.254')).toContain('0% packet loss');

    await run(r1, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'shutdown', 'end']);

    // Hold time 2 s — R2's expiry sweep declares the active dead.
    await new Promise(r => setTimeout(r, 3500));
    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');

    // Same virtual MAC, new owner: the cached ARP entry stays valid,
    // and the takeover gratuitous ARP re-pointed the switch CAM at R2.
    expect(await h1.executeCommand('ping -c 1 10.0.1.254')).toContain('0% packet loss');
  }, 15_000);
});

describe('HSRP resign (RFC 2281 §5.4.3)', () => {
  it('an active router losing the election announces a Resign; the peer takes over at once', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.1.1', 1, '10.0.1.254', 200);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.1.2', 1, '10.0.1.254', 100);
    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');

    const resigns: string[] = [];
    bus.subscribe('hsrp.packet.sent', (e) => {
      const p = e.payload as { deviceId: string; opcode: string };
      if (p.opcode === 'resign') resigns.push(p.deviceId);
    });

    // Drop R1 below the preempting standby: R1 must resign, R2 take over
    // immediately — no hold-timer wait.
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('standby 1 priority 50');
    await r1.executeCommand('end');

    expect(resigns).toContain(r1.id);
    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');
    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).not.toBe('active');
  });
});

describe('VRRP data plane (Huawei VRP)', () => {
  it('master answers ARP for the VIP with 00:00:5e:00:01:{vrid}', async () => {
    const r1 = new HuaweiRouter('HW1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const h1 = new LinuxPC('linux-pc', 'H1');
    new Cable('a').connect(r1.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(h1.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    const agent = r1.getVrrpAgent();
    agent.start();
    agent.setVip('GE0/0/0', 5, '10.0.1.254');
    expect(agent.getGroup('GE0/0/0', 5)?.state).toBe('master');

    await run(h1, [
      'ip link set eth0 up',
      'ip addr add 10.0.1.10/24 dev eth0',
    ]);
    expect(await h1.executeCommand('ping -c 1 10.0.1.254')).toContain('0% packet loss');
    const arp = await h1.executeCommand('arp -n');
    expect(arp.toLowerCase()).toContain('00:00:5e:00:01:05');
  });
});

describe('GLBP data plane', () => {
  it('AVG hands out AVF virtual MACs round-robin across requesters', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    await run(r1, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'glbp 1 ip 10.0.1.254', 'glbp 1 priority 200', 'no shutdown', 'end']);
    await run(r2, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'glbp 1 ip 10.0.1.254', 'no shutdown', 'end']);

    const avg = r1.getGlbpAgent();
    expect(avg.getGroup('GigabitEthernet0/0', 1)?.avgState).toBe('active');

    const m1 = avg.vipArpOwner('GigabitEthernet0/0', '10.0.1.254', '10.0.1.50');
    const m2 = avg.vipArpOwner('GigabitEthernet0/0', '10.0.1.254', '10.0.1.51');
    expect(m1).toMatch(/^00:07:b4:00:/);
    expect(m2).toMatch(/^00:07:b4:00:/);
    expect(m1).not.toBe(m2); // two AVFs, round-robin

    // The non-AVG never answers ARP for the VIP.
    expect(r2.getGlbpAgent().vipArpOwner('GigabitEthernet0/0', '10.0.1.254', '10.0.1.50'))
      .toBeNull();
  });

  it('an AVF accepts frames addressed to its own virtual MAC only', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    await run(r1, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'glbp 1 ip 10.0.1.254', 'glbp 1 priority 200', 'no shutdown', 'end']);
    await run(r2, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'glbp 1 ip 10.0.1.254', 'no shutdown', 'end']);

    const g1 = r1.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)!;
    const myFwd = [...g1.forwarders.values()].find(f => f.ownerIp === '10.0.1.1');
    const peerFwd = [...g1.forwarders.values()].find(f => f.ownerIp === '10.0.1.2');
    expect(myFwd).toBeDefined();
    expect(peerFwd).toBeDefined();
    expect(r1.getGlbpAgent().ownsVirtualMac('GigabitEthernet0/0', myFwd!.vmac)).toBe(true);
    expect(r1.getGlbpAgent().ownsVirtualMac('GigabitEthernet0/0', peerFwd!.vmac)).toBe(false);
  });
});
