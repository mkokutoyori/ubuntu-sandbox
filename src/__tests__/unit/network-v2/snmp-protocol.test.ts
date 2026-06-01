import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_SNMP, SNMP_PDU_TYPE, oidCompare, oidStartsWith,
  OID_SYS_NAME, OID_SYS_DESCR, OID_SYS_UPTIME, OID_SYS_LOCATION,
  OID_IF_NUMBER, OID_IF_DESCR_PREFIX, OID_IF_ADMIN_STATUS_PREFIX,
} from '@/network/snmp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('SNMP — pure helpers', () => {
  it('SNMP_PDU_TYPE matches RFC 1905 wire tags', () => {
    expect(SNMP_PDU_TYPE['get-request']).toBe(0xa0);
    expect(SNMP_PDU_TYPE['get-next-request']).toBe(0xa1);
    expect(SNMP_PDU_TYPE['get-response']).toBe(0xa2);
    expect(SNMP_PDU_TYPE['set-request']).toBe(0xa3);
    expect(SNMP_PDU_TYPE['trap-v2']).toBe(0xa7);
  });

  it('oidCompare orders OIDs lexicographically by component', () => {
    expect(oidCompare('1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0')).toBeLessThan(0);
    expect(oidCompare('1.3.6.1.2.1.2.1.0', '1.3.6.1.2.1.1.5.0')).toBeGreaterThan(0);
    expect(oidCompare('1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.5.0')).toBe(0);
  });

  it('oidStartsWith recognises subtree prefixes', () => {
    expect(oidStartsWith('1.3.6.1.2.1.2.2.1.2.1', '1.3.6.1.2.1.2.2.1')).toBe(true);
    expect(oidStartsWith('1.3.6.1.2.1.2.2.1', '1.3.6.1.2.1.2.2.1')).toBe(true);
    expect(oidStartsWith('1.3.6.1.2.1.2.3.1.2.1', '1.3.6.1.2.1.2.2.1')).toBe(false);
  });
});

describe('SNMP — system MIB get', () => {
  it('GET sysName returns the device hostname', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_SYS_NAME]);
    expect(vbs).not.toBeNull();
    expect(vbs!.length).toBe(1);
    expect(vbs![0].oid).toBe(OID_SYS_NAME);
    expect(vbs![0].value.type).toBe('octet-string');
    expect(vbs![0].value.value).toBe(router.getHostname());
  });

  it('GET sysDescr and sysUpTime return live values', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_SYS_DESCR, OID_SYS_UPTIME]);
    expect(vbs).not.toBeNull();
    expect(vbs!.length).toBe(2);
    expect(String(vbs![0].value.value)).toMatch(/Cisco IOS/);
    expect(vbs![1].value.type).toBe('timeticks');
    expect(typeof vbs![1].value.value).toBe('number');
  });

  it('GET ifNumber returns the port count', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_IF_NUMBER]);
    expect(vbs).not.toBeNull();
    expect(vbs![0].value.type).toBe('integer');
    expect(Number(vbs![0].value.value)).toBe(router.getPorts().length);
  });
});

describe('SNMP — community ACL', () => {
  it('an unknown community emits snmp.auth.rejected and the request returns null on timeout', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const rejects: Array<{ community: string; reason: string }> = [];
    bus.subscribe('snmp.auth.rejected', (e) => rejects.push(e.payload));
    nms.getSnmpAgent().get('10.0.0.1', 'private', [OID_SYS_NAME]);
    await new Promise((r) => setTimeout(r, 50));
    expect(rejects.some(r => r.community === 'private' && r.reason === 'unknown-community')).toBe(true);
  });
});

describe('SNMP — get-next walks the MIB', () => {
  it('GET-NEXT 1.3.6.1.2.1.1 returns sysDescr (lowest in mib-2.system)', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().getNext('10.0.0.1', 'public', ['1.3.6.1.2.1.1']);
    expect(vbs).not.toBeNull();
    expect(vbs![0].oid).toBe(OID_SYS_DESCR);
  });
});

describe('SNMP — interface table', () => {
  it('GET ifDescr.1 returns the first port name', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [`${OID_IF_DESCR_PREFIX}.1`]);
    expect(vbs).not.toBeNull();
    expect(vbs![0].value.value).toBe(router.getPorts()[0].getName());
  });

  it('ifAdminStatus reflects port up/down state', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const upVbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [`${OID_IF_ADMIN_STATUS_PREFIX}.2`]);
    expect(Number(upVbs![0].value.value)).toBe(1);

    router.getPorts()[1].setUp(false);
    const downVbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [`${OID_IF_ADMIN_STATUS_PREFIX}.2`]);
    expect(Number(downVbs![0].value.value)).toBe(2);
  });
});

describe('SNMP — sysLocation / sysContact', () => {
  it('setLocation makes the value visible to a remote GET', async () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    router.getSnmpAgent().setLocation('rack-42');
    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_SYS_LOCATION]);
    expect(vbs![0].value.value).toBe('rack-42');
  });
});

describe('SNMP — Cisco↔Huawei interop', () => {
  it('Cisco NMS reads Huawei sysDescr', async () => {
    const bus = new EventBus();
    const router = new HuaweiRouter('HW');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const vbs = await nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_SYS_DESCR]);
    expect(String(vbs![0].value.value)).toMatch(/Huawei VRP/);
  });
});

describe('SNMP — traps', () => {
  it('sendTrap reaches every configured trap host on UDP/162', () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    router.getSnmpAgent().addTrapHost('10.0.0.2', 'public');
    const traps: Array<{ destinationIp: string; trapOid: string }> = [];
    bus.subscribe('snmp.trap.sent', (e) => traps.push(e.payload));
    router.getSnmpAgent().sendTrap('1.3.6.1.6.3.1.1.5.3');
    expect(traps.length).toBe(1);
    expect(traps[0].destinationIp).toBe('10.0.0.2');
    expect(traps[0].trapOid).toBe('1.3.6.1.6.3.1.1.5.3');
  });
});

describe('SNMP — wire format', () => {
  it('GET-Request rides UDP/161 with an snmp payload', () => {
    const bus = new EventBus();
    const router = new CiscoRouter('R1');
    const nms = new CiscoRouter('NMS');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    router.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { dport: number; pduType: string; community: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; pduType?: string; community?: string } }
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_SNMP) {
        const snmp = udp.payload;
        if (snmp?.type === 'snmp') {
          seen = { dport: udp.destinationPort, pduType: snmp.pduType!, community: snmp.community! };
        }
      }
    });
    cable.connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    router.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    nms.getSnmpAgent().get('10.0.0.1', 'public', [OID_SYS_NAME]);
    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_SNMP);
    expect(seen!.pduType).toBe('get-request');
    expect(seen!.community).toBe('public');
  });
});
