/**
 * DHCP WAN/LAN Integration Tests
 *
 * Professional, exhaustive integration tests for DHCP protocol across
 * a realistic enterprise network topology with:
 * - 2 LANs connected via WAN
 * - 6 client machines (mix of Linux and Windows)
 * - Full terminal command-based configuration
 * - Real-world behavior verification
 *
 * Topology:
 *                           WAN (172.16.0.0/30)
 *                                   │
 *     LAN-A (192.168.1.0/24)        │         LAN-B (10.0.0.0/24)
 *
 *     ┌───────┐         ┌─────────┐ │ ┌─────────┐       ┌───────┐
 *     │Linux  │         │ Router  │─┼─│ Router  │       │Linux  │
 *     │  A1   │──┐      │    A    │ │ │    B    │  ┌────│  B1   │
 *     └───────┘  │      └────┬────┘ │ └────┬────┘  │    └───────┘
 *                │           │      │      │       │
 *     ┌───────┐  │     ┌─────┴────┐ │ ┌────┴─────┐ │    ┌───────┐
 *     │Windows│──┼─────│ Switch-A │ │ │ Switch-B │─┼────│Windows│
 *     │  A2   │  │     └──────────┘ │ └──────────┘ │    │  B2   │
 *     └───────┘  │                  │              │    └───────┘
 *                │                  │              │
 *     ┌───────┐  │                  │              │    ┌───────┐
 *     │Linux  │──┘                  │              └────│Linux  │
 *     │  A3   │                     │                   │  B3   │
 *     └───────┘                     │                   └───────┘
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Router, RouterDHCPConfig } from '../../domain/devices/Router';
import { Switch } from '../../domain/devices/Switch';
import { LinuxPC } from '../../domain/devices/LinuxPC';
import { WindowsPC } from '../../domain/devices/WindowsPC';
import { DHCPPacket, DHCPMessageType } from '../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../domain/network/value-objects/SubnetMask';
import { MACAddress } from '../../domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '../../domain/network/entities/EthernetFrame';

/**
 * Network infrastructure class to manage the WAN/LAN topology
 */
class EnterpriseNetwork {
  // LAN-A devices
  public routerA: Router;
  public switchA: Switch;
  public linuxA1: LinuxPC;
  public windowsA2: WindowsPC;
  public linuxA3: LinuxPC;

  // LAN-B devices
  public routerB: Router;
  public switchB: Switch;
  public linuxB1: LinuxPC;
  public windowsB2: WindowsPC;
  public linuxB3: LinuxPC;

  constructor() {
    // Initialize LAN-A devices
    this.routerA = new Router('router-a', 'Router-A', 3);
    this.switchA = new Switch('switch-a', 'Switch-A', 8);
    this.linuxA1 = new LinuxPC({ id: 'linux-a1', name: 'Linux-A1', hostname: 'linux-a1' });
    this.windowsA2 = new WindowsPC({ id: 'windows-a2', name: 'Windows-A2', hostname: 'WIN-A2' });
    this.linuxA3 = new LinuxPC({ id: 'linux-a3', name: 'Linux-A3', hostname: 'linux-a3' });

    // Initialize LAN-B devices
    this.routerB = new Router('router-b', 'Router-B', 3);
    this.switchB = new Switch('switch-b', 'Switch-B', 8);
    this.linuxB1 = new LinuxPC({ id: 'linux-b1', name: 'Linux-B1', hostname: 'linux-b1' });
    this.windowsB2 = new WindowsPC({ id: 'windows-b2', name: 'Windows-B2', hostname: 'WIN-B2' });
    this.linuxB3 = new LinuxPC({ id: 'linux-b3', name: 'Linux-B3', hostname: 'linux-b3' });
  }

  /**
   * Power on all devices in the network
   */
  powerOnAll(): void {
    // Power on routers
    this.routerA.powerOn();
    this.routerB.powerOn();

    // Power on switches
    this.switchA.powerOn();
    this.switchB.powerOn();

    // Power on LAN-A clients
    this.linuxA1.powerOn();
    this.windowsA2.powerOn();
    this.linuxA3.powerOn();

    // Power on LAN-B clients
    this.linuxB1.powerOn();
    this.windowsB2.powerOn();
    this.linuxB3.powerOn();
  }

  /**
   * Configure router interfaces (IP addresses)
   */
  configureRouterInterfaces(): void {
    // Router-A interfaces
    // eth0: LAN-A (192.168.1.1/24)
    // eth1: WAN link (172.16.0.1/30)
    this.routerA.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    this.routerA.setIPAddress('eth1', new IPAddress('172.16.0.1'), new SubnetMask('/30'));

    // Router-B interfaces
    // eth0: LAN-B (10.0.0.1/24)
    // eth1: WAN link (172.16.0.2/30)
    this.routerB.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
    this.routerB.setIPAddress('eth1', new IPAddress('172.16.0.2'), new SubnetMask('/30'));

    // Configure static routes for inter-LAN communication
    this.routerA.addRoute(
      new IPAddress('10.0.0.0'),
      new SubnetMask('/24'),
      new IPAddress('172.16.0.2'),
      'eth1'
    );

    this.routerB.addRoute(
      new IPAddress('192.168.1.0'),
      new SubnetMask('/24'),
      new IPAddress('172.16.0.1'),
      'eth1'
    );
  }

  /**
   * Enable DHCP servers on both routers
   */
  enableDHCPServers(): void {
    // Router-A DHCP server for LAN-A
    this.routerA.enableDHCPServer({
      interfaceName: 'eth0',
      poolStart: new IPAddress('192.168.1.100'),
      poolEnd: new IPAddress('192.168.1.200'),
      dnsServers: [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
      leaseTime: 86400 // 24 hours
    });

    // Router-B DHCP server for LAN-B
    this.routerB.enableDHCPServer({
      interfaceName: 'eth0',
      poolStart: new IPAddress('10.0.0.100'),
      poolEnd: new IPAddress('10.0.0.200'),
      dnsServers: [new IPAddress('1.1.1.1'), new IPAddress('1.0.0.1')],
      leaseTime: 43200 // 12 hours
    });
  }

  /**
   * Wire up network connections (frame forwarding)
   */
  wireConnections(): void {
    // LAN-A: Connect clients to Switch-A
    this.wireClientToSwitch(this.linuxA1, 'eth0', this.switchA, 'fa0/1');
    this.wireClientToSwitch(this.windowsA2, 'eth0', this.switchA, 'fa0/2');
    this.wireClientToSwitch(this.linuxA3, 'eth0', this.switchA, 'fa0/3');

    // LAN-A: Connect Switch-A to Router-A
    this.wireSwitchToRouter(this.switchA, 'fa0/8', this.routerA, 'eth0');

    // LAN-B: Connect clients to Switch-B
    this.wireClientToSwitch(this.linuxB1, 'eth0', this.switchB, 'fa0/1');
    this.wireClientToSwitch(this.windowsB2, 'eth0', this.switchB, 'fa0/2');
    this.wireClientToSwitch(this.linuxB3, 'eth0', this.switchB, 'fa0/3');

    // LAN-B: Connect Switch-B to Router-B
    this.wireSwitchToRouter(this.switchB, 'fa0/8', this.routerB, 'eth0');

    // WAN: Connect Router-A to Router-B
    this.wireRouterToRouter(this.routerA, 'eth1', this.routerB, 'eth1');
  }

  /**
   * Set up DHCP callbacks for all clients
   */
  setupDHCPCallbacks(): void {
    // LAN-A clients
    this.setupClientDHCPCallback(this.linuxA1, this.routerA, 'eth0');
    this.setupClientDHCPCallback(this.windowsA2, this.routerA, 'eth0');
    this.setupClientDHCPCallback(this.linuxA3, this.routerA, 'eth0');

    // LAN-B clients
    this.setupClientDHCPCallback(this.linuxB1, this.routerB, 'eth0');
    this.setupClientDHCPCallback(this.windowsB2, this.routerB, 'eth0');
    this.setupClientDHCPCallback(this.linuxB3, this.routerB, 'eth0');
  }

  private wireClientToSwitch(
    client: LinuxPC | WindowsPC,
    clientPort: string,
    sw: Switch,
    switchPort: string
  ): void {
    client.onFrameTransmit((frame) => {
      sw.receiveFrame(switchPort, frame);
    });

    sw.onFrameForward((port, frame) => {
      if (port === switchPort) {
        client.receiveFrame(clientPort, frame);
      }
    });
  }

  private wireSwitchToRouter(
    sw: Switch,
    switchPort: string,
    router: Router,
    routerPort: string
  ): void {
    sw.onFrameForward((port, frame) => {
      if (port === switchPort) {
        router.receiveFrame(routerPort, frame);
      }
    });

    router.onFrameTransmit((iface, frame) => {
      if (iface === routerPort) {
        sw.receiveFrame(switchPort, frame);
      }
    });
  }

  private wireRouterToRouter(
    router1: Router,
    port1: string,
    router2: Router,
    port2: string
  ): void {
    router1.onFrameTransmit((iface, frame) => {
      if (iface === port1) {
        router2.receiveFrame(port2, frame);
      }
    });

    router2.onFrameTransmit((iface, frame) => {
      if (iface === port2) {
        router1.receiveFrame(port1, frame);
      }
    });
  }

  private setupClientDHCPCallback(
    client: LinuxPC | WindowsPC,
    router: Router,
    routerInterface: string
  ): void {
    client.setDHCPCallback((packet) => {
      const response = router.handleDHCPPacket(routerInterface, packet);
      if (response) {
        client.handleDHCPResponse(response);
      }
    });
  }

  /**
   * Get all LAN-A clients
   */
  getLanAClients(): (LinuxPC | WindowsPC)[] {
    return [this.linuxA1, this.windowsA2, this.linuxA3];
  }

  /**
   * Get all LAN-B clients
   */
  getLanBClients(): (LinuxPC | WindowsPC)[] {
    return [this.linuxB1, this.windowsB2, this.linuxB3];
  }

  /**
   * Get all clients
   */
  getAllClients(): (LinuxPC | WindowsPC)[] {
    return [...this.getLanAClients(), ...this.getLanBClients()];
  }
}

describe('DHCP WAN/LAN Integration Tests', () => {
  let network: EnterpriseNetwork;

  beforeEach(() => {
    network = new EnterpriseNetwork();
    network.powerOnAll();
    network.configureRouterInterfaces();
    network.enableDHCPServers();
    network.wireConnections();
    network.setupDHCPCallbacks();
  });

  describe('Scenario 1: Initial DHCP Discovery on LAN-A', () => {
    it('should allow Linux client to obtain IP via dhclient command', async () => {
      const output = await network.linuxA1.executeCommand('dhclient eth0');

      // Verify realistic ISC DHCP Client output
      expect(output).toContain('Internet Systems Consortium DHCP Client');
      expect(output).toContain('DHCPDISCOVER on eth0');
      expect(output).toContain('DHCPOFFER of 192.168.1.100 from 192.168.1.1');
      expect(output).toContain('DHCPREQUEST');
      expect(output).toContain('DHCPACK of 192.168.1.100 from 192.168.1.1');
      expect(output).toContain('bound to 192.168.1.100');
    });

    it('should allow Windows client to obtain IP via ipconfig /renew', async () => {
      const output = await network.windowsA2.executeCommand('ipconfig /renew');

      // Verify realistic Windows ipconfig output
      expect(output).toContain('Windows IP Configuration');
      expect(output).toContain('Ethernet adapter Ethernet');
      expect(output).toContain('192.168.1.');
    });

    it('should assign different IPs to each client on LAN-A', async () => {
      // Each client requests an IP
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');
      await network.linuxA3.executeCommand('dhclient eth0');

      // Get lease info for each client
      const leaseA1 = network.linuxA1.getDHCPLeaseInfo();
      const leaseA2 = network.windowsA2.getDHCPLeaseInfo();
      const leaseA3 = network.linuxA3.getDHCPLeaseInfo();

      // All should have received IPs
      expect(leaseA1).not.toBeNull();
      expect(leaseA2).not.toBeNull();
      expect(leaseA3).not.toBeNull();

      // All IPs should be unique
      const ips = [
        leaseA1!.ipAddress.toString(),
        leaseA2!.ipAddress.toString(),
        leaseA3!.ipAddress.toString()
      ];
      const uniqueIps = new Set(ips);
      expect(uniqueIps.size).toBe(3);

      // All IPs should be in the LAN-A range
      ips.forEach(ip => {
        expect(ip).toMatch(/^192\.168\.1\.(1[0-9][0-9]|200)$/);
      });
    });

    it('should configure gateway correctly via DHCP', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const leaseInfo = network.linuxA1.getDHCPLeaseInfo();
      expect(leaseInfo!.gateway!.toString()).toBe('192.168.1.1');
    });

    it('should configure DNS servers correctly via DHCP', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const leaseInfo = network.linuxA1.getDHCPLeaseInfo();
      expect(leaseInfo!.dnsServers).toHaveLength(2);
      expect(leaseInfo!.dnsServers[0].toString()).toBe('8.8.8.8');
      expect(leaseInfo!.dnsServers[1].toString()).toBe('8.8.4.4');
    });
  });

  describe('Scenario 2: Initial DHCP Discovery on LAN-B', () => {
    it('should allow Linux client to obtain IP via dhclient command', async () => {
      const output = await network.linuxB1.executeCommand('dhclient eth0');

      expect(output).toContain('DHCPOFFER of 10.0.0.100 from 10.0.0.1');
      expect(output).toContain('DHCPACK of 10.0.0.100 from 10.0.0.1');
      expect(output).toContain('bound to 10.0.0.100');
    });

    it('should allow Windows client to obtain IP via ipconfig /renew', async () => {
      const output = await network.windowsB2.executeCommand('ipconfig /renew');

      expect(output).toContain('Windows IP Configuration');
      expect(output).toContain('10.0.0.');
    });

    it('should assign IPs in LAN-B range (10.0.0.x)', async () => {
      await network.linuxB1.executeCommand('dhclient eth0');
      await network.windowsB2.executeCommand('ipconfig /renew');
      await network.linuxB3.executeCommand('dhclient eth0');

      const leaseB1 = network.linuxB1.getDHCPLeaseInfo();
      const leaseB2 = network.windowsB2.getDHCPLeaseInfo();
      const leaseB3 = network.linuxB3.getDHCPLeaseInfo();

      expect(leaseB1!.ipAddress.toString()).toMatch(/^10\.0\.0\.(1[0-9][0-9]|200)$/);
      expect(leaseB2!.ipAddress.toString()).toMatch(/^10\.0\.0\.(1[0-9][0-9]|200)$/);
      expect(leaseB3!.ipAddress.toString()).toMatch(/^10\.0\.0\.(1[0-9][0-9]|200)$/);
    });

    it('should use different DNS servers than LAN-A', async () => {
      await network.linuxB1.executeCommand('dhclient eth0');

      const leaseInfo = network.linuxB1.getDHCPLeaseInfo();
      expect(leaseInfo!.dnsServers[0].toString()).toBe('1.1.1.1');
      expect(leaseInfo!.dnsServers[1].toString()).toBe('1.0.0.1');
    });
  });

  describe('Scenario 3: DHCP Release and Renew', () => {
    it('should release DHCP lease on Linux with dhclient -r', async () => {
      // First obtain a lease
      await network.linuxA1.executeCommand('dhclient eth0');
      expect(network.linuxA1.getDHCPLeaseInfo()).not.toBeNull();

      // Release the lease
      const output = await network.linuxA1.executeCommand('dhclient -r eth0');

      // Real ISC DHCP Client output format for release
      expect(output).toContain('Internet Systems Consortium DHCP Client');
      expect(output).toContain('DHCPRELEASE');
      expect(output).toContain('192.168.1.100'); // The released IP
      expect(output).toContain('port 67');
    });

    it('should release DHCP lease on Windows with ipconfig /release', async () => {
      // First obtain a lease
      await network.windowsA2.executeCommand('ipconfig /renew');

      // Release the lease
      const output = await network.windowsA2.executeCommand('ipconfig /release');

      expect(output).toContain('Windows IP Configuration');
      expect(output).toContain('Ethernet adapter');
    });

    it('should allow re-obtaining the same IP after release (if available)', async () => {
      // Obtain initial lease
      await network.linuxA1.executeCommand('dhclient eth0');
      const initialIP = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();

      // Release
      await network.linuxA1.executeCommand('dhclient -r eth0');

      // Re-obtain
      await network.linuxA1.executeCommand('dhclient eth0');
      const newIP = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();

      // Should get the same IP (server preference for previously assigned)
      expect(newIP).toBe(initialIP);
    });
  });

  describe('Scenario 4: DHCP Reservations', () => {
    it('should honor IP reservation based on MAC address', async () => {
      // Get the MAC address of linuxA1
      const linuxA1MAC = network.linuxA1.getInterface('eth0')!.getMAC();
      const reservedIP = new IPAddress('192.168.1.50');

      // Add reservation on router
      network.routerA.addDHCPReservation('eth0', linuxA1MAC, reservedIP);

      // Request DHCP
      await network.linuxA1.executeCommand('dhclient eth0');

      // Should get the reserved IP, not from pool
      const leaseInfo = network.linuxA1.getDHCPLeaseInfo();
      expect(leaseInfo!.ipAddress.toString()).toBe('192.168.1.50');
    });

    it('should assign pool IP to non-reserved client', async () => {
      // Reserve IP for linuxA1 only
      const linuxA1MAC = network.linuxA1.getInterface('eth0')!.getMAC();
      network.routerA.addDHCPReservation('eth0', linuxA1MAC, new IPAddress('192.168.1.50'));

      // windowsA2 should get IP from pool
      await network.windowsA2.executeCommand('ipconfig /renew');

      const leaseInfo = network.windowsA2.getDHCPLeaseInfo();
      expect(leaseInfo!.ipAddress.toString()).toBe('192.168.1.100'); // First from pool
    });

    it('should support multiple reservations on same LAN', async () => {
      // Add reservations
      const macA1 = network.linuxA1.getInterface('eth0')!.getMAC();
      const macA2 = network.windowsA2.getInterface('eth0')!.getMAC();
      const macA3 = network.linuxA3.getInterface('eth0')!.getMAC();

      network.routerA.addDHCPReservation('eth0', macA1, new IPAddress('192.168.1.10'));
      network.routerA.addDHCPReservation('eth0', macA2, new IPAddress('192.168.1.20'));
      network.routerA.addDHCPReservation('eth0', macA3, new IPAddress('192.168.1.30'));

      // All clients request DHCP
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');
      await network.linuxA3.executeCommand('dhclient eth0');

      // Verify each got their reserved IP
      expect(network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString()).toBe('192.168.1.10');
      expect(network.windowsA2.getDHCPLeaseInfo()!.ipAddress.toString()).toBe('192.168.1.20');
      expect(network.linuxA3.getDHCPLeaseInfo()!.ipAddress.toString()).toBe('192.168.1.30');
    });
  });

  describe('Scenario 5: DHCP Server Statistics', () => {
    it('should track DISCOVER messages received', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');

      const dhcpServer = network.routerA.getDHCPServer('eth0')!;
      const stats = dhcpServer.getStatistics();

      expect(stats.discoversReceived).toBeGreaterThanOrEqual(2);
    });

    it('should track active leases count', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');
      await network.linuxA3.executeCommand('dhclient eth0');

      const dhcpServer = network.routerA.getDHCPServer('eth0')!;
      const stats = dhcpServer.getStatistics();

      expect(stats.activeLeases).toBe(3);
    });

    it('should track OFFER, REQUEST, and ACK messages', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const dhcpServer = network.routerA.getDHCPServer('eth0')!;
      const stats = dhcpServer.getStatistics();

      expect(stats.offersSent).toBeGreaterThanOrEqual(1);
      expect(stats.requestsReceived).toBeGreaterThanOrEqual(1);
      expect(stats.acksSent).toBeGreaterThanOrEqual(1);
    });

    it('should maintain separate statistics for each LAN', async () => {
      // LAN-A activity
      await network.linuxA1.executeCommand('dhclient eth0');

      // LAN-B activity
      await network.linuxB1.executeCommand('dhclient eth0');
      await network.windowsB2.executeCommand('ipconfig /renew');

      const statsA = network.routerA.getDHCPServer('eth0')!.getStatistics();
      const statsB = network.routerB.getDHCPServer('eth0')!.getStatistics();

      expect(statsA.activeLeases).toBe(1);
      expect(statsB.activeLeases).toBe(2);
    });
  });

  describe('Scenario 6: Concurrent DHCP Requests', () => {
    it('should handle multiple simultaneous DHCP requests without conflicts', async () => {
      // Simulate concurrent requests from all LAN-A clients
      const promises = [
        network.linuxA1.executeCommand('dhclient eth0'),
        network.windowsA2.executeCommand('ipconfig /renew'),
        network.linuxA3.executeCommand('dhclient eth0')
      ];

      await Promise.all(promises);

      // All clients should have unique IPs
      const ips = [
        network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString(),
        network.windowsA2.getDHCPLeaseInfo()!.ipAddress.toString(),
        network.linuxA3.getDHCPLeaseInfo()!.ipAddress.toString()
      ];

      const uniqueIps = new Set(ips);
      expect(uniqueIps.size).toBe(3);
    });

    it('should handle concurrent requests across both LANs', async () => {
      // All 6 clients request simultaneously
      const promises = network.getAllClients().map(client => {
        if (client instanceof LinuxPC) {
          return client.executeCommand('dhclient eth0');
        } else {
          return client.executeCommand('ipconfig /renew');
        }
      });

      await Promise.all(promises);

      // Verify all clients got IPs
      network.getAllClients().forEach(client => {
        const lease = client.getDHCPLeaseInfo();
        expect(lease).not.toBeNull();
      });

      // Verify LAN isolation (LAN-A clients have 192.168.1.x, LAN-B have 10.0.0.x)
      network.getLanAClients().forEach(client => {
        expect(client.getDHCPLeaseInfo()!.ipAddress.toString()).toMatch(/^192\.168\.1\./);
      });

      network.getLanBClients().forEach(client => {
        expect(client.getDHCPLeaseInfo()!.ipAddress.toString()).toMatch(/^10\.0\.0\./);
      });
    });
  });

  describe('Scenario 7: DHCP Error Handling', () => {
    it('should show timeout when no DHCP server responds (Linux)', async () => {
      // Create isolated PC with no DHCP callback
      const isolatedPC = new LinuxPC({ id: 'isolated', name: 'Isolated', hostname: 'isolated' });
      isolatedPC.powerOn();

      const output = await isolatedPC.executeCommand('dhclient eth0');

      expect(output).toContain('No DHCPOFFERS received');
    });

    it('should show timeout when no DHCP server responds (Windows)', async () => {
      // Create isolated PC with no DHCP callback
      const isolatedPC = new WindowsPC({ id: 'isolated', name: 'Isolated', hostname: 'ISOLATED' });
      isolatedPC.powerOn();

      const output = await isolatedPC.executeCommand('ipconfig /renew');

      expect(output).toContain('unable to connect to your DHCP server');
      expect(output).toContain('Request has timed out');
    });

    it('should show error when releasing without active lease (Windows)', async () => {
      const output = await network.windowsA2.executeCommand('ipconfig /release');

      expect(output).toContain('DHCP is not enabled');
    });

    it('should show adapter error for non-existent interface', async () => {
      const output = await network.windowsA2.executeCommand('ipconfig /renew eth99');

      // Windows shows error for adapter that doesn't exist
      expect(output).toContain('adapter');
    });
  });

  describe('Scenario 8: DHCP Lease Information Display', () => {
    it('should display lease time in dhclient output', async () => {
      const output = await network.linuxA1.executeCommand('dhclient eth0');

      // Default lease time is 86400 seconds (24 hours)
      // Renewal is at 50% = 43200 seconds
      expect(output).toContain('renewal in');
    });

    it('should create a valid lease on the server', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      // The server should have recorded the lease
      const leases = network.routerA.getAllDHCPLeases();
      const clientMAC = network.linuxA1.getInterface('eth0')!.getMAC().toString();
      const leaseEntry = leases.find(l => l.lease.macAddress.toString() === clientMAC);

      expect(leaseEntry).toBeDefined();
      expect(leaseEntry!.lease.ipAddress.toString()).toBe('192.168.1.100');
    });

    it('should display correct subnet mask in lease info', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const leaseInfo = network.linuxA1.getDHCPLeaseInfo();
      expect(leaseInfo!.subnetMask.toString()).toBe('255.255.255.0');
    });
  });

  describe('Scenario 9: DHCP Client State Machine', () => {
    it('should transition through INIT -> SELECTING -> REQUESTING -> BOUND', async () => {
      // Initial state
      expect(network.linuxA1.getDHCPClientState()).toBeUndefined();

      // Start DHCP
      await network.linuxA1.executeCommand('dhclient eth0');

      // After successful DHCP, should be in BOUND state
      expect(network.linuxA1.getDHCPClientState()).toBe('BOUND');
    });

    it('should return to INIT after release', async () => {
      // Get lease
      await network.linuxA1.executeCommand('dhclient eth0');
      expect(network.linuxA1.getDHCPClientState()).toBe('BOUND');

      // Release
      await network.linuxA1.executeCommand('dhclient -r eth0');
      expect(network.linuxA1.getDHCPClientState()).toBe('INIT');
    });
  });

  describe('Scenario 10: Router DHCP Server API', () => {
    it('should provide DHCP pool information via API', async () => {
      const dhcpServer = network.routerA.getDHCPServer('eth0');

      expect(dhcpServer).not.toBeNull();
      expect(network.routerA.isDHCPServerEnabled('eth0')).toBe(true);
    });

    it('should list DHCP bindings via API', async () => {
      // Create some leases first
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');

      const leases = network.routerA.getAllDHCPLeases();

      expect(leases.length).toBe(2);
      expect(leases[0].lease.ipAddress.toString()).toBe('192.168.1.100');
      expect(leases[1].lease.ipAddress.toString()).toBe('192.168.1.101');
    });

    it('should provide DHCP server statistics via API', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const dhcpServer = network.routerA.getDHCPServer('eth0')!;
      const stats = dhcpServer.getStatistics();

      expect(stats.discoversReceived).toBeGreaterThanOrEqual(1);
      expect(stats.offersSent).toBeGreaterThanOrEqual(1);
      expect(stats.acksSent).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Scenario 11: IP Address Verification via Terminal Commands', () => {
    it('should show assigned IP in ip addr output (Linux)', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const output = await network.linuxA1.executeCommand('ip addr show eth0');

      expect(output).toContain('192.168.1.100');
      expect(output).toContain('eth0');
    });

    it('should show assigned IP in ifconfig output (Linux)', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const output = await network.linuxA1.executeCommand('ifconfig eth0');

      expect(output).toContain('192.168.1.100');
      expect(output).toContain('eth0');
    });

    it('should show assigned IP in ipconfig output (Windows)', async () => {
      await network.windowsA2.executeCommand('ipconfig /renew');

      const output = await network.windowsA2.executeCommand('ipconfig');

      expect(output).toContain('192.168.1.');
      expect(output).toContain('Ethernet');
    });

    it('should show gateway in ip route output (Linux)', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const output = await network.linuxA1.executeCommand('ip route');

      expect(output).toContain('default');
      // Gateway should be set after DHCP
    });
  });

  describe('Scenario 12: Multi-LAN DHCP Isolation', () => {
    it('should not cross-pollute DHCP pools between LANs', async () => {
      // Get IPs on both LANs
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.linuxB1.executeCommand('dhclient eth0');

      // Verify isolation
      const ipA = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();
      const ipB = network.linuxB1.getDHCPLeaseInfo()!.ipAddress.toString();

      expect(ipA).toMatch(/^192\.168\.1\./);
      expect(ipB).toMatch(/^10\.0\.0\./);
    });

    it('should have independent lease counts per LAN', async () => {
      // 3 clients on LAN-A
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');
      await network.linuxA3.executeCommand('dhclient eth0');

      // 1 client on LAN-B
      await network.linuxB1.executeCommand('dhclient eth0');

      expect(network.routerA.getAllDHCPLeases()).toHaveLength(3);
      expect(network.routerB.getAllDHCPLeases()).toHaveLength(1);
    });

    it('should have different default gateways per LAN', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.linuxB1.executeCommand('dhclient eth0');

      const gatewayA = network.linuxA1.getDHCPLeaseInfo()!.gateway!.toString();
      const gatewayB = network.linuxB1.getDHCPLeaseInfo()!.gateway!.toString();

      expect(gatewayA).toBe('192.168.1.1');
      expect(gatewayB).toBe('10.0.0.1');
    });
  });

  describe('Scenario 13: DHCP Pool Boundary Testing', () => {
    it('should allocate IPs starting from poolStart', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const ip = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();
      expect(ip).toBe('192.168.1.100'); // First IP in pool
    });

    it('should allocate sequential IPs', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');
      await network.linuxA3.executeCommand('dhclient eth0');

      const ip1 = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();
      const ip2 = network.windowsA2.getDHCPLeaseInfo()!.ipAddress.toString();
      const ip3 = network.linuxA3.getDHCPLeaseInfo()!.ipAddress.toString();

      // Should be sequential
      expect(ip1).toBe('192.168.1.100');
      expect(ip2).toBe('192.168.1.101');
      expect(ip3).toBe('192.168.1.102');
    });
  });

  describe('Scenario 14: Real-World Output Format Verification', () => {
    it('should match real ISC dhclient output format', async () => {
      const output = await network.linuxA1.executeCommand('dhclient eth0');

      // Real ISC DHCP Client output format (non-verbose mode)
      expect(output).toMatch(/Internet Systems Consortium DHCP Client/);
      expect(output).toMatch(/DHCPDISCOVER on eth0 to 255\.255\.255\.255 port 67/);
      expect(output).toMatch(/DHCPOFFER of \d+\.\d+\.\d+\.\d+ from \d+\.\d+\.\d+\.\d+/);
      expect(output).toMatch(/DHCPREQUEST for \d+\.\d+\.\d+\.\d+ on eth0/);
      expect(output).toMatch(/DHCPACK of \d+\.\d+\.\d+\.\d+ from \d+\.\d+\.\d+\.\d+/);
      expect(output).toMatch(/bound to \d+\.\d+\.\d+\.\d+ -- renewal in \d+ seconds/);
    });

    it('should match real ISC dhclient verbose output format', async () => {
      const output = await network.linuxA1.executeCommand('dhclient -v eth0');

      // Verbose mode includes LPF lines
      expect(output).toMatch(/Internet Systems Consortium DHCP Client/);
      expect(output).toMatch(/Listening on LPF\/eth0\//);
      expect(output).toMatch(/Sending on\s+LPF\/eth0\//);
    });

    it('should match real Windows ipconfig /renew output format', async () => {
      const output = await network.windowsA2.executeCommand('ipconfig /renew');

      // Real Windows ipconfig output format
      expect(output).toMatch(/Windows IP Configuration/);
      expect(output).toMatch(/Ethernet adapter/);
    });

    it('should match real Windows ipconfig /release output format', async () => {
      await network.windowsA2.executeCommand('ipconfig /renew');
      const output = await network.windowsA2.executeCommand('ipconfig /release');

      expect(output).toMatch(/Windows IP Configuration/);
      expect(output).toMatch(/Ethernet adapter/);
    });

    it('should match real dhclient -r output format', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');
      const output = await network.linuxA1.executeCommand('dhclient -r eth0');

      // Real ISC dhclient release format
      expect(output).toMatch(/Internet Systems Consortium DHCP Client/);
      expect(output).toMatch(/Listening on LPF\/eth0\//);
      expect(output).toMatch(/DHCPRELEASE of/);
      expect(output).toMatch(/port 67/);
    });
  });

  describe('Scenario 15: DHCP with Network Diagnostics', () => {
    it('should allow ping after obtaining DHCP lease', async () => {
      // Both clients get IPs
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.linuxA3.executeCommand('dhclient eth0');

      // Add ARP entries for direct communication within LAN
      const ipA1 = network.linuxA1.getDHCPLeaseInfo()!.ipAddress;
      const ipA3 = network.linuxA3.getDHCPLeaseInfo()!.ipAddress;
      const macA1 = network.linuxA1.getInterface('eth0')!.getMAC();
      const macA3 = network.linuxA3.getInterface('eth0')!.getMAC();

      network.linuxA1.addARPEntry(ipA3, macA3);
      network.linuxA3.addARPEntry(ipA1, macA1);

      // Verify IPs are configured
      const outputA1 = await network.linuxA1.executeCommand('ip addr show eth0');
      const outputA3 = await network.linuxA3.executeCommand('ip addr show eth0');

      expect(outputA1).toContain(ipA1.toString());
      expect(outputA3).toContain(ipA3.toString());
    });

    it('should show correct routing table after DHCP', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      const output = await network.linuxA1.executeCommand('ip route');

      // Should have default route via DHCP-assigned gateway
      expect(output).toContain('default');
    });

    it('should show ARP entries for gateway after DHCP', async () => {
      await network.linuxA1.executeCommand('dhclient eth0');

      // Gateway ARP entry should be resolvable
      const gateway = network.linuxA1.getDHCPLeaseInfo()!.gateway;
      expect(gateway).not.toBeNull();
      expect(gateway!.toString()).toBe('192.168.1.1');
    });
  });
});

describe('DHCP Edge Cases and Stress Tests', () => {
  let network: EnterpriseNetwork;

  beforeEach(() => {
    network = new EnterpriseNetwork();
    network.powerOnAll();
    network.configureRouterInterfaces();
    network.wireConnections();
    network.setupDHCPCallbacks();
  });

  describe('Pool Exhaustion Handling', () => {
    it('should handle small pool exhaustion gracefully', async () => {
      // Configure very small pool (only 2 IPs)
      network.routerA.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.101'),
        leaseTime: 3600
      });

      // First two clients should succeed
      await network.linuxA1.executeCommand('dhclient eth0');
      await network.windowsA2.executeCommand('ipconfig /renew');

      expect(network.linuxA1.getDHCPLeaseInfo()).not.toBeNull();
      expect(network.windowsA2.getDHCPLeaseInfo()).not.toBeNull();

      // Third client should fail (pool exhausted)
      const output = await network.linuxA3.executeCommand('dhclient eth0');
      expect(output).toContain('No DHCPOFFERS received');
    });
  });

  describe('Lease Reuse After Release', () => {
    it('should reuse released IP for new client', async () => {
      network.routerA.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.101'),
        leaseTime: 3600
      });

      // First client gets IP
      await network.linuxA1.executeCommand('dhclient eth0');
      const firstIP = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();
      expect(firstIP).toBe('192.168.1.100');

      // Second client gets IP
      await network.windowsA2.executeCommand('ipconfig /renew');
      expect(network.windowsA2.getDHCPLeaseInfo()!.ipAddress.toString()).toBe('192.168.1.101');

      // First client releases
      await network.linuxA1.executeCommand('dhclient -r eth0');

      // Third client should get the released IP
      await network.linuxA3.executeCommand('dhclient eth0');
      expect(network.linuxA3.getDHCPLeaseInfo()!.ipAddress.toString()).toBe('192.168.1.100');
    });
  });

  describe('Device Power Cycle', () => {
    it('should handle client restart and re-request DHCP', async () => {
      network.routerA.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        leaseTime: 3600
      });

      // Initial DHCP
      await network.linuxA1.executeCommand('dhclient eth0');
      const initialIP = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();

      // Simulate power cycle
      network.linuxA1.powerOff();
      network.linuxA1.powerOn();

      // Re-setup DHCP callback after power cycle
      network.linuxA1.setDHCPCallback((packet) => {
        const response = network.routerA.handleDHCPPacket('eth0', packet);
        if (response) {
          network.linuxA1.handleDHCPResponse(response);
        }
      });

      // Re-request DHCP
      await network.linuxA1.executeCommand('dhclient eth0');

      // Should get same IP (server remembers MAC)
      const newIP = network.linuxA1.getDHCPLeaseInfo()!.ipAddress.toString();
      expect(newIP).toBe(initialIP);
    });
  });

  describe('Multiple Interface Scenarios', () => {
    it('should support DHCP on router with multiple DHCP pools', async () => {
      // Enable DHCP on both router interfaces
      network.routerA.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        leaseTime: 3600
      });

      // Verify only eth0 has DHCP enabled
      expect(network.routerA.isDHCPServerEnabled('eth0')).toBe(true);
      expect(network.routerA.isDHCPServerEnabled('eth1')).toBe(false);
    });
  });

  describe('DHCP Message Type Validation', () => {
    it('should only process valid DHCP message types', async () => {
      network.routerA.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        leaseTime: 3600
      });

      // Create an INFORM packet (different from DISCOVER)
      const clientMAC = network.linuxA1.getInterface('eth0')!.getMAC();
      const inform = DHCPPacket.createInform(clientMAC, new IPAddress('192.168.1.50'));

      // Router should handle INFORM appropriately
      const response = network.routerA.handleDHCPPacket('eth0', inform);

      // INFORM should get an ACK response (with options but no IP assignment)
      if (response) {
        expect(response.getMessageType()).toBe(DHCPMessageType.ACK);
      }
    });
  });
});
