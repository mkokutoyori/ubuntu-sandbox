/**
 * Cisco Router Comprehensive Tests
 * Tests CLI commands, configuration modes, routing protocols, and features
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoDevice, createCiscoRouter } from '../devices/cisco/CiscoDevice';
import { executeCiscoCommand, parseCommand } from '../terminal/cisco/commands/index';
import { createDefaultRouterConfig, createDefaultTerminalState } from '../terminal/cisco/state';
import { CiscoConfig, CiscoTerminalState } from '../terminal/cisco/types';

describe('Cisco Router CLI', () => {
  let router: CiscoDevice;
  let config: CiscoConfig;
  let state: CiscoTerminalState;
  let bootTime: Date;

  beforeEach(() => {
    router = createCiscoRouter({
      id: 'test-router',
      name: 'TestRouter',
      x: 0,
      y: 0,
    });
    config = createDefaultRouterConfig('Router1');
    state = createDefaultTerminalState('Router1');
    bootTime = new Date();
  });

  // Helper function to execute command
  function exec(command: string): ReturnType<typeof executeCiscoCommand> {
    const result = executeCiscoCommand(command, state, config, bootTime);
    if (result.newMode) {
      state.mode = result.newMode;
    }
    if (result.newInterface) {
      state.currentInterface = result.newInterface;
    }
    if (result.newRouter) {
      state.currentRouter = result.newRouter;
    }
    if (result.newLine) {
      state.currentLine = result.newLine;
    }
    if (result.newDHCPPool) {
      state.currentDHCPPool = result.newDHCPPool;
    }
    return result;
  }

  describe('Command Parser', () => {
    it('parses simple command', () => {
      const result = parseCommand('show version');
      expect(result.command).toBe('show');
      expect(result.args).toEqual(['version']);
    });

    it('parses command with multiple arguments', () => {
      const result = parseCommand('ip address 192.168.1.1 255.255.255.0');
      expect(result.command).toBe('ip');
      expect(result.args).toEqual(['address', '192.168.1.1', '255.255.255.0']);
    });

    it('parses command with quoted strings', () => {
      const result = parseCommand('description "WAN Link to ISP"');
      expect(result.command).toBe('description');
      expect(result.args).toEqual(['WAN Link to ISP']);
    });

    it('handles empty input', () => {
      const result = parseCommand('');
      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });
  });

  describe('Mode Transitions', () => {
    it('starts in user mode', () => {
      expect(state.mode).toBe('user');
    });

    it('transitions from user to privileged mode with enable', () => {
      const result = exec('enable');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('privileged');
    });

    it('transitions from privileged to global config with configure terminal', () => {
      exec('enable');
      const result = exec('configure terminal');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Enter configuration commands');
      expect(state.mode).toBe('global-config');
    });

    it('transitions to interface config mode', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('transitions to line config mode', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('line console 0');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('line');
    });

    it('transitions to router config mode with router ospf', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('router ospf 1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('router');
    });

    it('transitions to router config mode with router eigrp', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('router eigrp 100');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('router');
    });

    it('transitions to router config mode with router rip', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('router rip');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('router');
    });

    it('returns to privileged mode with end', () => {
      exec('enable');
      exec('configure terminal');
      exec('interface GigabitEthernet0/0');
      const result = exec('end');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('privileged');
    });

    it('goes up one level with exit', () => {
      exec('enable');
      exec('configure terminal');
      exec('interface GigabitEthernet0/0');
      exec('exit');
      expect(state.mode).toBe('global-config');
      exec('exit');
      expect(state.mode).toBe('privileged');
    });

    it('returns to user mode with disable', () => {
      exec('enable');
      const result = exec('disable');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('user');
    });
  });

  describe('User Mode Commands', () => {
    it('shows help with ?', () => {
      const result = exec('?');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('enable');
      expect(result.output).toContain('ping');
      expect(result.output).toContain('show');
    });

    it('executes ping command', () => {
      const result = exec('ping 192.168.1.1');
      expect(result.exitCode).toBeDefined();
      expect(result.output).toContain('ICMP Echos');
      expect(result.output).toContain('Success rate');
    });

    it('requires target for ping', () => {
      const result = exec('ping');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Incomplete command');
    });

    it('executes traceroute command', () => {
      const result = exec('traceroute 10.0.0.1');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Tracing the route');
    });

    it('limits show commands in user mode', () => {
      const result = exec('show running-config');
      expect(result.exitCode).toBe(1);
    });

    it('allows show version in user mode', () => {
      const result = exec('show version');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Cisco');
    });

    it('allows show clock in user mode', () => {
      const result = exec('show clock');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('UTC');
    });

    it('rejects invalid commands', () => {
      const result = exec('invalidcommand');
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeDefined();
    });
  });

  describe('Privileged Mode Commands', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('shows help with ?', () => {
      const result = exec('?');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('configure');
      expect(result.output).toContain('show');
      expect(result.output).toContain('write');
    });

    it('executes show running-config', () => {
      const result = exec('show running-config');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Building configuration');
      expect(result.output).toContain('hostname');
    });

    it('executes show startup-config', () => {
      const result = exec('show startup-config');
      expect(result.exitCode).toBe(0);
    });

    it('executes show version', () => {
      const result = exec('show version');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Cisco');
      expect(result.output).toContain('IOS');
      expect(result.output).toContain('upance');
    });

    it('executes show interfaces', () => {
      const result = exec('show interfaces');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('line protocol');
    });

    it('executes show ip interface brief', () => {
      const result = exec('show ip interface brief');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Interface');
      expect(result.output).toContain('IP-Address');
      expect(result.output).toContain('Status');
    });

    it('executes show ip route', () => {
      const result = exec('show ip route');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Codes:');
      expect(result.output).toContain('Gateway of last resort');
    });

    it('executes show arp', () => {
      const result = exec('show arp');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Protocol');
      expect(result.output).toContain('Hardware Addr');
    });

    it('executes show history', () => {
      exec('show version');
      exec('show interfaces');
      const result = exec('show history');
      expect(result.exitCode).toBe(0);
    });

    it('executes show clock', () => {
      const result = exec('show clock');
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('executes show users', () => {
      const result = exec('show users');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Line');
    });

    it('executes show privilege', () => {
      const result = exec('show privilege');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('privilege level is 15');
    });

    it('executes show protocols', () => {
      const result = exec('show protocols');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Internet Protocol routing');
    });

    it('executes show ip protocols', () => {
      const result = exec('show ip protocols');
      expect(result.exitCode).toBe(0);
    });

    it('executes show flash', () => {
      const result = exec('show flash:');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('bytes');
    });

    it('executes show logging', () => {
      const result = exec('show logging');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('logging');
    });

    it('executes show cdp', () => {
      const result = exec('show cdp');
      expect(result.exitCode).toBe(0);
    });

    it('executes show cdp neighbors', () => {
      const result = exec('show cdp neighbors');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Device ID');
    });

    it('executes show hosts', () => {
      const result = exec('show hosts');
      expect(result.exitCode).toBe(0);
    });

    it('executes show inventory', () => {
      const result = exec('show inventory');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Chassis');
    });

    it('executes write memory', () => {
      const result = exec('write memory');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Building configuration');
      expect(result.output).toContain('[OK]');
    });

    it('executes write terminal', () => {
      const result = exec('write terminal');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Building configuration');
    });

    it('executes copy running-config startup-config', () => {
      const result = exec('copy running-config startup-config');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('[OK]');
    });

    it('executes reload', () => {
      const result = exec('reload');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Proceed with reload');
    });

    it('executes clear arp-cache', () => {
      const result = exec('clear arp-cache');
      expect(result.exitCode).toBe(0);
    });

    it('executes clear counters', () => {
      const result = exec('clear counters');
      expect(result.exitCode).toBe(0);
    });

    it('executes debug all', () => {
      const result = exec('debug all');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('debugging has been turned on');
    });

    it('executes undebug all', () => {
      const result = exec('undebug all');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('debugging has been turned off');
    });

    it('executes terminal length', () => {
      const result = exec('terminal length 50');
      expect(result.exitCode).toBe(0);
      expect(state.terminalLength).toBe(50);
    });

    it('executes terminal width', () => {
      const result = exec('terminal width 132');
      expect(result.exitCode).toBe(0);
      expect(state.terminalWidth).toBe(132);
    });

    it('executes dir command', () => {
      const result = exec('dir');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('flash');
    });

    it('executes verify command', () => {
      const result = exec('verify flash:image.bin');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Signature Verified');
    });

    it('executes erase startup-config', () => {
      const result = exec('erase startup-config');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Erase of nvram');
    });

    it('executes telnet command', () => {
      const result = exec('telnet 192.168.1.1');
      expect(result.output).toContain('Trying');
    });

    it('executes ssh command', () => {
      const result = exec('ssh -l admin 192.168.1.1');
      expect(result.output).toContain('Trying');
    });
  });

  describe('Global Configuration Commands', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('shows help with ?', () => {
      const result = exec('?');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('hostname');
      expect(result.output).toContain('interface');
    });

    it('sets hostname', () => {
      const result = exec('hostname NewRouter');
      expect(result.exitCode).toBe(0);
      expect(config.hostname).toBe('NewRouter');
    });

    it('sets enable secret', () => {
      const result = exec('enable secret cisco123');
      expect(result.exitCode).toBe(0);
      expect(config.enableSecret).toBeDefined();
    });

    it('sets enable password', () => {
      const result = exec('enable password cisco');
      expect(result.exitCode).toBe(0);
      expect(config.enablePassword).toBe('cisco');
    });

    it('creates username', () => {
      const result = exec('username admin privilege 15 secret cisco123');
      expect(result.exitCode).toBe(0);
    });

    it('enables service password-encryption', () => {
      const result = exec('service password-encryption');
      expect(result.exitCode).toBe(0);
      expect(config.servicePasswordEncryption).toBe(true);
    });

    it('sets ip domain-name', () => {
      const result = exec('ip domain-name example.com');
      expect(result.exitCode).toBe(0);
      expect(config.domainName).toBe('example.com');
    });

    it('sets ip name-server', () => {
      const result = exec('ip name-server 8.8.8.8');
      expect(result.exitCode).toBe(0);
      expect(config.nameServers).toContain('8.8.8.8');
    });

    it('enables ip routing', () => {
      const result = exec('ip routing');
      expect(result.exitCode).toBe(0);
      expect(config.ipRouting).toBe(true);
    });

    it('adds static route', () => {
      const result = exec('ip route 10.0.0.0 255.0.0.0 192.168.1.1');
      expect(result.exitCode).toBe(0);
      expect(config.staticRoutes.length).toBeGreaterThan(0);
    });

    it('adds default route', () => {
      const result = exec('ip route 0.0.0.0 0.0.0.0 192.168.1.254');
      expect(result.exitCode).toBe(0);
    });

    it('sets banner motd', () => {
      const result = exec('banner motd #Authorized access only#');
      expect(result.exitCode).toBe(0);
    });

    it('enables logging console', () => {
      const result = exec('logging console');
      expect(result.exitCode).toBe(0);
      expect(config.loggingConsole).toBe(true);
    });

    it('enables logging buffered', () => {
      const result = exec('logging buffered 16384');
      expect(result.exitCode).toBe(0);
      expect(config.loggingBuffered).toBe(true);
    });

    it('enables cdp run', () => {
      const result = exec('cdp run');
      expect(result.exitCode).toBe(0);
      expect(config.cdpEnabled).toBe(true);
    });

    it('disables cdp with no cdp run', () => {
      exec('cdp run');
      const result = exec('no cdp run');
      expect(result.exitCode).toBe(0);
      expect(config.cdpEnabled).toBe(false);
    });

    it('creates standard access-list', () => {
      const result = exec('access-list 10 permit 192.168.1.0 0.0.0.255');
      expect(result.exitCode).toBe(0);
    });

    it('creates extended access-list', () => {
      const result = exec('access-list 100 permit tcp any host 192.168.1.1 eq 80');
      expect(result.exitCode).toBe(0);
    });

    it('executes do command to run privileged commands', () => {
      const result = exec('do show ip interface brief');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Interface');
    });

    it('executes do show running-config', () => {
      const result = exec('do show running-config');
      expect(result.exitCode).toBe(0);
    });

    it('executes do write memory', () => {
      const result = exec('do write memory');
      expect(result.exitCode).toBe(0);
    });

    it('executes do ping', () => {
      const result = exec('do ping 192.168.1.1');
      expect(result.output).toContain('ICMP Echos');
    });
  });

  describe('Interface Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('interface GigabitEthernet0/0');
    });

    it('enters interface config mode', () => {
      expect(state.mode).toBe('interface');
    });

    it('shows interface help', () => {
      const result = exec('?');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('ip');
      expect(result.output).toContain('shutdown');
      expect(result.output).toContain('description');
    });

    it('sets interface description', () => {
      const result = exec('description WAN Link');
      expect(result.exitCode).toBe(0);
    });

    it('sets ip address', () => {
      const result = exec('ip address 192.168.1.1 255.255.255.0');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('GigabitEthernet0/0');
      expect(iface?.ipAddress).toBe('192.168.1.1');
      expect(iface?.subnetMask).toBe('255.255.255.0');
    });

    it('enables interface with no shutdown', () => {
      const result = exec('no shutdown');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('GigabitEthernet0/0');
      expect(iface?.isAdminDown).toBe(false);
    });

    it('disables interface with shutdown', () => {
      exec('no shutdown');
      const result = exec('shutdown');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('GigabitEthernet0/0');
      expect(iface?.isAdminDown).toBe(true);
    });

    it('sets bandwidth', () => {
      const result = exec('bandwidth 1000000');
      expect(result.exitCode).toBe(0);
    });

    it('sets mtu', () => {
      const result = exec('mtu 1500');
      expect(result.exitCode).toBe(0);
    });

    it('sets duplex', () => {
      const result = exec('duplex full');
      expect(result.exitCode).toBe(0);
    });

    it('sets speed', () => {
      const result = exec('speed 1000');
      expect(result.exitCode).toBe(0);
    });

    it('can switch between interfaces', () => {
      exec('exit');
      const result = exec('interface GigabitEthernet0/1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('configures loopback interface', () => {
      exec('exit');
      const result = exec('interface Loopback0');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('OSPF Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('router ospf 1');
    });

    it('enters router config mode', () => {
      expect(state.mode).toBe('router');
    });

    it('shows router ospf help', () => {
      const result = exec('?');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('network');
      expect(result.output).toContain('router-id');
    });

    it('sets router-id', () => {
      const result = exec('router-id 1.1.1.1');
      expect(result.exitCode).toBe(0);
      expect(config.ospf?.routerId).toBe('1.1.1.1');
    });

    it('adds network statement', () => {
      const result = exec('network 192.168.1.0 0.0.0.255 area 0');
      expect(result.exitCode).toBe(0);
      expect(config.ospf?.networks.length).toBeGreaterThan(0);
    });

    it('sets passive-interface', () => {
      const result = exec('passive-interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
      expect(config.ospf?.passiveInterfaces).toContain('GigabitEthernet0/0');
    });

    it('sets default-information originate', () => {
      const result = exec('default-information originate');
      expect(result.exitCode).toBe(0);
      expect(config.ospf?.defaultInformationOriginate).toBe(true);
    });

    it('shows ip ospf', () => {
      exec('end');
      const result = exec('show ip ospf');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('ospf 1');
    });

    it('shows ip ospf neighbor', () => {
      exec('end');
      const result = exec('show ip ospf neighbor');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Neighbor ID');
    });

    it('shows ip ospf interface', () => {
      exec('end');
      const result = exec('show ip ospf interface');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('EIGRP Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('router eigrp 100');
    });

    it('enters router config mode', () => {
      expect(state.mode).toBe('router');
      expect(config.eigrp?.asNumber).toBe(100);
    });

    it('adds network statement', () => {
      const result = exec('network 10.0.0.0');
      expect(result.exitCode).toBe(0);
    });

    it('disables auto-summary', () => {
      const result = exec('no auto-summary');
      expect(result.exitCode).toBe(0);
      expect(config.eigrp?.autoSummary).toBe(false);
    });

    it('sets passive-interface', () => {
      const result = exec('passive-interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
    });

    it('shows ip eigrp neighbors', () => {
      exec('end');
      const result = exec('show ip eigrp neighbors');
      expect(result.exitCode).toBe(0);
    });

    it('shows ip eigrp topology', () => {
      exec('end');
      const result = exec('show ip eigrp topology');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('RIP Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('router rip');
    });

    it('enters router config mode', () => {
      expect(state.mode).toBe('router');
      expect(config.rip).toBeDefined();
    });

    it('sets version 2', () => {
      const result = exec('version 2');
      expect(result.exitCode).toBe(0);
      expect(config.rip?.version).toBe(2);
    });

    it('adds network statement', () => {
      const result = exec('network 192.168.0.0');
      expect(result.exitCode).toBe(0);
    });

    it('disables auto-summary', () => {
      const result = exec('no auto-summary');
      expect(result.exitCode).toBe(0);
      expect(config.rip?.autoSummary).toBe(false);
    });
  });

  describe('Line Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('enters console line config mode', () => {
      const result = exec('line console 0');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('line');
    });

    it('enters vty line config mode', () => {
      const result = exec('line vty 0 4');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('line');
    });

    it('sets password', () => {
      exec('line console 0');
      const result = exec('password cisco');
      expect(result.exitCode).toBe(0);
    });

    it('enables login', () => {
      exec('line console 0');
      const result = exec('login');
      expect(result.exitCode).toBe(0);
    });

    it('sets exec-timeout', () => {
      exec('line console 0');
      const result = exec('exec-timeout 5 0');
      expect(result.exitCode).toBe(0);
    });

    it('sets transport input', () => {
      exec('line vty 0 4');
      const result = exec('transport input ssh');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Show Interface Commands', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('shows specific interface', () => {
      const result = exec('show interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('GigabitEthernet0/0');
      expect(result.output).toContain('line protocol');
    });

    it('shows interfaces status', () => {
      const result = exec('show interfaces status');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Port');
      expect(result.output).toContain('Status');
    });

    it('shows interfaces description', () => {
      const result = exec('show interfaces description');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Interface');
    });

    it('shows ip interface for specific interface', () => {
      const result = exec('show ip interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
    });

    it('shows running-config interface', () => {
      const result = exec('show running-config interface GigabitEthernet0/0');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('interface');
    });

    it('handles abbreviated interface names', () => {
      const result = exec('show interface gi0/0');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Command Abbreviations', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('accepts en for enable', () => {
      state.mode = 'user';
      const result = exec('en');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('privileged');
    });

    it('accepts conf t for configure terminal', () => {
      const result = exec('conf t');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('global-config');
    });

    it('accepts sh for show', () => {
      const result = exec('sh ver');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Cisco');
    });

    it('accepts wr for write', () => {
      const result = exec('wr');
      expect(result.exitCode).toBe(0);
    });

    it('accepts sh run for show running-config', () => {
      const result = exec('sh run');
      expect(result.exitCode).toBe(0);
    });

    it('accepts sh ip int br for show ip interface brief', () => {
      const result = exec('sh ip int br');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('rejects invalid commands in user mode', () => {
      const result = exec('configure terminal');
      expect(result.exitCode).toBe(1);
    });

    it('rejects unknown show subcommand', () => {
      exec('enable');
      const result = exec('show nonexistent');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Invalid input');
    });

    it('handles incomplete commands', () => {
      exec('enable');
      const result = exec('show');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Incomplete command');
    });

    it('handles invalid interface name', () => {
      exec('enable');
      exec('configure terminal');
      const result = exec('interface InvalidInterface');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('DHCP Pool Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('creates DHCP pool', () => {
      const result = exec('ip dhcp pool MYPOOL');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('dhcp');
    });

    it('shows ip dhcp pool', () => {
      exec('ip dhcp pool MYPOOL');
      exec('end');
      const result = exec('show ip dhcp pool');
      expect(result.exitCode).toBe(0);
    });

    it('shows ip dhcp binding', () => {
      exec('end');
      const result = exec('show ip dhcp binding');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('NAT Configuration', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('shows ip nat translations', () => {
      const result = exec('show ip nat translations');
      expect(result.exitCode).toBe(0);
    });

    it('shows ip nat statistics', () => {
      const result = exec('show ip nat statistics');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Total active translations');
    });
  });

  describe('Access Lists', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('creates standard access-list', () => {
      const result = exec('access-list 1 permit any');
      expect(result.exitCode).toBe(0);
    });

    it('creates access-list with deny', () => {
      const result = exec('access-list 1 deny 10.0.0.0 0.255.255.255');
      expect(result.exitCode).toBe(0);
    });

    it('shows access-lists', () => {
      exec('access-list 1 permit any');
      exec('end');
      const result = exec('show access-lists');
      expect(result.exitCode).toBe(0);
    });

    it('shows ip access-lists', () => {
      exec('end');
      const result = exec('show ip access-lists');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Router Device Integration', () => {
    it('gets correct device type', () => {
      expect(router.getDeviceType()).toBe('router-cisco');
    });

    it('gets correct OS type', () => {
      expect(router.getOSType()).toBe('cisco-ios');
    });

    it('executes show commands through device', () => {
      // Device.executeCommand handles show, ping, arp directly
      const result = router.executeCommand('show version');
      expect(result.exitCode).toBeDefined();
    });

    it('executes ping through device', () => {
      const result = router.executeCommand('ping 192.168.1.1');
      expect(result.output).toBeDefined();
    });

    it('gets prompt in user mode', () => {
      expect(router.getPrompt()).toContain('>');
    });

    it('has router-specific interfaces (GigabitEthernet)', () => {
      const ciscoConfig = router.getCiscoConfig();
      expect(ciscoConfig.interfaces.has('GigabitEthernet0/0')).toBe(true);
    });

    it('supports IP routing', () => {
      const ciscoConfig = router.getCiscoConfig();
      expect(ciscoConfig.ipRouting).toBe(true);
    });

    it('can configure IP address', () => {
      router.configureIP('GigabitEthernet0/0', '192.168.1.1', '255.255.255.0');
      const ciscoConfig = router.getCiscoConfig();
      const iface = ciscoConfig.interfaces.get('GigabitEthernet0/0');
      expect(iface?.ipAddress).toBe('192.168.1.1');
    });

    it('can set interface state', () => {
      router.setInterfaceState('GigabitEthernet0/0', true);
      const ciscoConfig = router.getCiscoConfig();
      const iface = ciscoConfig.interfaces.get('GigabitEthernet0/0');
      expect(iface?.isAdminDown).toBe(false);
    });

    it('can add static route', () => {
      router.addStaticRoute('10.0.0.0', '255.0.0.0', '192.168.1.254');
      const ciscoConfig = router.getCiscoConfig();
      expect(ciscoConfig.staticRoutes.length).toBeGreaterThan(0);
    });

    it('is a router type device', () => {
      expect(router.getCiscoType()).toBe('router');
    });

    it('has boot time', () => {
      expect(router.getBootTime()).toBeInstanceOf(Date);
    });

    it('returns terminal state', () => {
      const terminalState = router.getTerminalState();
      expect(terminalState.mode).toBe('user');
    });
  });
});
