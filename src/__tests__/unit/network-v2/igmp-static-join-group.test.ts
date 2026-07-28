import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lab() {
  const bus = new EventBus();
  const r = new CiscoRouter('R1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  r.setEventBus(bus); sw.setEventBus(bus);
  const cable = new Cable('c');
  cable.setEventBus(bus);
  cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return { bus, r, sw };
}

async function configure(r: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
}

describe('IGMP — ip igmp join-group (P2)', () => {
  it('makes the router itself a member, visible in show ip igmp groups', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp',
      'ip igmp join-group 239.1.1.1',
      'end',
    ]);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.1.1.1')).toBe(true);
    const out = await r.executeCommand('show ip igmp groups');
    expect(out).toMatch(/239\.1\.1\.1/);
    expect(out).toMatch(/10\.0\.0\.1/);
  });

  it('emits a real Membership Report on the wire', async () => {
    const { bus, r } = lab();
    const sent: Array<{ messageType: string; groupAddress: string; destinationIp: string }> = [];
    bus.subscribe('igmp.packet.sent', (e) => sent.push(e.payload));
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp',
      'ip igmp join-group 239.2.2.2',
      'end',
    ]);
    const report = sent.find(s => s.messageType === 'v2-membership-report');
    expect(report).toBeDefined();
    expect(report!.groupAddress).toBe('239.2.2.2');
    expect(report!.destinationIp).toBe('239.2.2.2');
  });

  it('propagates the membership to PIM via igmp.group.joined', async () => {
    const { bus, r } = lab();
    const joins: Array<{ groupAddress: string }> = [];
    bus.subscribe('igmp.group.joined', (e) => joins.push(e.payload));
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp join-group 239.3.3.3',
      'end',
    ]);
    expect(joins.some(j => j.groupAddress === '239.3.3.3')).toBe(true);
    expect(r.getPimAgent().getMroute('239.3.3.3')).toBeDefined();
  });

  it('the group never expires and no host Leave can remove it', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp join-group 239.4.4.4',
      'end',
    ]);
    const out = await r.executeCommand('show ip igmp groups');
    expect(out).toMatch(/never/);

    const cfg = r.getIgmpAgent().getConfig();
    const rec = cfg.groups.get('GigabitEthernet0/0|239.4.4.4');
    expect(rec?.origin).toBe('join-group');
  });

  it('no ip igmp join-group withdraws the membership', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp join-group 239.5.5.5',
    ]);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.5.5.5')).toBe(true);
    await configure(r, ['no ip igmp join-group 239.5.5.5', 'end']);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.5.5.5')).toBe(false);
  });
});

describe('IGMP — ip igmp static-group (P2)', () => {
  it('adds forwarding state without ever emitting a Report', async () => {
    const { bus, r } = lab();
    const sent: Array<{ messageType: string }> = [];
    bus.subscribe('igmp.packet.sent', (e) => sent.push(e.payload));
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp static-group 239.6.6.6',
      'end',
    ]);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.6.6.6')).toBe(true);
    expect(sent.some(s => s.messageType.endsWith('membership-report'))).toBe(false);
  });

  it('shows 0.0.0.0 as last reporter — no host ever reported it', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp static-group 239.7.7.7',
      'end',
    ]);
    const out = await r.executeCommand('show ip igmp groups');
    expect(out).toMatch(/239\.7\.7\.7\s+GigabitEthernet0\/0\s+\S+\s+never\s+0\.0\.0\.0/);
  });
});

describe('IGMP — configured group validation and persistence (P2)', () => {
  it('rejects a unicast or link-local-scope group address', async () => {
    const { r } = lab();
    await configure(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    expect(await r.executeCommand('ip igmp join-group 10.1.1.1')).toBe('% Invalid group address');
    expect(await r.executeCommand('ip igmp join-group 224.0.0.5')).toBe('% Invalid group address');
    expect(r.getIgmpAgent().listGroups().length).toBe(0);
  });

  it('appears in show running-config under the interface', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp join-group 239.8.8.8',
      'ip igmp static-group 239.9.9.9',
      'end',
    ]);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toMatch(/ ip igmp join-group 239\.8\.8\.8/);
    expect(cfg).toMatch(/ ip igmp static-group 239\.9\.9\.9/);
  });

  it('survives a link flap — the configured join is re-materialised on link-up', async () => {
    const { r } = lab();
    await configure(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip igmp join-group 239.10.10.10',
      'end',
    ]);
    r.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.10.10.10')).toBe(false);
    r.getPort('GigabitEthernet0/0')!.setUp(true);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.10.10.10')).toBe(true);
  });
});
