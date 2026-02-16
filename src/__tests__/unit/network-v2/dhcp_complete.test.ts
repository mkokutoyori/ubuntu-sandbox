/**
 * TDD Tests for DHCP Protocol (DET-L3-004)
 * 
 * Group 1: Unit Tests — DHCP Client/Server States
 * Group 2: Functional Tests — DORA Process & Lease Management
 * Group 3: CLI Tests — Configuration & Monitoring Commands
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  resetCounters,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Router } from '@/network/devices/Router';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Unit Tests — DHCP Client/Server States
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: DHCP Client/Server Unit Tests', () => {

  // U-DHCP-01: Client Initialization in INIT State
  describe('U-DHCP-01: DHCP Client INIT State', () => {
    it('should start in INIT state and send DHCPDISCOVER', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // When: Configure interface for DHCP
      const output = await pc.executeCommand('sudo dhclient -v eth0');
      
      // Then: Should start DHCP process
      expect(output).toContain('DHCPDISCOVER on eth0');
      expect(output).toContain('INIT state');
      
      // Verify internal state
      const dhcpState = pc.getDHCPState('eth0');
      expect(dhcpState.state).toBe('INIT');
      expect(dhcpState.xid).toBeDefined(); // Transaction ID should be set
    });

    it('Windows DHCP client should broadcast DHCPDiscover', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      
      const output = await pc.executeCommand('ipconfig /release');
      expect(output).toContain('successfully released');
      
      const output2 = await pc.executeCommand('ipconfig /renew');
      expect(output2).toContain('DHCP Discover');
      expect(output2).toContain('Broadcast');
    });
  });

  // U-DHCP-02: Server Configuration Validation
  describe('U-DHCP-02: DHCP Server Configuration', () => {
    it('should configure DHCP pool on Cisco router', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
      
      // Configure DHCP server
      const config = [
        'enable',
        'configure terminal',
        'service dhcp',
        'ip dhcp pool LAN-POOL',
        'network 192.168.1.0 255.255.255.0',
        'default-router 192.168.1.1',
        'dns-server 8.8.8.8',
        'domain-name example.com',
        'lease 2',
        'exit',
        'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
        'end'
      ];
      
      for (const cmd of config) {
        await router.executeCommand(cmd);
      }
      
      // Verify configuration
      const showPool = await router.executeCommand('show ip dhcp pool');
      expect(showPool).toContain('LAN-POOL');
      expect(showPool).toContain('192.168.1.0/24');
      expect(showPool).toContain('2 days');
      
      const showExcluded = await router.executeCommand('show ip dhcp excluded-address');
      expect(showExcluded).toContain('192.168.1.1');
      expect(showExcluded).toContain('192.168.1.10');
    });

    it('should validate pool configuration errors', async () => {
      const router = new Router('router-cisco', 'R1');

      // Try to configure pool without network statement
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool TEST');
      await router.executeCommand('default-router 192.168.1.1');
      await router.executeCommand('exit');
      await router.executeCommand('end');

      // Should show error when trying to use pool
      const showError = await router.executeCommand('show ip dhcp pool TEST');
      expect(showError).toContain('Incomplete configuration');
    });
  });

  // U-DHCP-03: Lease Database Management
  describe('U-DHCP-03: DHCP Lease Database', () => {
    it('should maintain bindings and show active leases', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      // ... configure DHCP pool as above ...
      
      // Check bindings (initially empty)
      const bindings = await router.executeCommand('show ip dhcp binding');
      expect(bindings).toContain('IP address');
      expect(bindings).toContain('Client-id');
      expect(bindings).toContain('Lease expiration');
      
      // Simulate a lease
      await router.executeCommand('enable');
      await router.executeCommand('debug ip dhcp server events');
      const debug = await router.executeCommand('show debug');
      expect(debug).toContain('DHCP server debugging is on');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Functional Tests — DORA Process & Lease Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Functional — DORA Process', () => {

  // F-DHCP-01: Complete DORA Process
  describe('F-DHCP-01: Complete DORA Sequence', () => {
    it('should complete DORA process and obtain IP address', async () => {
      // Setup: Router as DHCP Server, Switch, Client
      const router = new Router('router-cisco', 'DHCP-Server');
      const switch1 = new CiscoSwitch('switch-cisco', 'SW1');
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Configure router interface and DHCP
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/0');
      await router.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await router.executeCommand('no shutdown');
      await router.executeCommand('exit');

      // Configure DHCP pool
      await router.executeCommand('ip dhcp pool LAN');
      await router.executeCommand('network 192.168.1.0 255.255.255.0');
      await router.executeCommand('default-router 192.168.1.1');
      await router.executeCommand('dns-server 8.8.8.8 8.8.4.4');
      await router.executeCommand('lease 1');
      await router.executeCommand('exit');
      await router.executeCommand('ip dhcp excluded-address 192.168.1.1');
      await router.executeCommand('end');

      // Connect devices
      const cable1 = new Cable('c1');
      cable1.connect(router.getPort('GigabitEthernet0/0')!, switch1.getPort('GigabitEthernet0/1')!);
      const cable2 = new Cable('c2');
      cable2.connect(switch1.getPort('GigabitEthernet0/2')!, pc.getPort('eth0')!);

      // Configure switch ports
      await switch1.executeCommand('enable');
      await switch1.executeCommand('configure terminal');
      await switch1.executeCommand('interface range GigabitEthernet0/1-2');
      await switch1.executeCommand('switchport mode access');
      await switch1.executeCommand('switchport access vlan 1');
      await switch1.executeCommand('no shutdown');
      await switch1.executeCommand('end');
      
      // Start DHCP client with verbose output
      const dhcpOutput = await pc.executeCommand('sudo dhclient -v -d eth0');
      
      // Verify DORA process in output
      expect(dhcpOutput).toContain('DHCPDISCOVER');
      expect(dhcpOutput).toContain('DHCPOFFER');
      expect(dhcpOutput).toContain('DHCPREQUEST');
      expect(dhcpOutput).toContain('DHCPACK');
      
      // Verify client got IP
      const ipOutput = await pc.executeCommand('ip addr show eth0');
      expect(ipOutput).toContain('192.168.1.');
      expect(ipOutput).toContain('dynamic');
      
      // Verify lease file
      const leaseOutput = await pc.executeCommand('cat /var/lib/dhcp/dhclient.eth0.leases');
      expect(leaseOutput).toContain('lease {');
      expect(leaseOutput).toContain('option subnet-mask');
      
      // Verify router shows binding
      const binding = await router.executeCommand('show ip dhcp binding');
      const clientMac = pc.getMACAddress('eth0');
      expect(binding).toContain(clientMac.toString());
    });

    it('should handle multiple clients simultaneously', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      const switch1 = new CiscoSwitch('switch-cisco', 'SW1');
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new WindowsPC('windows-pc', 'PC2');
      const pc3 = new LinuxPC('linux-pc', 'PC3');
      
      // Configure router and DHCP pool with enough addresses
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool LAN');
      await router.executeCommand('network 192.168.10.0 255.255.255.0');
      await router.executeCommand('default-router 192.168.10.1');
      await router.executeCommand('lease 0 2 0'); // 2 hours
      await router.executeCommand('exit');
      await router.executeCommand('ip dhcp excluded-address 192.168.10.1 192.168.10.10');
      await router.executeCommand('end');
      
      // Connect all devices
      // ... connection code ...
      
      // Request IPs simultaneously
      const promises = [
        pc1.executeCommand('sudo dhclient eth0'),
        pc2.executeCommand('ipconfig /renew'),
        pc3.executeCommand('sudo dhclient eth0')
      ];
      
      await Promise.all(promises);
      
      // Verify all got different IPs
      const ip1 = await pc1.executeCommand('ip addr show eth0 | grep "inet "');
      const ip2 = await pc2.executeCommand('ipconfig | findstr "IPv4 Address"');
      const ip3 = await pc3.executeCommand('ip addr show eth0 | grep "inet "');
      
      const ips = [ip1, ip2, ip3].map(output => {
        const match = output.match(/\d+\.\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      }).filter(ip => ip !== null);
      
      // All should have unique IPs
      const uniqueIPs = new Set(ips);
      expect(uniqueIPs.size).toBe(3);
      
      // Verify bindings on router
      const binding = await router.executeCommand('show ip dhcp binding');
      expect(binding.split('\n').filter(line => line.includes('192.168.10.')).length).toBe(3);
    });
  });

  // F-DHCP-02: Lease Renewal & Rebinding
  describe('F-DHCP-02: Lease Renewal Process', () => {
    it('should renew lease at T1 (50% of lease time)', async () => {
      vi.useFakeTimers();
      
      const router = new Router('router-cisco', 'DHCP-Server');
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Configure DHCP with short lease for testing
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool TEST');
      await router.executeCommand('network 10.0.0.0 255.255.255.0');
      await router.executeCommand('lease 0 0 30'); // 30 seconds lease
      await router.executeCommand('end');
      
      // Get initial lease
      await pc.executeCommand('sudo dhclient -v eth0');
      const initialIP = await pc.executeCommand('ip addr show eth0 | grep "inet "');
      
      // Fast-forward to T1 (15 seconds)
      vi.advanceTimersByTime(15000);
      
      // Should see DHCPREQUEST for renewal
      const logs = pc.getDHCPLogs('eth0');
      expect(logs).toContain('RENEWING');
      expect(logs).toContain('DHCPREQUEST');
      
      // Fast-forward to T2 (87.5% of lease)
      vi.advanceTimersByTime(11250); // 26.25 total seconds
      
      // Should enter REBINDING state
      const logs2 = pc.getDHCPLogs('eth0');
      expect(logs2).toContain('REBINDING');
      expect(logs2).toContain('broadcast');
      
      vi.useRealTimers();
    });

    it('should release IP and go back to INIT state', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Get DHCP lease first
      await pc.executeCommand('sudo dhclient eth0');
      const beforeRelease = await pc.executeCommand('ip addr show eth0 | grep "inet "');
      expect(beforeRelease).toContain('192.168.');
      
      // Release the lease
      const releaseOutput = await pc.executeCommand('sudo dhclient -r eth0');
      expect(releaseOutput).toContain('released');
      
      // Verify no IP
      const afterRelease = await pc.executeCommand('ip addr show eth0 | grep "inet "');
      expect(afterRelease).not.toContain('192.168.');
      
      // State should be INIT
      const state = pc.getDHCPState('eth0');
      expect(state.state).toBe('INIT');
    });
  });

  // F-DHCP-03: Error Conditions
  describe('F-DHCP-03: DHCP Error Conditions', () => {
    it('should timeout when no DHCP server responds', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Set timeout to 10 seconds for test
      const output = await pc.executeCommand('sudo dhclient -v -t 5 eth0');
      
      expect(output).toContain('No DHCPOFFERS received');
      expect(output).toContain('expired');
      
      // Should have no IP configured
      const ipOutput = await pc.executeCommand('ip addr show eth0');
      expect(ipOutput).not.toContain('dynamic');
    });

    it('should handle DHCPNAK (server denies request)', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Configure server to NAK certain requests
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool TEST');
      await router.executeCommand('network 192.168.2.0 255.255.255.0');
      await router.executeCommand('client-identifier deny 0100.*'); // Deny MACs starting with 0100
      await router.executeCommand('end');
      
      // Configure client with matching MAC pattern
      pc.setMACAddress('eth0', new MACAddress('01:00:5E:00:00:01'));
      
      const output = await pc.executeCommand('sudo dhclient -v eth0');
      expect(output).toContain('DHCPNAK');
      expect(output).toContain('restarting');
    });

    it('should handle exhausted address pool', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      
      // Configure tiny pool
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool TINY');
      await router.executeCommand('network 192.168.3.0 255.255.255.252'); // Only 2 usable addresses
      await router.executeCommand('exit');
      await router.executeCommand('ip dhcp excluded-address 192.168.3.1');
      await router.executeCommand('end');
      // Pool now has only 192.168.3.2 and 192.168.3.3

      // Simulate 3 clients
      // ... connection and request code ...

      // Third client should fail
      const output = await router.executeCommand('debug ip dhcp server packet');
      // Check logs for pool exhausted message
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: CLI Tests — Configuration & Monitoring Commands
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: CLI — DHCP Configuration & Monitoring', () => {

  // Linux DHCP Client Commands
  describe('Linux: DHCP Client Commands', () => {
    it('should configure interface for DHCP via ifconfig', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Release any existing lease
      await pc.executeCommand('sudo dhclient -r eth0');
      
      // Set interface to use DHCP
      const output = await pc.executeCommand('sudo dhclient eth0');
      expect(output).toBe(''); // Successful execution returns empty
      
      // Verify interface got IP
      const ipOutput = await pc.executeCommand('ip addr show eth0');
      expect(ipOutput).toContain('dynamic');
      expect(ipOutput).toContain('inet ');
    });

    it('should show DHCP lease information', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Get lease
      await pc.executeCommand('sudo dhclient eth0');
      
      // Show lease info
      const leaseInfo = await pc.executeCommand('cat /var/lib/dhcp/dhclient.eth0.leases | tail -50');
      expect(leaseInfo).toContain('lease');
      expect(leaseInfo).toContain('renew');
      expect(leaseInfo).toContain('rebind');
      expect(leaseInfo).toContain('expire');
      
      // Alternative: dhclient status
      const status = await pc.executeCommand('ps aux | grep dhclient');
      expect(status).toContain('dhclient');
    });

    it('should flush all DHCP leases', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      const output = await pc.executeCommand('sudo dhclient -r; sudo rm -f /var/lib/dhcp/dhclient.leases');
      expect(output).toBe('');
      
      // Verify no dhclient running
      const psOutput = await pc.executeCommand('ps aux | grep dhclient | grep -v grep');
      expect(psOutput).toBe('');
    });
  });

  // Windows DHCP Client Commands
  describe('Windows: DHCP Client Commands', () => {
    it('should release and renew DHCP lease', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      
      // Release current IP
      const releaseOutput = await pc.executeCommand('ipconfig /release');
      expect(releaseOutput).toContain('successfully released');
      
      // Renew IP
      const renewOutput = await pc.executeCommand('ipconfig /renew');
      expect(renewOutput).toContain('DHCP');
      expect(renewOutput).toContain('IPv4 Address');
      
      // Show all info
      const allOutput = await pc.executeCommand('ipconfig /all');
      expect(allOutput).toContain('DHCP Enabled');
      expect(allOutput).toContain('Lease Obtained');
      expect(allOutput).toContain('Lease Expires');
    });

    it('should show DHCP client events in Event Log', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      
      // Check DHCP events
      const events = await pc.executeCommand('wevtutil qe System /q:"*[System[Provider[@Name=\"Dhcp-Client\"]]]" /c:5 /rd:true /f:text');
      expect(events).toContain('Dhcp-Client');
    });

    it('should reset TCP/IP stack and DHCP configuration', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      
      // Netsh commands to reset DHCP
      const output = await pc.executeCommand('netsh int ip reset dhcp.txt');
      expect(output).toContain('Resetting');
      
      const output2 = await pc.executeCommand('netsh winsock reset');
      expect(output2).toContain('successfully reset');
    });
  });

  // Router DHCP Server Commands
  describe('Router: DHCP Server Monitoring', () => {
    it('should show detailed DHCP server statistics', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');
      
      // Configure DHCP first
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('ip dhcp pool TEST');
      await router.executeCommand('network 172.16.0.0 255.255.255.0');
      await router.executeCommand('exit');
      await router.executeCommand('end');

      // Show statistics
      const stats = await router.executeCommand('show ip dhcp server statistics');
      expect(stats).toContain('Memory usage');
      expect(stats).toContain('DHCPDISCOVER');
      expect(stats).toContain('DHCPOFFER');
      expect(stats).toContain('DHCPREQUEST');
      expect(stats).toContain('DHCPACK');
      expect(stats).toContain('DHCPNAK');
      
      // Show conflict logging
      const conflict = await router.executeCommand('show ip dhcp conflict');
      expect(conflict).toContain('IP address');
    });

    it('should clear DHCP bindings and statistics', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');

      // Enter privileged mode for clear/show commands
      await router.executeCommand('enable');

      // Clear bindings
      const clearOutput = await router.executeCommand('clear ip dhcp binding *');
      expect(clearOutput).toBe('');

      // Clear statistics
      const clearStats = await router.executeCommand('clear ip dhcp server statistics');
      expect(clearStats).toBe('');

      // Verify statistics reset
      const stats = await router.executeCommand('show ip dhcp server statistics');
      expect(stats).toContain('0');
    });

    it('should debug DHCP packets in real-time', async () => {
      const router = new Router('router-cisco', 'DHCP-Server');

      // Enter privileged mode first (debug commands require it)
      await router.executeCommand('enable');

      // Enable debugging
      await router.executeCommand('debug ip dhcp server packet');
      await router.executeCommand('debug ip dhcp server events');

      // Check debug status
      const debugStatus = await router.executeCommand('show debug');
      expect(debugStatus).toContain('DHCP server packet debugging is on');
      expect(debugStatus).toContain('DHCP server event debugging is on');

      // Disable debugging
      await router.executeCommand('no debug ip dhcp server packet');
      await router.executeCommand('no debug ip dhcp server events');
    });

    it('should configure DHCP relay agent', async () => {
      const router = new Router('router-cisco', 'Relay-Agent');
      
      // Configure interface to relay DHCP requests
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('ip helper-address 10.1.1.100'); // DHCP server IP
      await router.executeCommand('ip forward-protocol udp bootps'); // UDP 67
      await router.executeCommand('exit');
      await router.executeCommand('end');
      
      // Verify configuration
      const intConfig = await router.executeCommand('show running-config interface GigabitEthernet0/1');
      expect(intConfig).toContain('ip helper-address 10.1.1.100');
    });
  });

  // Switch DHCP Snooping Commands
  describe('Switch: DHCP Snooping & Security', () => {
    it('should configure DHCP snooping to prevent rogue DHCP servers', async () => {
      const switch1 = new CiscoSwitch('switch-cisco', 'SW1');

      // Enter privileged mode, then config mode
      await switch1.executeCommand('enable');
      await switch1.executeCommand('configure terminal');
      await switch1.executeCommand('ip dhcp snooping');
      await switch1.executeCommand('ip dhcp snooping vlan 1,10,20');
      
      // Configure trusted ports (connected to legitimate DHCP servers)
      await switch1.executeCommand('interface GigabitEthernet0/24');
      await switch1.executeCommand('ip dhcp snooping trust');
      await switch1.executeCommand('exit');
      
      // Configure untrusted ports with rate limiting
      await switch1.executeCommand('interface range GigabitEthernet0/1-23');
      await switch1.executeCommand('ip dhcp snooping limit rate 10');
      await switch1.executeCommand('exit');
      
      await switch1.executeCommand('end');
      
      // Verify configuration
      const snoopingStatus = await switch1.executeCommand('show ip dhcp snooping');
      expect(snoopingStatus).toContain('DHCP snooping is enabled');
      expect(snoopingStatus).toContain('Trusted ports: Gi0/24');
      
      const bindingTable = await switch1.executeCommand('show ip dhcp snooping binding');
      expect(bindingTable).toContain('MacAddress');
      expect(bindingTable).toContain('IP address');
      expect(bindingTable).toContain('Lease');
      expect(bindingTable).toContain('VLAN');
    });

    it('should detect and log DHCP spoofing attacks', async () => {
      const switch1 = new CiscoSwitch('switch-cisco', 'SW1');

      // Enter privileged mode, then config mode
      await switch1.executeCommand('enable');
      await switch1.executeCommand('configure terminal');
      await switch1.executeCommand('ip dhcp snooping');
      await switch1.executeCommand('ip dhcp snooping verify mac-address');
      await switch1.executeCommand('logging 10.0.0.100'); // Syslog server
      await switch1.executeCommand('end');
      
      // Check logs for spoofing attempts
      const logs = await switch1.executeCommand('show logging | include DHCP');
      // Should show messages about untrusted DHCP packets
    });
  });
});