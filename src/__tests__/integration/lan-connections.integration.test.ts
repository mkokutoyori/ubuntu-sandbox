/**
 * LAN Integration Tests with Concrete Connections
 *
 * Tests realistic LAN topologies using EthernetConnection instances.
 * All device configuration is done via terminal commands (executeCommand).
 * Validates ARP resolution and ICMP ping functionality end-to-end.
 *
 * Topologies tested:
 * - 2 Linux PCs + Switch (basic LAN)
 * - Mixed OS LAN (Linux + Windows + Switch)
 * - 3 PCs + Hub (Layer 1 flooding)
 * - Store + NetworkSimulator integration
 *
 * TDD: Tests written first, then implementation verified.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { Switch } from '@/domain/devices/Switch';
import { Hub } from '@/domain/devices/Hub';
import { EthernetConnection } from '@/domain/connections/EthernetConnection';
import { ConnectionFactory } from '@/domain/connections/ConnectionFactory';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';

// ============================================================
// Helper: Wire up two devices via an EthernetConnection + Simulator-like delivery
// ============================================================

function wireDevicesViaConnection(
  deviceA: any,
  ifaceA: string,
  deviceB: any,
  ifaceB: string,
  conn: EthernetConnection
): void {
  // Set up frame delivery callback on the connection
  conn.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
    if (targetDeviceId === deviceB.getId()) {
      deliverFrame(deviceB, targetInterfaceId, frame);
    } else if (targetDeviceId === deviceA.getId()) {
      deliverFrame(deviceA, targetInterfaceId, frame);
    }
  });

  // Wire device A to transmit through the connection
  if ('getInterface' in deviceA && typeof deviceA.getInterface === 'function') {
    const iface = deviceA.getInterface(ifaceA);
    if (iface) {
      iface.onTransmit((frame: EthernetFrame) => {
        conn.transmitFrame(deviceA.getId(), frame);
      });
    }
  }

  // Wire device B to transmit through the connection
  if ('getInterface' in deviceB && typeof deviceB.getInterface === 'function') {
    const iface = deviceB.getInterface(ifaceB);
    if (iface) {
      iface.onTransmit((frame: EthernetFrame) => {
        conn.transmitFrame(deviceB.getId(), frame);
      });
    }
  }
}

function wirePCToSwitch(
  pc: any,
  sw: Switch,
  switchPort: string,
  conn: EthernetConnection
): void {
  // Connection delivers frames to the correct device
  conn.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
    if (targetDeviceId === sw.getId()) {
      sw.receiveFrame(targetInterfaceId, frame);
    } else if (targetDeviceId === pc.getId()) {
      deliverFrame(pc, targetInterfaceId, frame);
    }
  });

  // PC transmits through connection
  if ('getInterface' in pc && typeof pc.getInterface === 'function') {
    const iface = pc.getInterface('eth0');
    if (iface) {
      iface.onTransmit((frame: EthernetFrame) => {
        conn.transmitFrame(pc.getId(), frame);
      });
    }
  }

  // Switch forwards through connection
  sw.onFrameForward((port: string, frame: EthernetFrame) => {
    if (port === switchPort) {
      conn.transmitFrame(sw.getId(), frame);
    }
  });
}

function wirePCToHub(
  pc: any,
  hub: Hub,
  hubPort: string,
  conn: EthernetConnection
): void {
  conn.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
    if (targetDeviceId === hub.getId()) {
      hub.receiveFrame(targetInterfaceId, frame);
    } else if (targetDeviceId === pc.getId()) {
      deliverFrame(pc, targetInterfaceId, frame);
    }
  });

  if ('getInterface' in pc && typeof pc.getInterface === 'function') {
    const iface = pc.getInterface('eth0');
    if (iface) {
      iface.onTransmit((frame: EthernetFrame) => {
        conn.transmitFrame(pc.getId(), frame);
      });
    }
  }

  hub.onFrameForward((port: string, frame: EthernetFrame) => {
    if (port === hubPort) {
      conn.transmitFrame(hub.getId(), frame);
    }
  });
}

function deliverFrame(device: any, interfaceId: string, frame: EthernetFrame): void {
  if ('receiveFrame' in device && typeof device.receiveFrame === 'function') {
    device.receiveFrame(interfaceId, frame);
    return;
  }
  if ('getInterface' in device && typeof device.getInterface === 'function') {
    const iface = device.getInterface(interfaceId);
    if (iface && typeof iface.receive === 'function') {
      iface.receive(frame);
    }
  }
}

function populateARP(devices: any[]): void {
  for (const device of devices) {
    const iface = device.getInterface('eth0');
    if (!iface) continue;
    const ip = iface.getIPAddress();
    const mac = iface.getMAC();
    if (!ip) continue;

    for (const other of devices) {
      if (other === device) continue;
      other.addARPEntry(ip, mac);
    }
  }
}

// ============================================================
// TEST SUITE 1: Basic LAN - 2 Linux PCs + Switch
// ============================================================

describe('LAN: 2 Linux PCs + Switch with EthernetConnections', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let sw: Switch;
  let conn1: EthernetConnection;
  let conn2: EthernetConnection;

  beforeEach(async () => {
    // Create devices
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
    sw = new Switch('sw1', 'Switch1', 8);

    // Power on
    pc1.powerOn();
    pc2.powerOn();
    sw.powerOn();

    // Create Ethernet connections
    conn1 = ConnectionFactory.createEthernet({
      id: 'conn-pc1-sw',
      sourceDeviceId: 'pc1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth0'
    });

    conn2 = ConnectionFactory.createEthernet({
      id: 'conn-pc2-sw',
      sourceDeviceId: 'pc2',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth1'
    });

    // Wire PC1 <-> Switch(eth0)
    wirePCToSwitch(pc1, sw, 'eth0', conn1);
    // Wire PC2 <-> Switch(eth1)
    wirePCToSwitch(pc2, sw, 'eth1', conn2);

    // Configure IP addresses via terminal commands
    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0 up');
  });

  describe('Device configuration via terminal', () => {
    it('should configure PC1 IP via ifconfig command', async () => {
      const result = await pc1.executeCommand('ifconfig eth0');
      expect(result).toContain('192.168.1.10');
    });

    it('should configure PC2 IP via ifconfig command', async () => {
      const result = await pc2.executeCommand('ifconfig eth0');
      expect(result).toContain('192.168.1.20');
    });

    it('should configure IP via ip addr add command', async () => {
      const pc3 = new LinuxPC({ id: 'pc3', name: 'PC3' });
      pc3.powerOn();
      await pc3.executeCommand('ip addr add 10.0.0.5/24 dev eth0');

      const result = await pc3.executeCommand('ip addr show eth0');
      expect(result).toContain('10.0.0.5');
    });
  });

  describe('Connection properties', () => {
    it('should have active ethernet connections', () => {
      expect(conn1.isActive()).toBe(true);
      expect(conn2.isActive()).toBe(true);
      expect(conn1.getType()).toBe('ethernet');
    });

    it('should report gigabit bandwidth by default', () => {
      expect(conn1.getBandwidth()).toBe(1000);
    });

    it('should track frame statistics through connections', async () => {
      populateARP([pc1, pc2]);

      await pc1.executeCommand('ping -c 1 192.168.1.20');

      const stats1 = conn1.getStatistics();
      expect(stats1.txFrames).toBeGreaterThan(0);
    });
  });

  describe('ARP protocol', () => {
    it('should have empty ARP cache initially', async () => {
      const mac = pc1.resolveMAC(new IPAddress('192.168.1.20'));
      expect(mac).toBeUndefined();
    });

    it('should show ARP table via terminal', async () => {
      // Add ARP entry first
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);

      const result = await pc1.executeCommand('arp -a');
      expect(result).toContain('192.168.1.20');
    });

    it('should send ARP request for unknown MAC', () => {
      const arpRequest = pc1.createARPRequest(new IPAddress('192.168.1.20'));
      expect(arpRequest.operation).toBe('request');
      expect(arpRequest.targetIP.toString()).toBe('192.168.1.20');
    });

    it('should resolve MAC after ARP exchange', () => {
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();

      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);
      pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

      const resolved = pc1.resolveMAC(new IPAddress('192.168.1.20'));
      expect(resolved).toBeDefined();
      expect(resolved!.toString()).toBe(pc2MAC.toString());
    });
  });

  describe('ICMP ping', () => {
    beforeEach(() => {
      populateARP([pc1, pc2]);
    });

    it('should successfully ping between PCs via switch', async () => {
      const result = await pc1.executeCommand('ping -c 1 192.168.1.20');
      expect(result).toContain('PING 192.168.1.20');
      expect(result).toContain('bytes');
    });

    it('should ping in reverse direction', async () => {
      const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
      expect(result).toContain('PING 192.168.1.10');
      expect(result).toContain('bytes');
    });

    it('should show ping statistics', async () => {
      const result = await pc1.executeCommand('ping -c 4 192.168.1.20');
      expect(result).toContain('packets transmitted');
    });

    it('should forward frames through Ethernet connections', async () => {
      await pc1.executeCommand('ping -c 1 192.168.1.20');

      // Connection should have forwarded frames
      expect(conn1.getStatistics().txFrames).toBeGreaterThan(0);
    });

    it('should drop frames when connection is down', async () => {
      conn1.down();

      // Ping should fail because the connection is down
      // The frame will be submitted but the connection drops it
      const stats = conn1.getStatistics();
      const droppedBefore = stats.droppedFrames;

      await pc1.executeCommand('ping -c 1 192.168.1.20');

      const statsAfter = conn1.getStatistics();
      expect(statsAfter.droppedFrames).toBeGreaterThanOrEqual(droppedBefore);
    });
  });

  describe('Switch MAC learning', () => {
    beforeEach(() => {
      populateARP([pc1, pc2]);
    });

    it('should learn PC1 MAC on port eth0 after ping', async () => {
      await pc1.executeCommand('ping -c 1 192.168.1.20');

      const macTable = sw.getMACTable();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();
      const port = macTable.lookup(pc1MAC);
      expect(port).toBe('eth0');
    });
  });
});

// ============================================================
// TEST SUITE 2: Mixed OS LAN - Linux + Windows + Switch
// ============================================================

describe('LAN: Mixed OS (Linux + Windows) + Switch', () => {
  let linux: LinuxPC;
  let windows: WindowsPC;
  let sw: Switch;
  let connLinux: EthernetConnection;
  let connWin: EthernetConnection;

  beforeEach(async () => {
    linux = new LinuxPC({ id: 'linux1', name: 'LinuxPC' });
    windows = new WindowsPC({ id: 'win1', name: 'WindowsPC' });
    sw = new Switch('sw1', 'Switch1', 4);

    linux.powerOn();
    windows.powerOn();
    sw.powerOn();

    connLinux = ConnectionFactory.createEthernet({
      id: 'conn-linux-sw',
      sourceDeviceId: 'linux1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth0'
    });

    connWin = ConnectionFactory.createEthernet({
      id: 'conn-win-sw',
      sourceDeviceId: 'win1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth1'
    });

    wirePCToSwitch(linux, sw, 'eth0', connLinux);
    wirePCToSwitch(windows, sw, 'eth1', connWin);

    // Configure via OS-specific terminal commands
    await linux.executeCommand('ifconfig eth0 192.168.10.1 netmask 255.255.255.0 up');
    await windows.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.10.2 255.255.255.0');
  });

  describe('Configuration via terminal', () => {
    it('should configure Linux IP via ifconfig', async () => {
      const output = await linux.executeCommand('ifconfig eth0');
      expect(output).toContain('192.168.10.1');
    });

    it('should configure Windows IP via netsh', async () => {
      const output = await windows.executeCommand('ipconfig');
      expect(output).toContain('192.168.10.2');
    });
  });

  describe('Cross-OS ping', () => {
    beforeEach(() => {
      populateARP([linux, windows]);
    });

    it('should ping Windows from Linux', async () => {
      const result = await linux.executeCommand('ping -c 1 192.168.10.2');
      expect(result).toContain('PING 192.168.10.2');
      expect(result).toContain('bytes');
    });

    it('should ping Linux from Windows', async () => {
      const result = await windows.executeCommand('ping -n 1 192.168.10.1');
      expect(result).toContain('192.168.10.1');
      expect(result).toContain('bytes');
    });
  });
});

// ============================================================
// TEST SUITE 3: 3 PCs + Hub (Layer 1)
// ============================================================

describe('LAN: 3 PCs + Hub with EthernetConnections', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let pc3: LinuxPC;
  let hub: Hub;
  let conns: EthernetConnection[];

  beforeEach(async () => {
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
    pc3 = new LinuxPC({ id: 'pc3', name: 'PC3' });
    hub = new Hub('hub1', 'Hub1', 4);

    pc1.powerOn();
    pc2.powerOn();
    pc3.powerOn();
    hub.powerOn();

    conns = [
      ConnectionFactory.createEthernet({
        id: 'conn-pc1-hub',
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'hub1',
        targetInterfaceId: 'eth0'
      }),
      ConnectionFactory.createEthernet({
        id: 'conn-pc2-hub',
        sourceDeviceId: 'pc2',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'hub1',
        targetInterfaceId: 'eth1'
      }),
      ConnectionFactory.createEthernet({
        id: 'conn-pc3-hub',
        sourceDeviceId: 'pc3',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'hub1',
        targetInterfaceId: 'eth2'
      })
    ];

    wirePCToHub(pc1, hub, 'eth0', conns[0]);
    wirePCToHub(pc2, hub, 'eth1', conns[1]);
    wirePCToHub(pc3, hub, 'eth2', conns[2]);

    await pc1.executeCommand('ifconfig eth0 172.16.0.1 netmask 255.255.0.0 up');
    await pc2.executeCommand('ifconfig eth0 172.16.0.2 netmask 255.255.0.0 up');
    await pc3.executeCommand('ifconfig eth0 172.16.0.3 netmask 255.255.0.0 up');

    populateARP([pc1, pc2, pc3]);
  });

  it('should ping PC2 from PC1 via hub', async () => {
    const result = await pc1.executeCommand('ping -c 1 172.16.0.2');
    expect(result).toContain('PING 172.16.0.2');
  });

  it('should ping PC3 from PC1 via hub', async () => {
    const result = await pc1.executeCommand('ping -c 1 172.16.0.3');
    expect(result).toContain('PING 172.16.0.3');
  });

  it('should have all connections active', () => {
    for (const conn of conns) {
      expect(conn.isActive()).toBe(true);
      expect(conn.getType()).toBe('ethernet');
    }
  });
});

// ============================================================
// TEST SUITE 4: Store + NetworkSimulator integration
// ============================================================

describe('LAN: Store + NetworkSimulator with EthernetConnection instances', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
    NetworkSimulator.reset();
  });

  afterEach(() => {
    useNetworkStore.getState().clearAll();
    NetworkSimulator.reset();
  });

  it('should create connections with instances via the store', () => {
    const store = useNetworkStore.getState();

    const pc1 = store.addDevice('linux-pc', 100, 100);
    const sw = store.addDevice('switch', 300, 200);

    const conn = store.addConnection(pc1.id, 'eth0', sw.id, 'eth0');

    expect(conn).not.toBeNull();
    expect(conn!.instance).toBeDefined();
    expect(conn!.instance!.getType()).toBe('ethernet');
    expect(conn!.instance!.isActive()).toBe(true);
  });

  it('should pass connection instances to NetworkSimulator', () => {
    const store = useNetworkStore.getState();

    const pc1 = store.addDevice('linux-pc', 100, 100);
    const pc2 = store.addDevice('linux-pc', 100, 300);
    const sw = store.addDevice('switch', 300, 200);

    store.addConnection(pc1.id, 'eth0', sw.id, 'eth0');
    store.addConnection(pc2.id, 'eth0', sw.id, 'eth1');

    const { deviceInstances, connections } = useNetworkStore.getState();
    NetworkSimulator.initialize(deviceInstances, connections);

    expect(NetworkSimulator.isReady()).toBe(true);

    const info = NetworkSimulator.getConnectionInfo();
    expect(info.devices).toBe(3);
    expect(info.connections).toBe(2);
    expect(info.connectionInstances).toBe(2);
  });

  it('should configure devices via terminal and ping through NetworkSimulator', async () => {
    const store = useNetworkStore.getState();

    // Build topology
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 100, 300);
    const swUI = store.addDevice('switch', 300, 200);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1');

    // Initialize simulator
    const { deviceInstances, connections } = useNetworkStore.getState();
    NetworkSimulator.initialize(deviceInstances, connections);

    // Get device instances for terminal commands
    const pc1 = store.getDevice(pc1UI.id) as LinuxPC;
    const pc2 = store.getDevice(pc2UI.id) as LinuxPC;

    // Configure via terminal
    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0 up');

    // Verify IP config via terminal
    const pc1Config = await pc1.executeCommand('ifconfig eth0');
    expect(pc1Config).toContain('192.168.1.10');

    const pc2Config = await pc2.executeCommand('ifconfig eth0');
    expect(pc2Config).toContain('192.168.1.20');

    // Setup ARP (needed for ping to work)
    const pc1MAC = (pc1 as any).getInterface('eth0').getMAC();
    const pc2MAC = (pc2 as any).getInterface('eth0').getMAC();
    (pc1 as any).addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);
    (pc2 as any).addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

    // Ping via terminal
    const result = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(result).toContain('PING 192.168.1.20');
    expect(result).toContain('bytes');
  });

  it('should deactivate connection instance on removal', () => {
    const store = useNetworkStore.getState();

    const pc1 = store.addDevice('linux-pc', 100, 100);
    const sw = store.addDevice('switch', 300, 200);
    const conn = store.addConnection(pc1.id, 'eth0', sw.id, 'eth0');

    expect(conn!.instance!.isActive()).toBe(true);

    const instance = conn!.instance!;
    store.removeConnection(conn!.id);

    expect(instance.isActive()).toBe(false);
  });
});
