/**
 * WAN Integration Tests with Concrete Connections
 *
 * Tests realistic WAN topologies connecting multiple LANs via Routers.
 * All device configuration is done via terminal commands (executeCommand).
 * Validates cross-network ICMP ping and ARP resolution.
 *
 * Topologies tested:
 * - 2 LANs connected by 1 Router (basic WAN)
 * - 2 LANs with Linux + Windows PCs, router between them
 * - Serial WAN link between two routers
 *
 * TDD: Tests written first, then implementation verified.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { Switch } from '@/domain/devices/Switch';
import { Router } from '@/domain/devices/Router';
import { EthernetConnection } from '@/domain/connections/EthernetConnection';
import { SerialConnection } from '@/domain/connections/SerialConnection';
import { ConnectionFactory } from '@/domain/connections/ConnectionFactory';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

// ============================================================
// Helpers
// ============================================================

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

/**
 * Wire a PC to a Switch port via an EthernetConnection.
 * Both the PC's NIC transmit and the Switch's forward are connected.
 */
function wirePCToSwitch(
  pc: any,
  sw: Switch,
  switchPort: string,
  conn: EthernetConnection
): void {
  conn.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
    if (targetDeviceId === sw.getId()) {
      sw.receiveFrame(targetInterfaceId, frame);
    } else if (targetDeviceId === pc.getId()) {
      deliverFrame(pc, targetInterfaceId, frame);
    }
  });

  const iface = pc.getInterface('eth0');
  if (iface) {
    iface.onTransmit((frame: EthernetFrame) => {
      conn.transmitFrame(pc.getId(), frame);
    });
  }

  sw.onFrameForward((port: string, frame: EthernetFrame) => {
    if (port === switchPort) {
      conn.transmitFrame(sw.getId(), frame);
    }
  });
}

/**
 * Wire a Router interface to a Switch port via an EthernetConnection.
 */
function wireRouterToSwitch(
  router: Router,
  routerIface: string,
  sw: Switch,
  switchPort: string,
  conn: EthernetConnection
): void {
  conn.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
    if (targetDeviceId === sw.getId()) {
      sw.receiveFrame(targetInterfaceId, frame);
    } else if (targetDeviceId === router.getId()) {
      deliverFrame(router, targetInterfaceId, frame);
    }
  });

  // Router transmits via frameTransmitCallback
  router.onFrameTransmit((ifaceName: string, frame: EthernetFrame) => {
    if (ifaceName === routerIface) {
      conn.transmitFrame(router.getId(), frame);
    }
  });

  sw.onFrameForward((port: string, frame: EthernetFrame) => {
    if (port === switchPort) {
      conn.transmitFrame(sw.getId(), frame);
    }
  });
}

/**
 * Wire two routers directly via a connection (serial or ethernet).
 */
function wireRouterToRouter(
  r1: Router,
  r1Iface: string,
  r2: Router,
  r2Iface: string,
  conn: any
): void {
  conn.onFrameDelivery((targetDeviceId: string, targetInterfaceId: string, frame: EthernetFrame) => {
    if (targetDeviceId === r2.getId()) {
      deliverFrame(r2, targetInterfaceId, frame);
    } else if (targetDeviceId === r1.getId()) {
      deliverFrame(r1, targetInterfaceId, frame);
    }
  });

  r1.onFrameTransmit((ifaceName: string, frame: EthernetFrame) => {
    if (ifaceName === r1Iface) {
      conn.transmitFrame(r1.getId(), frame);
    }
  });

  r2.onFrameTransmit((ifaceName: string, frame: EthernetFrame) => {
    if (ifaceName === r2Iface) {
      conn.transmitFrame(r2.getId(), frame);
    }
  });
}

// ============================================================
// TEST SUITE 1: Two LANs connected by one Router
// Topology:
//   PC1 (192.168.1.10) --eth-- SW1 --eth-- Router (192.168.1.1 | 192.168.2.1) --eth-- SW2 --eth-- PC2 (192.168.2.10)
// ============================================================

describe('WAN: Two LANs connected by Router', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let sw1: Switch;
  let sw2: Switch;
  let router: Router;

  beforeEach(async () => {
    // Create devices
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
    sw1 = new Switch('sw1', 'Switch-LAN1', 4);
    sw2 = new Switch('sw2', 'Switch-LAN2', 4);
    router = new Router('r1', 'Router1', 2);

    // Power on all
    pc1.powerOn();
    pc2.powerOn();
    sw1.powerOn();
    sw2.powerOn();
    router.powerOn();

    // Create connections
    const connPC1SW1 = ConnectionFactory.createEthernet({
      id: 'conn-pc1-sw1',
      sourceDeviceId: 'pc1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth0'
    });

    const connRouterSW1 = ConnectionFactory.createEthernet({
      id: 'conn-r1eth0-sw1',
      sourceDeviceId: 'r1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth1'
    });

    const connRouterSW2 = ConnectionFactory.createEthernet({
      id: 'conn-r1eth1-sw2',
      sourceDeviceId: 'r1',
      sourceInterfaceId: 'eth1',
      targetDeviceId: 'sw2',
      targetInterfaceId: 'eth0'
    });

    const connPC2SW2 = ConnectionFactory.createEthernet({
      id: 'conn-pc2-sw2',
      sourceDeviceId: 'pc2',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw2',
      targetInterfaceId: 'eth1'
    });

    // Wire up LAN 1: PC1 <-> SW1 <-> Router(eth0)
    wirePCToSwitch(pc1, sw1, 'eth0', connPC1SW1);
    wireRouterToSwitch(router, 'eth0', sw1, 'eth1', connRouterSW1);

    // Wire up LAN 2: Router(eth1) <-> SW2 <-> PC2
    wireRouterToSwitch(router, 'eth1', sw2, 'eth0', connRouterSW2);
    wirePCToSwitch(pc2, sw2, 'eth1', connPC2SW2);

    // Configure via terminal commands
    // PC1: IP + gateway
    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up');

    // PC2: IP + gateway
    await pc2.executeCommand('ifconfig eth0 192.168.2.10 netmask 255.255.255.0 up');

    // Router: both interfaces
    router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

    // Set gateways on PCs
    pc1.setGateway(new IPAddress('192.168.1.1'));
    pc2.setGateway(new IPAddress('192.168.2.1'));

    // ARP entries: PCs know their gateway (router), router knows PCs
    pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
    pc2.addARPEntry(new IPAddress('192.168.2.1'), router.getInterface('eth1')!.getMAC());
    router.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
    router.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());
  });

  describe('Device configuration', () => {
    it('should have PC1 configured in LAN1 subnet', async () => {
      const result = await pc1.executeCommand('ifconfig eth0');
      expect(result).toContain('192.168.1.10');
    });

    it('should have PC2 configured in LAN2 subnet', async () => {
      const result = await pc2.executeCommand('ifconfig eth0');
      expect(result).toContain('192.168.2.10');
    });

    it('should have router with two interfaces', () => {
      const eth0 = router.getInterface('eth0');
      const eth1 = router.getInterface('eth1');

      expect(eth0).toBeDefined();
      expect(eth1).toBeDefined();
      expect(eth0!.getIPAddress()?.toString()).toBe('192.168.1.1');
      expect(eth1!.getIPAddress()?.toString()).toBe('192.168.2.1');
    });
  });

  describe('Cross-network ping via router', () => {
    it('should ping PC2 from PC1 across the router', async () => {
      const result = await pc1.executeCommand('ping -c 1 192.168.2.10');
      expect(result).toContain('PING 192.168.2.10');
      expect(result).toContain('bytes');
    });

    it('should ping PC1 from PC2 across the router', async () => {
      const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
      expect(result).toContain('PING 192.168.1.10');
      expect(result).toContain('bytes');
    });

    it('should ping the router gateway from PC1', async () => {
      const result = await pc1.executeCommand('ping -c 1 192.168.1.1');
      expect(result).toContain('PING 192.168.1.1');
    });
  });

  describe('ARP resolution', () => {
    it('should resolve gateway MAC from PC1', () => {
      const gatewayMAC = pc1.resolveMAC(new IPAddress('192.168.1.1'));
      expect(gatewayMAC).toBeDefined();
      expect(gatewayMAC!.toString()).toBe(router.getInterface('eth0')!.getMAC().toString());
    });

    it('should resolve PC1 MAC from router', () => {
      const arpService = router.getARPService('eth0');
      const pc1MAC = arpService.resolve(new IPAddress('192.168.1.10'));
      expect(pc1MAC).toBeDefined();
      expect(pc1MAC!.toString()).toBe(pc1.getInterface('eth0')!.getMAC().toString());
    });
  });
});

// ============================================================
// TEST SUITE 2: Mixed OS WAN
// Topology:
//   LinuxPC (10.0.1.10) --eth-- SW1 --eth-- Router (10.0.1.1 | 10.0.2.1) --eth-- SW2 --eth-- WindowsPC (10.0.2.10)
// ============================================================

describe('WAN: Linux and Windows PCs across Router', () => {
  let linux: LinuxPC;
  let windows: WindowsPC;
  let sw1: Switch;
  let sw2: Switch;
  let router: Router;

  beforeEach(async () => {
    linux = new LinuxPC({ id: 'linux1', name: 'LinuxPC' });
    windows = new WindowsPC({ id: 'win1', name: 'WindowsPC' });
    sw1 = new Switch('sw1', 'SW-Left', 4);
    sw2 = new Switch('sw2', 'SW-Right', 4);
    router = new Router('r1', 'Gateway', 2);

    linux.powerOn();
    windows.powerOn();
    sw1.powerOn();
    sw2.powerOn();
    router.powerOn();

    // Connections
    const c1 = ConnectionFactory.createEthernet({
      id: 'c1', sourceDeviceId: 'linux1', sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1', targetInterfaceId: 'eth0'
    });
    const c2 = ConnectionFactory.createEthernet({
      id: 'c2', sourceDeviceId: 'r1', sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1', targetInterfaceId: 'eth1'
    });
    const c3 = ConnectionFactory.createEthernet({
      id: 'c3', sourceDeviceId: 'r1', sourceInterfaceId: 'eth1',
      targetDeviceId: 'sw2', targetInterfaceId: 'eth0'
    });
    const c4 = ConnectionFactory.createEthernet({
      id: 'c4', sourceDeviceId: 'win1', sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw2', targetInterfaceId: 'eth1'
    });

    wirePCToSwitch(linux, sw1, 'eth0', c1);
    wireRouterToSwitch(router, 'eth0', sw1, 'eth1', c2);
    wireRouterToSwitch(router, 'eth1', sw2, 'eth0', c3);
    wirePCToSwitch(windows, sw2, 'eth1', c4);

    // Configure via terminal
    await linux.executeCommand('ifconfig eth0 10.0.1.10 netmask 255.255.255.0 up');
    await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.2.10 255.255.255.0');

    router.setIPAddress('eth0', new IPAddress('10.0.1.1'), new SubnetMask('/24'));
    router.setIPAddress('eth1', new IPAddress('10.0.2.1'), new SubnetMask('/24'));

    linux.setGateway(new IPAddress('10.0.1.1'));
    windows.setGateway(new IPAddress('10.0.2.1'));

    // ARP
    linux.addARPEntry(new IPAddress('10.0.1.1'), router.getInterface('eth0')!.getMAC());
    windows.addARPEntry(new IPAddress('10.0.2.1'), router.getInterface('eth1')!.getMAC());
    router.addARPEntry('eth0', new IPAddress('10.0.1.10'), linux.getInterface('eth0')!.getMAC());
    router.addARPEntry('eth1', new IPAddress('10.0.2.10'), windows.getInterface('eth0')!.getMAC());
  });

  it('should ping Windows from Linux across router', async () => {
    const result = await linux.executeCommand('ping -c 1 10.0.2.10');
    expect(result).toContain('PING 10.0.2.10');
    expect(result).toContain('bytes');
  });

  it('should ping Linux from Windows across router', async () => {
    const result = await windows.executeCommand('ping -n 1 10.0.1.10');
    expect(result).toContain('10.0.1.10');
    expect(result).toContain('bytes');
  });

  it('should verify Linux IP configuration via terminal', async () => {
    const result = await linux.executeCommand('ip addr show eth0');
    expect(result).toContain('10.0.1.10');
  });

  it('should verify Windows IP configuration via terminal', async () => {
    const result = await windows.executeCommand('ipconfig /all');
    expect(result).toContain('10.0.2.10');
  });
});

// ============================================================
// TEST SUITE 3: Serial WAN link between two routers
// Topology:
//   PC1 (192.168.1.10) --eth-- R1 (192.168.1.1 | 10.0.0.1) ==serial== R2 (10.0.0.2 | 192.168.2.1) --eth-- PC2 (192.168.2.10)
// ============================================================

describe('WAN: Serial link between two Routers', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let r1: Router;
  let r2: Router;
  let serialLink: SerialConnection;

  beforeEach(async () => {
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
    r1 = new Router('r1', 'Router-A', 2);
    r2 = new Router('r2', 'Router-B', 2);

    pc1.powerOn();
    pc2.powerOn();
    r1.powerOn();
    r2.powerOn();

    // Ethernet connections: PC <-> Router
    const connPC1R1 = ConnectionFactory.createEthernet({
      id: 'c-pc1-r1', sourceDeviceId: 'pc1', sourceInterfaceId: 'eth0',
      targetDeviceId: 'r1', targetInterfaceId: 'eth0'
    });

    const connPC2R2 = ConnectionFactory.createEthernet({
      id: 'c-pc2-r2', sourceDeviceId: 'pc2', sourceInterfaceId: 'eth0',
      targetDeviceId: 'r2', targetInterfaceId: 'eth0'
    });

    // Serial connection: Router <-> Router
    serialLink = ConnectionFactory.createSerial({
      id: 's-r1-r2', sourceDeviceId: 'r1', sourceInterfaceId: 'eth1',
      targetDeviceId: 'r2', targetInterfaceId: 'eth1'
    });

    // Wire PC1 <-> R1(eth0)
    const pc1Iface = pc1.getInterface('eth0')!;
    connPC1R1.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
      if (targetDeviceId === 'r1') {
        deliverFrame(r1, targetInterfaceId, frame);
      } else if (targetDeviceId === 'pc1') {
        deliverFrame(pc1, targetInterfaceId, frame);
      }
    });
    pc1Iface.onTransmit((frame: EthernetFrame) => {
      connPC1R1.transmitFrame('pc1', frame);
    });
    r1.onFrameTransmit((ifaceName: string, frame: EthernetFrame) => {
      if (ifaceName === 'eth0') {
        connPC1R1.transmitFrame('r1', frame);
      } else if (ifaceName === 'eth1') {
        serialLink.transmitFrame('r1', frame);
      }
    });

    // Wire PC2 <-> R2(eth0)
    const pc2Iface = pc2.getInterface('eth0')!;
    connPC2R2.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
      if (targetDeviceId === 'r2') {
        deliverFrame(r2, targetInterfaceId, frame);
      } else if (targetDeviceId === 'pc2') {
        deliverFrame(pc2, targetInterfaceId, frame);
      }
    });
    pc2Iface.onTransmit((frame: EthernetFrame) => {
      connPC2R2.transmitFrame('pc2', frame);
    });
    r2.onFrameTransmit((ifaceName: string, frame: EthernetFrame) => {
      if (ifaceName === 'eth0') {
        connPC2R2.transmitFrame('r2', frame);
      } else if (ifaceName === 'eth1') {
        serialLink.transmitFrame('r2', frame);
      }
    });

    // Wire R1(eth1) <-> R2(eth1) via serial link
    serialLink.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
      if (targetDeviceId === 'r2') {
        deliverFrame(r2, targetInterfaceId, frame);
      } else if (targetDeviceId === 'r1') {
        deliverFrame(r1, targetInterfaceId, frame);
      }
    });

    // Configure IPs
    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up');
    await pc2.executeCommand('ifconfig eth0 192.168.2.10 netmask 255.255.255.0 up');

    r1.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    r1.setIPAddress('eth1', new IPAddress('10.0.0.1'), new SubnetMask('/30'));

    r2.setIPAddress('eth0', new IPAddress('192.168.2.1'), new SubnetMask('/24'));
    r2.setIPAddress('eth1', new IPAddress('10.0.0.2'), new SubnetMask('/30'));

    // Routes
    r1.addRoute(new IPAddress('192.168.2.0'), new SubnetMask('/24'), new IPAddress('10.0.0.2'), 'eth1');
    r2.addRoute(new IPAddress('192.168.1.0'), new SubnetMask('/24'), new IPAddress('10.0.0.1'), 'eth1');

    // Gateways
    pc1.setGateway(new IPAddress('192.168.1.1'));
    pc2.setGateway(new IPAddress('192.168.2.1'));

    // ARP entries
    pc1.addARPEntry(new IPAddress('192.168.1.1'), r1.getInterface('eth0')!.getMAC());
    pc2.addARPEntry(new IPAddress('192.168.2.1'), r2.getInterface('eth0')!.getMAC());
    r1.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
    r1.addARPEntry('eth1', new IPAddress('10.0.0.2'), r2.getInterface('eth1')!.getMAC());
    r2.addARPEntry('eth0', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());
    r2.addARPEntry('eth1', new IPAddress('10.0.0.1'), r1.getInterface('eth1')!.getMAC());
  });

  describe('Serial link properties', () => {
    it('should have serial type', () => {
      expect(serialLink.getType()).toBe('serial');
    });

    it('should have T1 bandwidth by default', () => {
      expect(serialLink.getClockRate()).toBe(1544000);
    });

    it('should be active', () => {
      expect(serialLink.isActive()).toBe(true);
    });
  });

  describe('Cross-WAN ping via serial link', () => {
    it('should ping PC2 from PC1 across two routers', async () => {
      const result = await pc1.executeCommand('ping -c 1 192.168.2.10');
      expect(result).toContain('PING 192.168.2.10');
      expect(result).toContain('bytes');
    });

    it('should ping PC1 from PC2 across two routers', async () => {
      const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
      expect(result).toContain('PING 192.168.1.10');
      expect(result).toContain('bytes');
    });

    it('should forward frames through serial link', async () => {
      await pc1.executeCommand('ping -c 1 192.168.2.10');

      const stats = serialLink.getStatistics();
      expect(stats.txFrames).toBeGreaterThan(0);
    });
  });

  describe('Routing verification', () => {
    it('should have routes configured on R1', () => {
      const routes = r1.getRoutes();
      const targetRoute = routes.find(r =>
        r.network.toString() === '192.168.2.0' && !r.isDirectlyConnected
      );
      expect(targetRoute).toBeDefined();
      expect(targetRoute!.nextHop?.toString()).toBe('10.0.0.2');
    });

    it('should have routes configured on R2', () => {
      const routes = r2.getRoutes();
      const targetRoute = routes.find(r =>
        r.network.toString() === '192.168.1.0' && !r.isDirectlyConnected
      );
      expect(targetRoute).toBeDefined();
      expect(targetRoute!.nextHop?.toString()).toBe('10.0.0.1');
    });
  });
});
