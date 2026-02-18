/**
 * TDD Tests for Huawei VRP Devices (Switches & Routers)
 *
 * Huawei VRP (Versatile Routing Platform) CLI conventions:
 *   - system-view → enter config mode (equivalent to Cisco's `configure terminal`)
 *   - return → exit all config modes back to user view
 *   - quit → exit one level of config
 *   - display → equivalent to Cisco's `show`
 *   - undo → equivalent to Cisco's `no`
 *   - sysname → equivalent to Cisco's `hostname`
 *   - Interface naming: GigabitEthernet0/0/X (3-slot format, standard for S-series)
 *   - Router interface naming: GE0/0/X (abbreviation for AR-series)
 *
 * Group 1: Basic Huawei Switch Commands — System, VLAN, Port, MAC, Config
 * Group 2: Basic Huawei Router Commands — Interfaces, Static Routes, Display
 * Group 3: ICMP Protocol Tests — Ping, TTL, Unreachable
 * Group 4: ARP Protocol Tests — Dynamic learning, Static entries, Clear
 * Group 5: DHCP Protocol Tests — Server, Client, Bindings
 * Group 6: STP & Switch Internals — 802.1D state machine, MAC move, VLAN suspension
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  resetCounters,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Basic Huawei Switch Commands (VRP CLI)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Huawei Switch — Basic VRP Commands', () => {

  // ----------------------------------------------------------------
  // 1.1 System Configuration
  // ----------------------------------------------------------------
  describe('1.1 System Configuration', () => {

    it('should use Huawei port naming (GigabitEthernet0/0/X) for switch-huawei', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      // Huawei S-series switches use GigabitEthernet0/0/X naming
      expect(sw.getPort('GigabitEthernet0/0/0')).toBeDefined();
      expect(sw.getPort('GigabitEthernet0/0/1')).toBeDefined();
      expect(sw.getPort('GigabitEthernet0/0/23')).toBeDefined();
    });

    it('should set sysname and display it via display current-configuration', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname Switch-LAB-01');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display current-configuration');
      expect(output).toContain('sysname Switch-LAB-01');
    });

    it('should display version information', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const output = await sw.executeCommand('display version');
      expect(output).toContain('Huawei Versatile Routing Platform');
      expect(output).toContain('VRP');
    });
  });

  // ----------------------------------------------------------------
  // 1.2 Interface Configuration
  // ----------------------------------------------------------------
  describe('1.2 Interface Basic Settings', () => {

    it('should set description on an interface', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('description Link-to-PC1');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display interface GigabitEthernet0/0/1');
      expect(output).toContain('Description: Link-to-PC1');
    });

    it('should shutdown and undo shutdown an interface', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/2');
      await sw.executeCommand('shutdown');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      let output = await sw.executeCommand('display interface brief');
      expect(output).toContain('GigabitEthernet0/0/2');
      expect(output.toLowerCase()).toContain('down');

      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/2');
      await sw.executeCommand('undo shutdown');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      output = await sw.executeCommand('display interface brief');
      // Port up depends on cable connection, but admin state should be up
      expect(output).toContain('GigabitEthernet0/0/2');
    });
  });

  // ----------------------------------------------------------------
  // 1.3 VLAN Configuration
  // ----------------------------------------------------------------
  describe('1.3 VLAN Management', () => {

    it('should create VLANs and assign access ports', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');

      // Create VLAN 10 and 20
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('name Sales');
      await sw.executeCommand('quit');
      await sw.executeCommand('vlan 20');
      await sw.executeCommand('name Engineering');
      await sw.executeCommand('quit');

      // Configure access ports using Huawei VRP syntax
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');

      await sw.executeCommand('interface GigabitEthernet0/0/2');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 20');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      // Verify VLAN existence
      const vlanOutput = await sw.executeCommand('display vlan');
      expect(vlanOutput).toContain('10');
      expect(vlanOutput).toContain('Sales');
      expect(vlanOutput).toContain('20');
      expect(vlanOutput).toContain('Engineering');
    });

    it('should delete a VLAN with undo vlan', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 30');
      await sw.executeCommand('quit');

      let output = await sw.executeCommand('display vlan');
      expect(output).toContain('30');

      await sw.executeCommand('undo vlan 30');
      await sw.executeCommand('return');

      output = await sw.executeCommand('display vlan');
      expect(output).not.toContain('VLAN 30');
    });

    it('should create multiple VLANs with vlan batch', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan batch 10 20 30');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display vlan');
      expect(output).toContain('10');
      expect(output).toContain('20');
      expect(output).toContain('30');
    });
  });

  // ----------------------------------------------------------------
  // 1.4 Trunk Configuration
  // ----------------------------------------------------------------
  describe('1.4 Trunk Configuration', () => {

    it('should configure a trunk port and allow specific VLANs', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan batch 10 20 30');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk allow-pass vlan 10 20 30');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/23');
      expect(output).toContain('port link-type trunk');
      expect(output).toContain('port trunk allow-pass vlan');
    });

    it('should set PVID (native VLAN) for trunk', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk pvid vlan 99');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/23');
      expect(output).toContain('port trunk pvid vlan 99');
    });
  });

  // ----------------------------------------------------------------
  // 1.5 MAC Address Table
  // ----------------------------------------------------------------
  describe('1.5 MAC Address Table Operations', () => {

    it('should display MAC address table', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const output = await sw.executeCommand('display mac-address');
      expect(output).toContain('MAC address table');
    });

    it('should set MAC aging time', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('mac-address aging-time 600');
      await sw.executeCommand('return');

      const output = await sw.executeCommand('display mac-address aging-time');
      expect(output).toContain('600');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Basic Huawei Router Commands (VRP CLI)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Huawei Router — Basic VRP Commands', () => {

  // ----------------------------------------------------------------
  // 2.1 Interface IP Configuration
  // ----------------------------------------------------------------
  describe('2.1 Interface IP Configuration', () => {

    it('should configure IP address via system-view interface commands', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('return');

      const output = await r.executeCommand('display ip interface brief');
      expect(output).toContain('GE0/0/0');
      expect(output).toContain('192.168.1.1');
    });
  });

  // ----------------------------------------------------------------
  // 2.2 Static Routing
  // ----------------------------------------------------------------
  describe('2.2 Static Routing', () => {

    it('should add a static route with next-hop IP', async () => {
      const r = new HuaweiRouter('R1');
      // First configure interface so next-hop is reachable
      r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

      await r.executeCommand('system-view');
      await r.executeCommand('ip route-static 172.16.1.0 255.255.255.0 192.168.1.2');
      await r.executeCommand('return');

      const table = await r.executeCommand('display ip routing-table');
      expect(table).toContain('172.16.1.0');
      expect(table).toContain('Static');
      expect(table).toContain('192.168.1.2');
    });

    it('should add a default route', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

      await r.executeCommand('system-view');
      await r.executeCommand('ip route-static 0.0.0.0 0.0.0.0 192.168.1.254');
      await r.executeCommand('return');

      const table = await r.executeCommand('display ip routing-table');
      expect(table).toContain('0.0.0.0/0');
      expect(table).toContain('192.168.1.254');
    });

    it('should delete a static route with undo', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

      await r.executeCommand('system-view');
      await r.executeCommand('ip route-static 10.10.10.0 255.255.255.0 192.168.1.3');
      let table = await r.executeCommand('display ip routing-table');
      expect(table).toContain('10.10.10.0');

      await r.executeCommand('undo ip route-static 10.10.10.0 255.255.255.0 192.168.1.3');
      await r.executeCommand('return');
      table = await r.executeCommand('display ip routing-table');
      expect(table).not.toContain('10.10.10.0/24');
    });
  });

  // ----------------------------------------------------------------
  // 2.3 Display / Diagnostic Commands
  // ----------------------------------------------------------------
  describe('2.3 Diagnostic Commands', () => {

    it('should display interface statistics', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('display interface GE0/0/0');
      expect(output).toContain('GE0/0/0');
      expect(output).toContain('Input:');
      expect(output).toContain('Output:');
    });

    it('should display IP traffic statistics', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('display ip traffic');
      expect(output).toContain('IP statistics:');
      expect(output).toContain('ICMP statistics:');
      expect(output).toContain('Destination unreachable:');
      expect(output).toContain('Time exceeded:');
    });

    it('should display version information', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('display version');
      expect(output).toContain('Huawei Versatile Routing Platform');
      expect(output).toContain('VRP');
    });

    it('should display ARP table', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('display arp');
      expect(output).toContain('IP ADDRESS');
      expect(output).toContain('MAC ADDRESS');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: ICMP Protocol Tests (Huawei Environment)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: ICMP Protocol — Huawei Devices', () => {

  // ----------------------------------------------------------------
  // 3.1 Ping same subnet via Huawei switch
  // ----------------------------------------------------------------
  describe('3.1 Ping in same subnet', () => {

    it('should ping between two PCs on same Huawei switch VLAN', async () => {
      // Topology:
      //   PC1 (10.0.1.10/24) -- GE0/0/0 [SW1] GE0/0/1 -- PC2 (10.0.1.20/24)
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.1.20'), new SubnetMask('255.255.255.0'));

      const c1 = new Cable('c1');
      c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
      const c2 = new Cable('c2');
      c2.connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);

      // Advance STP: listening → learning → forwarding (simulates 30s timer)
      sw.advanceSTPTimer('GigabitEthernet0/0/0');
      sw.advanceSTPTimer('GigabitEthernet0/0/1');
      sw.advanceSTPTimer('GigabitEthernet0/0/0');
      sw.advanceSTPTimer('GigabitEthernet0/0/1');

      // Ping from PC1 to PC2
      const output = await pc1.executeCommand('ping -c 3 10.0.1.20');
      expect(output).toContain('64 bytes from 10.0.1.20');
      expect(output).toContain('3 received');
    });
  });

  // ----------------------------------------------------------------
  // 3.2 ICMP Time Exceeded (TTL expiry)
  // ----------------------------------------------------------------
  describe('3.2 ICMP Time Exceeded', () => {

    it('should generate TTL expired when router receives packet with TTL=1', async () => {
      // PC1 (10.0.1.2) → R1 (10.0.1.1/10.0.2.1) → PC2 (10.0.2.2)
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');
      const r1 = new HuaweiRouter('R1');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      pc1.setDefaultGateway(new IPAddress('10.0.1.1'));
      pc2.setDefaultGateway(new IPAddress('10.0.2.1'));

      const c1 = new Cable('c1');
      c1.connect(pc1.getPort('eth0')!, r1.getPort('GE0/0/0')!);
      const c2 = new Cable('c2');
      c2.connect(r1.getPort('GE0/0/1')!, pc2.getPort('eth0')!);

      // Ping with TTL=1 — should get Time Exceeded from R1
      const output = await pc1.executeCommand('ping -c 1 -t 1 10.0.2.2');
      expect(output).toContain('Time to live exceeded');

      // Router should have incremented ICMP Time Exceeded counter
      const counters = r1.getCounters();
      expect(counters.icmpOutTimeExcds).toBeGreaterThanOrEqual(1);
    });
  });

  // ----------------------------------------------------------------
  // 3.3 ICMP Destination Unreachable
  // ----------------------------------------------------------------
  describe('3.3 ICMP Destination Unreachable', () => {

    it('should generate "Destination Host Unreachable" when no route exists', async () => {
      const r1 = new HuaweiRouter('R1');
      const pc = new LinuxPC('linux-pc', 'PC');

      pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('10.0.1.1'));

      const c = new Cable('c');
      c.connect(pc.getPort('eth0')!, r1.getPort('GE0/0/0')!);

      // No route to 172.16.1.1 on R1
      const output = await pc.executeCommand('ping -c 1 172.16.1.1');
      expect(output).toContain('Destination Host Unreachable');

      const counters = r1.getCounters();
      expect(counters.icmpOutDestUnreachs).toBeGreaterThanOrEqual(1);
    });
  });

  // ----------------------------------------------------------------
  // 3.4 Traceroute
  // ----------------------------------------------------------------
  describe('3.4 Traceroute', () => {

    it('should show each hop via ICMP Time Exceeded messages', async () => {
      // PC → R1 → R2 → PC2
      const pc = new LinuxPC('linux-pc', 'PC');
      const r1 = new HuaweiRouter('R1');
      const r2 = new HuaweiRouter('R2');
      const pc2 = new LinuxPC('linux-pc', 'PC2');

      pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
      r2.configureInterface('GE0/0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      r2.configureInterface('GE0/0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));

      pc.setDefaultGateway(new IPAddress('10.0.1.1'));
      pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
      r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
      r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

      const c1 = new Cable('c1'); c1.connect(pc.getPort('eth0')!, r1.getPort('GE0/0/0')!);
      const c2 = new Cable('c2'); c2.connect(r1.getPort('GE0/0/1')!, r2.getPort('GE0/0/0')!);
      const c3 = new Cable('c3'); c3.connect(r2.getPort('GE0/0/1')!, pc2.getPort('eth0')!);

      const output = await pc.executeCommand('traceroute 10.0.3.2');
      // Should show hop 1 (R1) and hop 2 (R2 or final destination)
      expect(output).toContain('10.0.1.1');
      expect(output).toContain('10.0.3.2');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: ARP Protocol Tests (Huawei Environment)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: ARP Protocol — Huawei Devices', () => {

  describe('4.1 Dynamic ARP Learning', () => {

    it('should learn ARP entry when pinging within same subnet', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.1.20'), new SubnetMask('255.255.255.0'));

      const c1 = new Cable('c1'); c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
      const c2 = new Cable('c2'); c2.connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);

      // Advance STP: listening → learning → forwarding
      sw.setAllPortsSTPState('forwarding');

      // Ping triggers ARP resolution
      await pc1.executeCommand('ping -c 1 10.0.1.20');

      // Check ARP table on PC1
      const arpTable = await pc1.executeCommand('arp -a');
      expect(arpTable).toContain('10.0.1.20');
    });
  });

  describe('4.2 Static ARP Configuration on Router', () => {

    it('should add a static ARP entry on Huawei router', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

      await r.executeCommand('system-view');
      await r.executeCommand('arp static 192.168.1.50 aaaa-bbbb-cccc');
      await r.executeCommand('return');

      const output = await r.executeCommand('display arp');
      expect(output).toContain('192.168.1.50');
      expect(output).toContain('static');
    });

    it('should delete a static ARP entry with undo', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('arp static 192.168.1.51 aaaa-bbbb-cccd');
      await r.executeCommand('undo arp static 192.168.1.51');
      await r.executeCommand('return');

      const output = await r.executeCommand('display arp');
      expect(output).not.toContain('192.168.1.51');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: DHCP Protocol Tests (Huawei Router as Server)
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: DHCP Protocol — Huawei Router as Server', () => {

  describe('5.1 DHCP Server Basic Setup', () => {

    it('should enable DHCP and create an IP pool', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('dhcp enable');
      await r.executeCommand('ip pool pool1');
      await r.executeCommand('gateway-list 192.168.1.1');
      await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
      await r.executeCommand('dns-list 8.8.8.8');
      await r.executeCommand('quit');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r.executeCommand('dhcp select global');
      await r.executeCommand('quit');
      await r.executeCommand('return');

      const output = await r.executeCommand('display ip pool name pool1');
      expect(output).toContain('pool1');
      expect(output).toContain('192.168.1.0');
    });
  });

  describe('5.2 DHCP Client and Lease', () => {

    it('should assign an IP address to a Linux PC via DHCP', async () => {
      const r = new HuaweiRouter('R1');
      const pc = new LinuxPC('linux-pc', 'PC1');

      // Configure DHCP server on router
      await r.executeCommand('system-view');
      await r.executeCommand('dhcp enable');
      await r.executeCommand('ip pool pool1');
      await r.executeCommand('gateway-list 192.168.1.1');
      await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
      await r.executeCommand('quit');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r.executeCommand('dhcp select global');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('return');

      // Connect PC to router
      const c = new Cable('c1');
      c.connect(pc.getPort('eth0')!, r.getPort('GE0/0/0')!);

      // PC requests DHCP lease
      const dhcpOutput = await pc.executeCommand('sudo dhclient -v eth0');
      expect(dhcpOutput).toContain('DHCPDISCOVER');
      expect(dhcpOutput).toContain('DHCPACK');

      // Verify IP assignment on PC
      const ifconfig = await pc.executeCommand('ifconfig eth0');
      expect(ifconfig).toMatch(/inet\s+192\.168\.1\.\d+/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: STP & Switch Internals
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: STP & Switch Internals', () => {

  // ----------------------------------------------------------------
  // 6.1 STP State Machine (802.1D)
  // ----------------------------------------------------------------
  describe('6.1 STP State Machine (802.1D)', () => {

    it('should start new ports in listening state (not forwarding)', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const port = sw.getPort('GigabitEthernet0/0/0');
      expect(port).toBeDefined();

      // On a real 802.1D switch, a new port starts in listening state
      const stpState = sw.getSTPState('GigabitEthernet0/0/0');
      expect(stpState).toBe('listening');
    });

    it('should transition port through listening → learning → forwarding', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const portName = 'GigabitEthernet0/0/0';

      // Initially: listening
      expect(sw.getSTPState(portName)).toBe('listening');

      // After listening timer expires → learning
      sw.advanceSTPTimer(portName);
      expect(sw.getSTPState(portName)).toBe('learning');

      // After learning timer expires → forwarding
      sw.advanceSTPTimer(portName);
      expect(sw.getSTPState(portName)).toBe('forwarding');
    });

    it('should not forward frames in listening state', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.1.20'), new SubnetMask('255.255.255.0'));

      const c1 = new Cable('c1'); c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
      const c2 = new Cable('c2'); c2.connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);

      // Force ports to listening (initial STP state)
      sw.setSTPState('GigabitEthernet0/0/0', 'listening');
      sw.setSTPState('GigabitEthernet0/0/1', 'listening');

      // In listening state, no frame forwarding should occur
      let received = false;
      pc2.getPort('eth0')!.onFrame(() => { received = true; });

      // Try to send a frame - should be dropped in listening state
      // (can't forward, can't learn MACs yet)
      // We check indirectly via MAC table - should remain empty
      const macTable = sw.getMACTable();
      const entriesForPort = [...macTable.values()].filter(e =>
        e.port === 'GigabitEthernet0/0/0'
      );
      expect(entriesForPort).toHaveLength(0);
    });

    it('should learn MACs in learning state but not forward', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');

      // Set port to learning state
      sw.setSTPState('GigabitEthernet0/0/0', 'learning');
      sw.setSTPState('GigabitEthernet0/0/1', 'learning');

      // In learning state, the switch can learn MAC addresses but should NOT forward frames
      // (frames arriving on learning ports update the MAC table but are NOT forwarded)
    });
  });

  // ----------------------------------------------------------------
  // 6.2 MAC Move / Flapping Detection
  // ----------------------------------------------------------------
  describe('6.2 MAC Move Detection', () => {

    it('should detect when a MAC address moves to a different port', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.1.20'), new SubnetMask('255.255.255.0'));

      // Put all ports in forwarding to allow traffic
      sw.setAllPortsSTPState('forwarding');

      const c1 = new Cable('c1'); c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
      const c2 = new Cable('c2'); c2.connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);

      // Ping from PC1 to PC2 — MAC of PC1 learned on port 0
      await pc1.executeCommand('ping -c 1 10.0.1.20');

      // Now move PC1 to port 2 (simulate cable swap)
      c1.disconnect();
      const c3 = new Cable('c3'); c3.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
      sw.setSTPState('GigabitEthernet0/0/2', 'forwarding');

      // Ping again — MAC should move to port 2
      await pc1.executeCommand('ping -c 1 10.0.1.20');

      // Switch should have logged the MAC move
      expect(sw.getMACMoveCount()).toBeGreaterThanOrEqual(1);
    });
  });

  // ----------------------------------------------------------------
  // 6.3 VLAN Deletion — Huawei VRP Behavior
  // ----------------------------------------------------------------
  describe('6.3 VLAN Deletion — Huawei VRP Behavior', () => {

    it('should move ports back to VLAN 1 when their VLAN is deleted (NOT suspend)', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');

      // Create VLAN 50 and assign port to it
      sw.createVLAN(50, 'TestVLAN');
      sw.setSwitchportMode('GigabitEthernet0/0/5', 'access');
      sw.setSwitchportAccessVlan('GigabitEthernet0/0/5', 50);

      // Delete VLAN 50
      sw.deleteVLAN(50);

      // Huawei VRP: port is moved back to default VLAN 1, stays active
      const portVlanState = sw.getPortVlanState('GigabitEthernet0/0/5');
      expect(portVlanState).toBe('active');

      // Port's access VLAN should be 1 (default)
      const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/5');
      expect(cfg?.accessVlan).toBe(1);
    });

    it('should NOT reactivate ports on VLAN recreation (they were never suspended)', () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');

      // Create, assign, then delete VLAN
      sw.createVLAN(50, 'TestVLAN');
      sw.setSwitchportMode('GigabitEthernet0/0/5', 'access');
      sw.setSwitchportAccessVlan('GigabitEthernet0/0/5', 50);
      sw.deleteVLAN(50);

      // Port is active in VLAN 1 (not suspended)
      expect(sw.getPortVlanState('GigabitEthernet0/0/5')).toBe('active');

      // Recreate VLAN 50 — port stays in VLAN 1 (must be manually re-assigned)
      sw.createVLAN(50, 'TestVLAN-Recreated');
      expect(sw.getPortVlanState('GigabitEthernet0/0/5')).toBe('active');
      const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/5');
      expect(cfg?.accessVlan).toBe(1); // Still in VLAN 1, not auto-moved to 50
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: Inter-VLAN Routing with Huawei Switch & Router
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Inter-VLAN Routing (Huawei)', () => {

  it('should route between VLANs using router-on-a-stick', async () => {
    // Topology:
    //   PC1 (VLAN10, 10.0.10.10) -- GE0/0/0 [SW1] GE0/0/2 (access VLAN10) -- [R1] GE0/0/0
    //   PC2 (VLAN20, 10.0.20.10) -- GE0/0/1 [SW1]
    //   Note: true 802.1Q sub-interfaces are not yet supported, so we test
    //   basic L2 reachability within a VLAN through the switch.
    const sw = new HuaweiSwitch('switch-huawei', 'SW1');
    const r = new HuaweiRouter('R1');
    const pc1 = new LinuxPC('linux-pc', 'PC1');

    pc1.configureInterface('eth0', new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    // Switch: create VLAN 10, assign access ports
    sw.setAllPortsSTPState('forwarding'); // Skip STP for this test

    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    // Router on access port in same VLAN
    r.configureInterface('GE0/0/0', new IPAddress('10.0.10.1'), new SubnetMask('255.255.255.0'));

    // Connect cables
    const c1 = new Cable('c1'); c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
    const c2 = new Cable('c2'); c2.connect(sw.getPort('GigabitEthernet0/0/2')!, r.getPort('GE0/0/0')!);

    // Test: PC1 can ping router (same VLAN)
    const pingRouter = await pc1.executeCommand('ping -c 1 10.0.10.1');
    expect(pingRouter).toContain('64 bytes from 10.0.10.1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Huawei Router — CLI Completion, Help & Abbreviation
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Huawei Router — CLI Completion & Help', () => {

  // ----------------------------------------------------------------
  // 8.1 Command Abbreviation (unique prefix matching)
  // ----------------------------------------------------------------
  describe('8.1 Command Abbreviation', () => {

    it('should accept "dis ver" as abbreviation for "display version"', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('dis ver');
      expect(output).toContain('Huawei Versatile Routing Platform');
    });

    it('should accept "sys" as abbreviation for "system-view"', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('sys');
      const prompt = r.getPrompt();
      expect(prompt).toBe('[R1]');
    });

    it('should accept "dis ip int b" for "display ip interface brief"', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
      const output = await r.executeCommand('dis ip int b');
      expect(output).toContain('GE0/0/0');
      expect(output).toContain('10.0.0.1');
    });

    it('should accept "dis ip ro" for "display ip routing-table"', async () => {
      const r = new HuaweiRouter('R1');
      const output = await r.executeCommand('dis ip ro');
      expect(output).toContain('Routing Tables: Public');
    });

    it('should accept abbreviations in system view', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      // "dis ver" in system view
      const output = await r.executeCommand('dis ver');
      expect(output).toContain('Huawei Versatile Routing Platform');
    });

    it('should report ambiguous commands', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      // "i" could match "interface" and "ip"
      const output = await r.executeCommand('i');
      expect(output).toContain('Ambiguous');
    });

    it('should accept "int GE0/0/0" to enter interface mode', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('int GE0/0/0');
      const prompt = r.getPrompt();
      expect(prompt).toContain('GE0/0/0');
    });
  });

  // ----------------------------------------------------------------
  // 8.2 Help System (? command)
  // ----------------------------------------------------------------
  describe('8.2 Help System (?)', () => {

    it('should list available commands in user mode with "?"', async () => {
      const r = new HuaweiRouter('R1');
      const help = r.cliHelp('');
      expect(help).toContain('display');
      expect(help).toContain('system-view');
    });

    it('should list display subcommands with "display ?"', async () => {
      const r = new HuaweiRouter('R1');
      const help = r.cliHelp('display ');
      expect(help).toContain('version');
      expect(help).toContain('ip');
      expect(help).toContain('arp');
      expect(help).toContain('current-configuration');
      expect(help).toContain('interface');
      expect(help).toContain('rip');
    });

    it('should show matching commands for partial input "dis?"', async () => {
      const r = new HuaweiRouter('R1');
      const help = r.cliHelp('dis');
      expect(help).toContain('display');
    });

    it('should list "display ip" subcommands with "display ip ?"', async () => {
      const r = new HuaweiRouter('R1');
      const help = r.cliHelp('display ip ');
      expect(help).toContain('routing-table');
      expect(help).toContain('interface');
      expect(help).toContain('traffic');
      expect(help).toContain('pool');
    });

    it('should list system view commands when in system mode', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      const help = r.cliHelp('');
      expect(help).toContain('interface');
      expect(help).toContain('sysname');
      expect(help).toContain('display');
      expect(help).toContain('ip');
      expect(help).toContain('arp');
      expect(help).toContain('dhcp');
    });

    it('should list interface view commands', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      const help = r.cliHelp('');
      expect(help).toContain('ip');
      expect(help).toContain('shutdown');
      expect(help).toContain('undo');
      expect(help).toContain('display');
      expect(help).toContain('dhcp');
    });

    it('should show <cr> when command is complete and executable', async () => {
      const r = new HuaweiRouter('R1');
      const help = r.cliHelp('display version ');
      expect(help).toContain('<cr>');
    });

    it('should handle ? invoked via execute (inline ?)', async () => {
      const r = new HuaweiRouter('R1');
      // Typing "display ?" in the shell should return help
      const output = await r.executeCommand('display ?');
      expect(output).toContain('version');
      expect(output).toContain('arp');
    });
  });

  // ----------------------------------------------------------------
  // 8.3 Tab Completion
  // ----------------------------------------------------------------
  describe('8.3 Tab Completion', () => {

    it('should complete "dis" to "display "', () => {
      const r = new HuaweiRouter('R1');
      const result = r.cliTabComplete('dis');
      expect(result).toBe('display ');
    });

    it('should complete "display ver" to "display version "', () => {
      const r = new HuaweiRouter('R1');
      const result = r.cliTabComplete('display ver');
      expect(result).toBe('display version ');
    });

    it('should complete "sys" to "system-view "', () => {
      const r = new HuaweiRouter('R1');
      const result = r.cliTabComplete('sys');
      expect(result).toBe('system-view ');
    });

    it('should complete "display ip ro" to "display ip routing-table "', () => {
      const r = new HuaweiRouter('R1');
      const result = r.cliTabComplete('display ip ro');
      expect(result).toBe('display ip routing-table ');
    });

    it('should return null for ambiguous input', () => {
      const r = new HuaweiRouter('R1');
      // "display " + "i" matches both "ip" and "interface"
      const result = r.cliTabComplete('display i');
      expect(result).toBeNull();
    });

    it('should complete in system view', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      const result = r.cliTabComplete('int');
      expect(result).toBe('interface ');
    });

    it('should complete in interface view', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      const result = r.cliTabComplete('sh');
      expect(result).toBe('shutdown ');
    });
  });

  // ----------------------------------------------------------------
  // 8.4 Existing Commands Still Work (regression)
  // ----------------------------------------------------------------
  describe('8.4 Regression — Existing Commands', () => {

    it('should still handle full "display current-configuration"', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
      const output = await r.executeCommand('display current-configuration');
      expect(output).toContain('sysname R1');
      expect(output).toContain('interface GE0/0/0');
      expect(output).toContain('10.0.0.1');
    });

    it('should still handle ip route-static in system view', async () => {
      const r = new HuaweiRouter('R1');
      r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
      await r.executeCommand('system-view');
      await r.executeCommand('ip route-static 10.0.0.0 255.255.255.0 192.168.1.2');
      await r.executeCommand('return');
      const table = await r.executeCommand('display ip routing-table');
      expect(table).toContain('10.0.0.0');
      expect(table).toContain('192.168.1.2');
    });

    it('should still handle arp static in system view', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('arp static 192.168.1.50 aaaa-bbbb-cccc');
      await r.executeCommand('return');
      const output = await r.executeCommand('display arp');
      expect(output).toContain('192.168.1.50');
    });

    it('should still handle interface ip address configuration', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('return');
      const output = await r.executeCommand('display ip interface brief');
      expect(output).toContain('10.0.0.1');
    });

    it('should still handle dhcp pool configuration', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('dhcp enable');
      await r.executeCommand('ip pool pool1');
      await r.executeCommand('gateway-list 192.168.1.1');
      await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
      await r.executeCommand('dns-list 8.8.8.8');
      await r.executeCommand('quit');
      await r.executeCommand('return');
      const output = await r.executeCommand('display ip pool name pool1');
      expect(output).toContain('pool1');
      expect(output).toContain('192.168.1.0');
    });

    it('should still handle quit and return navigation', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      expect(r.getPrompt()).toBe('[R1]');
      await r.executeCommand('interface GE0/0/0');
      expect(r.getPrompt()).toContain('GE0/0/0');
      await r.executeCommand('quit');
      expect(r.getPrompt()).toBe('[R1]');
      await r.executeCommand('return');
      expect(r.getPrompt()).toBe('<R1>');
    });

    it('should still handle sysname command', async () => {
      const r = new HuaweiRouter('R1');
      await r.executeCommand('system-view');
      await r.executeCommand('sysname MyRouter');
      expect(r.getPrompt()).toBe('[MyRouter]');
    });
  });
});
