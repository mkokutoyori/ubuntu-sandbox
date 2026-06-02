import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type EthernetFrame,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_VXLAN, VXLAN_VNI_MAX, VXLAN_FLAG_I,
  isValidVni, makeVtepKey, makeMacKey,
} from '@/network/vxlan/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function makeInnerFrame(srcMac: string, dstMac: string): EthernetFrame {
  return {
    srcMAC: new MACAddress(srcMac),
    dstMAC: new MACAddress(dstMac),
    etherType: 0x0800,
    payload: { type: 'opaque', data: 'inner-payload' } as unknown as never,
  };
}

describe('VXLAN — pure helpers', () => {
  it('UDP_PORT_VXLAN matches the IANA assignment', () => {
    expect(UDP_PORT_VXLAN).toBe(4789);
  });

  it('VXLAN_VNI_MAX is 24-bit', () => {
    expect(VXLAN_VNI_MAX).toBe(0xffffff);
  });

  it('isValidVni accepts 0..16777215 and rejects out-of-range', () => {
    expect(isValidVni(0)).toBe(true);
    expect(isValidVni(5000)).toBe(true);
    expect(isValidVni(VXLAN_VNI_MAX)).toBe(true);
    expect(isValidVni(VXLAN_VNI_MAX + 1)).toBe(false);
    expect(isValidVni(-1)).toBe(false);
  });

  it('makeVtepKey separates VNI and remote IP', () => {
    expect(makeVtepKey(5000, '10.0.0.1')).toBe('5000|10.0.0.1');
  });

  it('makeMacKey lowercases the MAC for case-insensitive lookup', () => {
    expect(makeMacKey(5000, 'AA:BB:CC:DD:EE:FF')).toBe(makeMacKey(5000, 'aa:bb:cc:dd:ee:ff'));
  });
});

describe('VXLAN — VTEP registry', () => {
  it('addRemoteVtep emits vxlan.vtep.changed with added=true', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const events: Array<{ vni: number; added: boolean }> = [];
    bus.subscribe('vxlan.vtep.changed', (e) => events.push(e.payload));
    r.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    expect(events).toEqual([{
      deviceId: r.id, hostname: r.getHostname(),
      vni: 5000, remoteVtepIp: '10.0.0.2', added: true,
    }]);
  });

  it('removeRemoteVtep emits added=false', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    r.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    const events: Array<{ added: boolean }> = [];
    bus.subscribe('vxlan.vtep.changed', (e) => events.push(e.payload));
    r.getVxlanAgent().removeRemoteVtep(5000, '10.0.0.2');
    expect(events.length).toBe(1);
    expect(events[0].added).toBe(false);
  });
});

describe('VXLAN — encap/decap end-to-end', () => {
  it('frame encapsulated by R1 reaches R2 and is decapsulated with the same VNI', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    r2.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.2');
    r2.getVxlanAgent().addRemoteVtep(5000, '10.0.0.1');

    const decaps: Array<{ vni: number; innerSrcMac: string; innerDstMac: string; remoteVtepIp: string }> = [];
    bus.subscribe('vxlan.packet.decapsulated', (e) => decaps.push(e.payload));

    const inner = makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02');
    r1.getVxlanAgent().encapsulateAndSend(5000, inner);

    expect(decaps.length).toBe(1);
    expect(decaps[0]).toMatchObject({
      vni: 5000,
      innerSrcMac: 'aa:bb:cc:00:00:01',
      innerDstMac: 'aa:bb:cc:00:00:02',
      remoteVtepIp: '10.0.0.1',
    });
  });

  it('publishes vxlan.packet.encapsulated on send', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');

    const encaps: Array<{ vni: number; remoteVtepIp: string }> = [];
    bus.subscribe('vxlan.packet.encapsulated', (e) => encaps.push(e.payload));
    r1.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));
    expect(encaps.length).toBe(1);
    expect(encaps[0]).toMatchObject({ vni: 5000, remoteVtepIp: '10.0.0.2' });
  });

  it('outer header rides UDP/4789 with vxlan flags=I set and the right VNI', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { dport: number; flags: number; vni: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; header?: { flags?: number; vni?: number } } }
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_VXLAN) {
        const vx = udp.payload;
        if (vx?.type === 'vxlan') {
          seen = { dport: udp.destinationPort, flags: vx.header!.flags!, vni: vx.header!.vni! };
        }
      }
    });
    cable.connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    r1.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_VXLAN);
    expect(seen!.flags & VXLAN_FLAG_I).toBe(VXLAN_FLAG_I);
    expect(seen!.vni).toBe(5000);
  });
});

describe('VXLAN — MAC learning', () => {
  it('on decap the source MAC is learned against (vni, remoteVtepIp)', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    r2.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.2');

    r1.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));

    const macs = r2.getVxlanAgent().listMacTable();
    expect(macs.length).toBe(1);
    expect(macs[0].vni).toBe(5000);
    expect(macs[0].mac).toBe('aa:bb:cc:00:00:01');
    expect(macs[0].remoteVtepIp).toBe('10.0.0.1');
  });

  it('subsequent encap on R2 unicasts to the learned remote VTEP only', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const r3 = new CiscoRouter('R3');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); r3.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c').connect(r3.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r3.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));

    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    r2.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.2');
    r2.getVxlanAgent().addRemoteVtep(5000, '10.0.0.1');
    r2.getVxlanAgent().addRemoteVtep(5000, '10.0.0.3');
    r3.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.3');

    r1.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));

    const encaps: Array<{ remoteVtepIp: string }> = [];
    bus.subscribe('vxlan.packet.encapsulated', (e) => { if (e.payload.deviceId === r2.id) encaps.push(e.payload); });
    r2.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:02', 'aa:bb:cc:00:00:01'));
    expect(encaps.length).toBe(1);
    expect(encaps[0].remoteVtepIp).toBe('10.0.0.1');
  });

  it('disabling learning skips updates to the MAC table', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    r2.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.2');
    r2.getVxlanAgent().setLearning(false);

    r1.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));
    expect(r2.getVxlanAgent().listMacTable().length).toBe(0);
  });
});

describe('VXLAN — error paths', () => {
  it('encap on a VNI without a remote VTEP drops with reason=no-vtep', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    const drops: Array<{ reason: string }> = [];
    bus.subscribe('vxlan.packet.dropped', (e) => drops.push(e.payload));
    r.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));
    expect(drops.some(d => d.reason === 'no-vtep')).toBe(true);
  });

  it('invalid VNI is rejected with reason=invalid-vni', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const drops: Array<{ reason: string }> = [];
    bus.subscribe('vxlan.packet.dropped', (e) => drops.push(e.payload));
    r.getVxlanAgent().encapsulateAndSend(VXLAN_VNI_MAX + 1, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));
    expect(drops.some(d => d.reason === 'invalid-vni')).toBe(true);
  });
});

describe('VXLAN — Cisco↔Huawei interop', () => {
  it('a tunnel between Cisco and Huawei VTEPs decaps cleanly on each side', () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cisco.getVxlanAgent().bindVni('GigabitEthernet0/0', 5000, '10.0.0.1');
    cisco.getVxlanAgent().addRemoteVtep(5000, '10.0.0.2');
    huawei.getVxlanAgent().bindVni('GE0/0/0', 5000, '10.0.0.2');
    huawei.getVxlanAgent().addRemoteVtep(5000, '10.0.0.1');

    cisco.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02'));
    huawei.getVxlanAgent().encapsulateAndSend(5000, makeInnerFrame('aa:bb:cc:00:00:02', 'aa:bb:cc:00:00:01'));

    expect(huawei.getVxlanAgent().listMacTable().some(m => m.mac === 'aa:bb:cc:00:00:01')).toBe(true);
    expect(cisco.getVxlanAgent().listMacTable().some(m => m.mac === 'aa:bb:cc:00:00:02')).toBe(true);
  });
});
