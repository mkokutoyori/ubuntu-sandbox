import { describe, it, expect, beforeEach } from 'vitest';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { buildConnection } from '@/store/networkStore';

describe('topology round-trip: enriched state survives export → import', () => {
  beforeEach(() => EquipmentRegistry.resetInstance());

  it('interface admin down state persists', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
    await pc.executeCommand('ifconfig eth1 down');

    const exp = exportTopology('t', new Map([[pc.getId(), pc]]), []);
    const roundtrip = importTopology(exp);
    const restored = Array.from(roundtrip.deviceInstances.values())[0];

    expect(restored.getPort('eth1')!.getIsUp()).toBe(false);
    expect(restored.getPort('eth0')!.getIsUp()).toBe(true);
  });

  it('interface description persists', async () => {
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    router.powerOn();
    const port = router.getPort('GigabitEthernet0/0')!;
    port.setDescriptionText('Uplink to ISP');

    const exp = exportTopology('t', new Map([[router.getId(), router]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0];

    expect(restored.getPort('GigabitEthernet0/0')!.getDescriptionText()).toBe('Uplink to ISP');
  });

  it('router interface secondary IPs persist', async () => {
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    router.powerOn();
    const { IPAddress, SubnetMask } = await import('@/network/core/types');
    router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'), true);

    const exp = exportTopology('t', new Map([[router.getId(), router]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0];
    const sec = restored.getPort('GigabitEthernet0/0')!.getSecondaryIPs();

    expect(sec.length).toBe(1);
    expect(sec[0].ip.toString()).toBe('10.0.1.1');
  });

  it('static ARP entries persist on hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
    await pc.executeCommand('arp -s 192.168.1.99 aa:bb:cc:dd:ee:ff');

    const exp = exportTopology('t', new Map([[pc.getId(), pc]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0] as LinuxPC;

    const arp = await restored.executeCommand('arp -n');
    expect(arp).toContain('192.168.1.99');
    expect(arp.toLowerCase()).toContain('aa:bb:cc:dd:ee:ff');
  });

  it('Linux /etc/hosts and /etc/resolv.conf content persists', async () => {
    const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    await srv.executeCommand('bash -c "echo 192.168.1.10 web.local >> /etc/hosts"');
    await srv.executeCommand('bash -c "echo nameserver 8.8.8.8 > /etc/resolv.conf"');

    const exp = exportTopology('t', new Map([[srv.getId(), srv]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0] as LinuxServer;

    const hosts = await restored.executeCommand('cat /etc/hosts');
    expect(hosts).toContain('192.168.1.10 web.local');
    const resolv = await restored.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 8.8.8.8');
  });

  it('switch VLAN database and switchport configs persist', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'sw1', 8, 0, 0);
    sw.powerOn();
    sw.createVLAN(10, 'Engineering');
    sw.createVLAN(20, 'Sales');
    sw.setSwitchportMode('FastEthernet0/1', 'access');
    sw.setSwitchportAccessVlan('FastEthernet0/1', 10);
    sw.setSwitchportMode('FastEthernet0/2', 'trunk');

    const exp = exportTopology('t', new Map([[sw.getId(), sw]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0] as CiscoSwitch;

    expect(restored.getVLAN(10)?.name).toBe('Engineering');
    expect(restored.getVLAN(20)?.name).toBe('Sales');
    expect(restored.getSwitchportConfig('FastEthernet0/1')?.accessVlan).toBe(10);
    expect(restored.getSwitchportConfig('FastEthernet0/2')?.mode).toBe('trunk');
  });

  it('Huawei switch VLAN config persists too', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'sw1', 8, 0, 0);
    sw.powerOn();
    sw.createVLAN(100, 'mgmt');
    const portName = Array.from(sw.getPorts().values())[0].getName();
    sw.setSwitchportMode(portName, 'access');
    sw.setSwitchportAccessVlan(portName, 100);

    const exp = exportTopology('t', new Map([[sw.getId(), sw]]), []);
    const r = importTopology(exp);
    const restored = Array.from(r.deviceInstances.values())[0] as HuaweiSwitch;

    expect(restored.getVLAN(100)?.name).toBe('mgmt');
    expect(restored.getSwitchportConfig(portName)?.accessVlan).toBe(100);
  });

  it('full round-trip preserves connectivity (ping + arp work after import)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    const swPortArr = Array.from(sw.getPorts().values());
    new Cable('c1').connect(pc.getPort('eth0')!, swPortArr[0]);
    new Cable('c2').connect(srv.getPort('eth0')!, swPortArr[1]);
    await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
    await srv.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');

    const connections = [
      buildConnection(pc, 'eth0', sw, swPortArr[0].getName(), 'ethernet')!,
      buildConnection(srv, 'eth0', sw, swPortArr[1].getName(), 'ethernet')!,
    ];
    const instances = new Map<string, any>([
      [pc.getId(), pc], [srv.getId(), srv], [sw.getId(), sw],
    ]);
    const exp = exportTopology('t', instances, connections);

    EquipmentRegistry.resetInstance();
    const r = importTopology(exp);
    const restoredPc = Array.from(r.deviceInstances.values()).find(d => d.getName() === 'PC1') as LinuxPC;

    const ping = await restoredPc.executeCommand('ping -c 1 -W 1 192.168.1.2');
    expect(ping).toContain('1 received');
    const arp = await restoredPc.executeCommand('arp');
    expect(arp).toContain('192.168.1.2');
  });
});
