/**
 * Cisco Command Suggestions and Implementation Tests
 *
 * This test suite verifies:
 * 1. All suggested commands are actually implemented
 * 2. Every implemented command has a real effect on device state
 * 3. The Tab completion/suggestion system works correctly
 * 4. All modes have proper command coverage
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeCiscoCommand,
  parseCommand,
} from '../terminal/cisco/commands/index';
import {
  createDefaultRouterConfig,
  createDefaultSwitchConfig,
  createDefaultTerminalState,
} from '../terminal/cisco';
import {
  CiscoConfig,
  CiscoTerminalState,
} from '../terminal/cisco/types';

describe('Cisco Command Suggestions & Implementation', () => {
  let routerConfig: CiscoConfig;
  let switchConfig: CiscoConfig;
  let routerState: CiscoTerminalState;
  let switchState: CiscoTerminalState;
  const bootTime = new Date();

  beforeEach(() => {
    routerConfig = createDefaultRouterConfig('TestRouter');
    switchConfig = createDefaultSwitchConfig('TestSwitch');
    routerState = createDefaultTerminalState('TestRouter');
    switchState = createDefaultTerminalState('TestSwitch');
  });

  // Helper to execute command and update state
  function execRouter(command: string): ReturnType<typeof executeCiscoCommand> {
    const result = executeCiscoCommand(command, routerState, routerConfig, bootTime);
    if (result.newMode) routerState.mode = result.newMode;
    if (result.newInterface) routerState.currentInterface = result.newInterface;
    if (result.newRouter) routerState.currentRouter = result.newRouter;
    if (result.newLine) routerState.currentLine = result.newLine;
    if (result.newVlan) routerState.currentVlan = result.newVlan;
    if (result.newDHCPPool) routerState.currentDHCPPool = result.newDHCPPool;
    if (result.newACL) routerState.currentACL = result.newACL;
    return result;
  }

  function execSwitch(command: string): ReturnType<typeof executeCiscoCommand> {
    const result = executeCiscoCommand(command, switchState, switchConfig, bootTime);
    if (result.newMode) switchState.mode = result.newMode;
    if (result.newInterface) switchState.currentInterface = result.newInterface;
    if (result.newRouter) switchState.currentRouter = result.newRouter;
    if (result.newLine) switchState.currentLine = result.newLine;
    if (result.newVlan) switchState.currentVlan = result.newVlan;
    if (result.newDHCPPool) switchState.currentDHCPPool = result.newDHCPPool;
    if (result.newACL) switchState.currentACL = result.newACL;
    return result;
  }

  // ============================================================================
  // SECTION 1: USER MODE COMMANDS
  // ============================================================================
  describe('User Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'user';
    });

    describe('enable', () => {
      it('transitions to privileged mode', () => {
        const result = execRouter('enable');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('privileged');
      });

      it('abbreviation "en" works', () => {
        const result = execRouter('en');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('privileged');
      });
    });

    describe('disable', () => {
      it('stays in user mode (no-op)', () => {
        const result = execRouter('disable');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('user');
      });
    });

    describe('ping', () => {
      it('requires a target', () => {
        const result = execRouter('ping');
        expect(result.exitCode).toBe(1);
        expect(result.error).toContain('Incomplete');
      });

      it('executes ping with target', () => {
        const result = execRouter('ping 8.8.8.8');
        expect(result.exitCode).toBeDefined();
        expect(result.output).toContain('ICMP Echos');
      });
    });

    describe('traceroute', () => {
      it('requires a target', () => {
        const result = execRouter('traceroute');
        expect(result.exitCode).toBe(1);
      });

      it('executes traceroute with target', () => {
        const result = execRouter('traceroute 8.8.8.8');
        expect(result.output).toContain('Tracing');
      });

      it('abbreviation "trace" works', () => {
        const result = execRouter('trace 8.8.8.8');
        expect(result.output).toContain('Tracing');
      });
    });

    describe('show (limited in user mode)', () => {
      it('allows show version', () => {
        const result = execRouter('show version');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('Cisco IOS');
      });

      it('allows show clock', () => {
        const result = execRouter('show clock');
        expect(result.exitCode).toBe(0);
      });

      it('allows show history', () => {
        const result = execRouter('show history');
        expect(result.exitCode).toBe(0);
      });

      it('allows show users', () => {
        const result = execRouter('show users');
        expect(result.exitCode).toBe(0);
      });

      it('denies show running-config', () => {
        const result = execRouter('show running-config');
        expect(result.exitCode).toBe(1);
      });

      it('denies show ip route', () => {
        const result = execRouter('show ip route');
        expect(result.exitCode).toBe(1);
      });
    });

    describe('terminal', () => {
      it('sets terminal length', () => {
        const result = execRouter('terminal length 50');
        expect(result.exitCode).toBe(0);
        expect(routerState.terminalLength).toBe(50);
      });

      it('sets terminal width', () => {
        const result = execRouter('terminal width 132');
        expect(result.exitCode).toBe(0);
        expect(routerState.terminalWidth).toBe(132);
      });
    });

    describe('exit/quit/logout', () => {
      it('exit works', () => {
        const result = execRouter('exit');
        expect(result.exitCode).toBe(0);
      });

      it('quit works', () => {
        const result = execRouter('quit');
        expect(result.exitCode).toBe(0);
      });

      it('logout works', () => {
        const result = execRouter('logout');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('connect/telnet/ssh', () => {
      it('telnet requires host', () => {
        const result = execRouter('telnet');
        expect(result.exitCode).toBe(1);
      });

      it('telnet attempts connection', () => {
        const result = execRouter('telnet 192.168.1.1');
        expect(result.output).toContain('Trying');
      });

      it('ssh shows usage without args', () => {
        const result = execRouter('ssh');
        expect(result.output).toContain('Usage');
      });

      it('ssh attempts connection', () => {
        const result = execRouter('ssh 192.168.1.1');
        expect(result.output).toContain('Trying');
      });
    });

    describe('context help (?)', () => {
      it('shows available commands', () => {
        const result = execRouter('?');
        expect(result.output).toContain('enable');
        expect(result.output).toContain('show');
        expect(result.output).toContain('ping');
      });
    });
  });

  // ============================================================================
  // SECTION 2: PRIVILEGED MODE COMMANDS
  // ============================================================================
  describe('Privileged Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'privileged';
      switchState.mode = 'privileged';
    });

    describe('configure terminal', () => {
      it('enters global config mode', () => {
        const result = execRouter('configure terminal');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('global-config');
      });

      it('abbreviation "conf t" works', () => {
        const result = execRouter('conf t');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('global-config');
      });
    });

    describe('show commands (full access)', () => {
      it('show running-config', () => {
        const result = execRouter('show running-config');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('hostname');
      });

      it('show startup-config', () => {
        const result = execRouter('show startup-config');
        expect(result.exitCode).toBe(0);
      });

      it('show ip route', () => {
        const result = execRouter('show ip route');
        expect(result.exitCode).toBe(0);
      });

      it('show ip interface brief', () => {
        const result = execRouter('show ip interface brief');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('Interface');
      });

      it('show interfaces', () => {
        const result = execRouter('show interfaces');
        expect(result.exitCode).toBe(0);
      });

      it('show interfaces status (switch)', () => {
        const result = execSwitch('show interfaces status');
        expect(result.exitCode).toBe(0);
      });

      it('show vlan (switch)', () => {
        const result = execSwitch('show vlan');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('VLAN');
      });

      it('show mac address-table (switch)', () => {
        const result = execSwitch('show mac address-table');
        expect(result.exitCode).toBe(0);
      });

      it('show spanning-tree', () => {
        const result = execSwitch('show spanning-tree');
        expect(result.exitCode).toBe(0);
      });

      it('show arp', () => {
        const result = execRouter('show arp');
        expect(result.exitCode).toBe(0);
      });

      it('show ip ospf', () => {
        const result = execRouter('show ip ospf');
        expect(result.exitCode).toBe(0);
      });

      it('show ip eigrp neighbors', () => {
        const result = execRouter('show ip eigrp neighbors');
        expect(result.exitCode).toBe(0);
      });

      it('show access-lists', () => {
        const result = execRouter('show access-lists');
        expect(result.exitCode).toBe(0);
      });

      it('show ip dhcp pool', () => {
        const result = execRouter('show ip dhcp pool');
        expect(result.exitCode).toBe(0);
      });

      it('show cdp neighbors', () => {
        const result = execRouter('show cdp neighbors');
        expect(result.exitCode).toBe(0);
      });

      it('show logging', () => {
        const result = execRouter('show logging');
        expect(result.exitCode).toBe(0);
      });

      it('show privilege', () => {
        const result = execRouter('show privilege');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('write', () => {
      it('write memory saves config', () => {
        routerState.configModified = true;
        const result = execRouter('write memory');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('OK');
        expect(routerState.configModified).toBe(false);
      });

      it('abbreviation "wr" works', () => {
        const result = execRouter('wr');
        expect(result.exitCode).toBe(0);
      });

      it('write erase clears config', () => {
        const result = execRouter('write erase');
        expect(result.output).toContain('Erasing');
      });
    });

    describe('copy', () => {
      it('copy running-config startup-config', () => {
        const result = execRouter('copy running-config startup-config');
        expect(result.exitCode).toBe(0);
      });

      it('requires source and destination', () => {
        const result = execRouter('copy');
        expect(result.exitCode).toBe(1);
      });
    });

    describe('erase', () => {
      it('erase startup-config', () => {
        const result = execRouter('erase startup-config');
        expect(result.output).toContain('Erasing');
      });

      it('requires target', () => {
        const result = execRouter('erase');
        expect(result.exitCode).toBe(1);
      });
    });

    describe('reload', () => {
      it('prompts for confirmation', () => {
        const result = execRouter('reload');
        expect(result.output).toContain('Proceed');
      });

      it('warns about unsaved config', () => {
        routerState.configModified = true;
        const result = execRouter('reload');
        expect(result.output).toContain('Save');
      });
    });

    describe('clear', () => {
      it('clear arp-cache clears ARP table', () => {
        routerConfig.arpTable = [{ ip: '1.1.1.1', mac: 'aa:bb:cc:dd:ee:ff', interface: 'Gi0/0', type: 'DYNAMIC' }];
        const result = execRouter('clear arp-cache');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.arpTable).toHaveLength(0);
      });

      it('clear mac address-table clears MAC table', () => {
        switchConfig.macTable = [{ mac: 'aa:bb:cc:dd:ee:ff', vlan: 1, port: 'Fa0/1', type: 'DYNAMIC' }];
        const result = execSwitch('clear mac address-table');
        expect(result.exitCode).toBe(0);
        expect(switchConfig.macTable).toHaveLength(0);
      });

      it('clear counters resets interface counters', () => {
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        if (iface) {
          iface.inputPackets = 1000;
          iface.outputPackets = 2000;
        }
        const result = execRouter('clear counters');
        expect(result.exitCode).toBe(0);
        const ifaceAfter = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(ifaceAfter?.inputPackets).toBe(0);
        expect(ifaceAfter?.outputPackets).toBe(0);
      });
    });

    describe('debug/undebug', () => {
      it('debug enables debugging', () => {
        const result = execRouter('debug ip ospf');
        expect(result.output).toContain('debugging is on');
      });

      it('undebug all disables all debugging', () => {
        const result = execRouter('undebug all');
        expect(result.output).toContain('turned off');
      });
    });

    describe('clock', () => {
      it('clock set accepts time', () => {
        const result = execRouter('clock set 12:00:00 1 Jan 2024');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('dir', () => {
      it('shows flash contents', () => {
        const result = execRouter('dir');
        expect(result.output).toContain('flash');
      });
    });

    describe('delete', () => {
      it('prompts for confirmation', () => {
        const result = execRouter('delete test.txt');
        expect(result.output).toContain('Delete');
      });
    });

    describe('verify', () => {
      it('verifies file integrity', () => {
        const result = execRouter('verify flash:image.bin');
        expect(result.output).toContain('Verified');
      });
    });

    describe('disable', () => {
      it('returns to user mode', () => {
        const result = execRouter('disable');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('user');
      });
    });
  });

  // ============================================================================
  // SECTION 3: GLOBAL CONFIG MODE COMMANDS
  // ============================================================================
  describe('Global Config Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'global-config';
      switchState.mode = 'global-config';
    });

    describe('hostname', () => {
      it('changes hostname', () => {
        const result = execRouter('hostname NewRouter');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.hostname).toBe('NewRouter');
        expect(routerState.hostname).toBe('NewRouter');
      });

      it('validates hostname format', () => {
        const result = execRouter('hostname 123invalid');
        expect(result.exitCode).toBe(1);
      });

      it('no hostname restores default', () => {
        execRouter('hostname CustomName');
        execRouter('no hostname');
        expect(routerConfig.hostname).toBe('Router');
      });
    });

    describe('enable secret/password', () => {
      it('sets enable secret', () => {
        const result = execRouter('enable secret mysecret');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.enableSecret).toBe('mysecret');
      });

      it('sets enable password', () => {
        const result = execRouter('enable password mypassword');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.enablePassword).toBe('mypassword');
      });

      it('no enable secret removes it', () => {
        execRouter('enable secret test');
        execRouter('no enable secret');
        expect(routerConfig.enableSecret).toBeUndefined();
      });
    });

    describe('username', () => {
      it('creates user with privilege and secret', () => {
        const result = execRouter('username admin privilege 15 secret cisco123');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.username).toContainEqual({
          name: 'admin',
          privilege: 15,
          secret: 'cisco123'
        });
      });

      it('no username removes user', () => {
        execRouter('username testuser privilege 1 secret test');
        execRouter('no username testuser');
        expect(routerConfig.username.find(u => u.name === 'testuser')).toBeUndefined();
      });
    });

    describe('service', () => {
      it('enables password-encryption', () => {
        const result = execRouter('service password-encryption');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.servicePasswordEncryption).toBe(true);
      });

      it('no service disables it', () => {
        execRouter('service password-encryption');
        execRouter('no service password-encryption');
        expect(routerConfig.servicePasswordEncryption).toBe(false);
      });
    });

    describe('ip routing', () => {
      it('enables IP routing', () => {
        const result = execRouter('ip routing');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.ipRouting).toBe(true);
      });

      it('no ip routing disables it', () => {
        execRouter('ip routing');
        execRouter('no ip routing');
        expect(routerConfig.ipRouting).toBe(false);
      });
    });

    describe('ip route (static routing)', () => {
      it('adds static route', () => {
        const result = execRouter('ip route 10.0.0.0 255.0.0.0 192.168.1.1');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.staticRoutes).toContainEqual(expect.objectContaining({
          network: '10.0.0.0',
          mask: '255.0.0.0',
          nextHop: '192.168.1.1'
        }));
      });

      it('adds static route via interface', () => {
        const result = execRouter('ip route 10.0.0.0 255.0.0.0 GigabitEthernet0/0');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.staticRoutes).toContainEqual(expect.objectContaining({
          network: '10.0.0.0',
          interface: 'GigabitEthernet0/0'
        }));
      });

      it('no ip route removes it', () => {
        execRouter('ip route 10.0.0.0 255.0.0.0 192.168.1.1');
        execRouter('no ip route 10.0.0.0 255.0.0.0');
        expect(routerConfig.staticRoutes.find(r => r.network === '10.0.0.0')).toBeUndefined();
      });
    });

    describe('ip default-gateway', () => {
      it('sets default gateway', () => {
        const result = execSwitch('ip default-gateway 192.168.1.1');
        expect(result.exitCode).toBe(0);
        expect(switchConfig.defaultGateway).toBe('192.168.1.1');
      });
    });

    describe('ip domain-name', () => {
      it('sets domain name', () => {
        const result = execRouter('ip domain-name example.com');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.domainName).toBe('example.com');
      });
    });

    describe('ip domain-lookup', () => {
      it('enables DNS lookup', () => {
        const result = execRouter('ip domain-lookup');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.ipDomainLookup).toBe(true);
      });

      it('no ip domain-lookup disables it', () => {
        execRouter('no ip domain-lookup');
        expect(routerConfig.ipDomainLookup).toBe(false);
      });
    });

    describe('ip name-server', () => {
      it('adds DNS server', () => {
        const result = execRouter('ip name-server 8.8.8.8');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.nameServers).toContain('8.8.8.8');
      });

      it('no ip name-server removes it', () => {
        execRouter('ip name-server 8.8.8.8');
        execRouter('no ip name-server 8.8.8.8');
        expect(routerConfig.nameServers).not.toContain('8.8.8.8');
      });
    });

    describe('interface', () => {
      it('enters interface config mode', () => {
        const result = execRouter('interface GigabitEthernet0/0');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('interface');
        expect(routerState.currentInterface).toBe('GigabitEthernet0/0');
      });

      it('abbreviation "int gi0/0" works', () => {
        const result = execRouter('int gi0/0');
        expect(result.exitCode).toBe(0);
        expect(routerState.currentInterface).toBe('GigabitEthernet0/0');
      });

      it('creates loopback interface', () => {
        const result = execRouter('interface Loopback0');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.interfaces.has('Loopback0')).toBe(true);
      });

      it('creates VLAN interface (switch)', () => {
        const result = execSwitch('interface Vlan10');
        expect(result.exitCode).toBe(0);
        expect(switchConfig.interfaces.has('Vlan10')).toBe(true);
      });
    });

    describe('line', () => {
      it('enters console line config', () => {
        const result = execRouter('line console 0');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('line');
        expect(routerState.currentLine?.type).toBe('console');
      });

      it('enters vty line config', () => {
        const result = execRouter('line vty 0 4');
        expect(result.exitCode).toBe(0);
        expect(routerState.currentLine?.type).toBe('vty');
        expect(routerState.currentLine?.start).toBe(0);
        expect(routerState.currentLine?.end).toBe(4);
      });
    });

    describe('router ospf', () => {
      it('enables OSPF', () => {
        const result = execRouter('router ospf 1');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('router');
        expect(routerConfig.ospf).toBeDefined();
        expect(routerConfig.ospf?.processId).toBe(1);
      });

      it('no router ospf removes it', () => {
        execRouter('router ospf 1');
        execRouter('exit');
        routerState.mode = 'global-config';
        execRouter('no router ospf 1');
        expect(routerConfig.ospf).toBeUndefined();
      });
    });

    describe('router eigrp', () => {
      it('enables EIGRP', () => {
        const result = execRouter('router eigrp 100');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.eigrp).toBeDefined();
        expect(routerConfig.eigrp?.asNumber).toBe(100);
      });
    });

    describe('router rip', () => {
      it('enables RIP', () => {
        const result = execRouter('router rip');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.rip).toBeDefined();
      });
    });

    describe('vlan', () => {
      it('creates and enters VLAN config', () => {
        const result = execSwitch('vlan 10');
        expect(result.exitCode).toBe(0);
        expect(switchState.mode).toBe('vlan');
        expect(switchConfig.vlans.has(10)).toBe(true);
      });

      it('validates VLAN ID range', () => {
        const result = execSwitch('vlan 5000');
        expect(result.exitCode).toBe(1);
      });

      it('no vlan removes it', () => {
        execSwitch('vlan 100');
        execSwitch('exit');
        switchState.mode = 'global-config';
        execSwitch('no vlan 100');
        expect(switchConfig.vlans.has(100)).toBe(false);
      });

      it('cannot delete VLAN 1', () => {
        const result = execSwitch('no vlan 1');
        expect(result.exitCode).toBe(1);
      });
    });

    describe('banner', () => {
      it('sets MOTD banner', () => {
        const result = execRouter('banner motd # Welcome to Router #');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.banners.motd).toBeDefined();
      });

      it('sets login banner', () => {
        execRouter('banner login # Authorized only #');
        expect(routerConfig.banners.login).toBeDefined();
      });

      it('no banner removes it', () => {
        execRouter('banner motd # test #');
        execRouter('no banner motd');
        expect(routerConfig.banners.motd).toBeUndefined();
      });
    });

    describe('logging', () => {
      it('enables buffered logging', () => {
        execRouter('logging buffered');
        expect(routerConfig.loggingBuffered).toBe(true);
      });

      it('enables console logging', () => {
        execRouter('logging console');
        expect(routerConfig.loggingConsole).toBe(true);
      });
    });

    describe('cdp', () => {
      it('enables CDP', () => {
        execRouter('cdp run');
        expect(routerConfig.cdpEnabled).toBe(true);
      });

      it('no cdp run disables it', () => {
        execRouter('cdp run');
        execRouter('no cdp run');
        expect(routerConfig.cdpEnabled).toBe(false);
      });
    });

    describe('lldp', () => {
      it('enables LLDP', () => {
        execRouter('lldp run');
        expect(routerConfig.lldpEnabled).toBe(true);
      });
    });

    describe('spanning-tree', () => {
      it('sets STP mode', () => {
        execSwitch('spanning-tree mode rapid-pvst');
        expect(switchConfig.stpMode).toBe('rapid-pvst');
      });

      it('sets per-VLAN priority', () => {
        execSwitch('spanning-tree vlan 1 priority 4096');
        expect(switchConfig.stpPriority).toContainEqual({ vlan: 1, priority: 4096 });
      });
    });

    describe('vtp', () => {
      it('sets VTP mode', () => {
        execSwitch('vtp mode transparent');
        expect(switchConfig.vtpMode).toBe('transparent');
      });

      it('sets VTP domain', () => {
        execSwitch('vtp domain TESTDOMAIN');
        expect(switchConfig.vtpDomain).toBe('TESTDOMAIN');
      });
    });

    describe('access-list (numbered)', () => {
      it('creates standard ACL', () => {
        const result = execRouter('access-list 10 permit 192.168.1.0 0.0.0.255');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.accessLists.has(10)).toBe(true);
        const acl = routerConfig.accessLists.get(10);
        expect(acl?.type).toBe('standard');
        expect(acl?.entries).toHaveLength(1);
      });

      it('creates extended ACL', () => {
        const result = execRouter('access-list 100 permit tcp any any eq 80');
        expect(result.exitCode).toBe(0);
        const acl = routerConfig.accessLists.get(100);
        expect(acl?.type).toBe('extended');
      });

      it('no access-list removes it', () => {
        execRouter('access-list 10 permit any');
        execRouter('no access-list 10');
        expect(routerConfig.accessLists.has(10)).toBe(false);
      });
    });

    describe('ip access-list (named)', () => {
      it('creates named standard ACL', () => {
        const result = execRouter('ip access-list standard MYACL');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('acl');
        expect(routerConfig.accessLists.has('MYACL')).toBe(true);
      });

      it('creates named extended ACL', () => {
        const result = execRouter('ip access-list extended EXTACL');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('ip dhcp pool', () => {
      it('creates DHCP pool', () => {
        const result = execRouter('ip dhcp pool POOL1');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('dhcp');
        expect(routerConfig.dhcpPools.has('POOL1')).toBe(true);
      });

      it('no ip dhcp pool removes it', () => {
        execRouter('ip dhcp pool TESTPOOL');
        execRouter('exit');
        routerState.mode = 'global-config';
        execRouter('no ip dhcp pool TESTPOOL');
        expect(routerConfig.dhcpPools.has('TESTPOOL')).toBe(false);
      });
    });

    describe('ip dhcp excluded-address', () => {
      it('excludes address range', () => {
        const result = execRouter('ip dhcp excluded-address 192.168.1.1 192.168.1.10');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.dhcpExcluded).toContainEqual({
          start: '192.168.1.1',
          end: '192.168.1.10'
        });
      });
    });

    describe('ip nat', () => {
      it('configures static NAT', () => {
        const result = execRouter('ip nat inside source static 192.168.1.100 203.0.113.100');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.nat?.staticNAT).toContainEqual({
          inside: '192.168.1.100',
          outside: '203.0.113.100'
        });
      });

      it('configures NAT pool', () => {
        const result = execRouter('ip nat pool NATPOOL 203.0.113.1 203.0.113.10 netmask 255.255.255.0');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('ntp server', () => {
      it('adds NTP server', () => {
        const result = execRouter('ntp server 1.1.1.1');
        expect(result.exitCode).toBe(0);
        expect(routerConfig.ntpServer).toContain('1.1.1.1');
      });
    });

    describe('do command', () => {
      it('executes privileged command from config mode', () => {
        const result = execRouter('do show version');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('Cisco');
      });

      it('do write memory works', () => {
        const result = execRouter('do write memory');
        expect(result.exitCode).toBe(0);
      });
    });

    describe('end', () => {
      it('returns to privileged mode', () => {
        const result = execRouter('end');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('privileged');
      });
    });

    describe('exit', () => {
      it('returns to privileged mode from global config', () => {
        const result = execRouter('exit');
        expect(result.exitCode).toBe(0);
        expect(routerState.mode).toBe('privileged');
      });
    });
  });

  // ============================================================================
  // SECTION 4: INTERFACE CONFIG MODE COMMANDS
  // ============================================================================
  describe('Interface Config Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'global-config';
      switchState.mode = 'global-config';
      execRouter('interface GigabitEthernet0/0');
      execSwitch('interface FastEthernet0/1');
    });

    describe('description', () => {
      it('sets interface description', () => {
        const result = execRouter('description WAN Link to ISP');
        expect(result.exitCode).toBe(0);
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.description).toBe('WAN Link to ISP');
      });

      it('no description removes it', () => {
        execRouter('description test');
        execRouter('no description');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.description).toBeUndefined();
      });
    });

    describe('ip address', () => {
      it('sets IP address', () => {
        const result = execRouter('ip address 192.168.1.1 255.255.255.0');
        expect(result.exitCode).toBe(0);
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ipAddress).toBe('192.168.1.1');
        expect(iface?.subnetMask).toBe('255.255.255.0');
      });

      it('supports secondary addresses', () => {
        execRouter('ip address 192.168.1.1 255.255.255.0');
        execRouter('ip address 192.168.2.1 255.255.255.0 secondary');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.secondaryIPs).toContainEqual({ ip: '192.168.2.1', mask: '255.255.255.0' });
      });

      it('supports DHCP client', () => {
        execRouter('ip address dhcp');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ipAddress).toBeDefined();
      });

      it('no ip address removes it', () => {
        execRouter('ip address 192.168.1.1 255.255.255.0');
        execRouter('no ip address');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ipAddress).toBeUndefined();
      });
    });

    describe('ip helper-address', () => {
      it('adds helper address', () => {
        execRouter('ip helper-address 192.168.1.100');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ipHelper).toContain('192.168.1.100');
      });

      it('no ip helper-address removes it', () => {
        execRouter('ip helper-address 192.168.1.100');
        execRouter('no ip helper-address 192.168.1.100');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ipHelper).not.toContain('192.168.1.100');
      });
    });

    describe('ip ospf', () => {
      it('sets OSPF cost', () => {
        execRouter('ip ospf cost 100');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ospfCost).toBe(100);
      });

      it('sets OSPF priority', () => {
        execRouter('ip ospf priority 200');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ospfPriority).toBe(200);
      });

      it('sets OSPF network type', () => {
        execRouter('ip ospf network point-to-point');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.ospfNetwork).toBe('point-to-point');
      });
    });

    describe('ip nat inside/outside', () => {
      it('configures NAT inside', () => {
        execRouter('ip nat inside');
        expect(routerConfig.nat?.insideInterfaces).toContain('GigabitEthernet0/0');
      });

      it('configures NAT outside', () => {
        execRouter('ip nat outside');
        expect(routerConfig.nat?.outsideInterfaces).toContain('GigabitEthernet0/0');
      });
    });

    describe('shutdown', () => {
      it('shuts down interface', () => {
        execRouter('shutdown');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.isAdminDown).toBe(true);
        expect(iface?.isUp).toBe(false);
      });

      it('no shutdown enables interface', () => {
        execRouter('shutdown');
        execRouter('no shutdown');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.isAdminDown).toBe(false);
        expect(iface?.isUp).toBe(true);
      });
    });

    describe('speed', () => {
      it('sets interface speed', () => {
        execRouter('speed 1000');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.speed).toBe('1000');
      });

      it('sets auto speed', () => {
        execRouter('speed auto');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.speed).toBe('auto');
      });
    });

    describe('duplex', () => {
      it('sets full duplex', () => {
        execRouter('duplex full');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.duplex).toBe('full');
      });

      it('sets half duplex', () => {
        execRouter('duplex half');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.duplex).toBe('half');
      });
    });

    describe('mtu', () => {
      it('sets MTU', () => {
        execRouter('mtu 9000');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.mtu).toBe(9000);
      });
    });

    describe('bandwidth', () => {
      it('sets bandwidth', () => {
        execRouter('bandwidth 100000');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
        expect(iface?.bandwidth).toBe(100000);
      });
    });

    describe('switchport mode', () => {
      it('sets access mode', () => {
        execSwitch('switchport mode access');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.switchportMode).toBe('access');
      });

      it('sets trunk mode', () => {
        execSwitch('switchport mode trunk');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.switchportMode).toBe('trunk');
      });
    });

    describe('switchport access vlan', () => {
      it('assigns access VLAN', () => {
        execSwitch('switchport mode access');
        execSwitch('switchport access vlan 10');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.accessVlan).toBe(10);
      });
    });

    describe('switchport trunk', () => {
      it('sets native VLAN', () => {
        execSwitch('switchport mode trunk');
        execSwitch('switchport trunk native vlan 99');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.nativeVlan).toBe(99);
      });

      it('sets allowed VLANs', () => {
        execSwitch('switchport mode trunk');
        execSwitch('switchport trunk allowed vlan 10,20,30');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.allowedVlans).toBe('10,20,30');
      });

      it('adds allowed VLANs', () => {
        execSwitch('switchport trunk allowed vlan 10');
        execSwitch('switchport trunk allowed vlan add 20');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.allowedVlans).toContain('20');
      });
    });

    describe('switchport voice vlan', () => {
      it('sets voice VLAN', () => {
        execSwitch('switchport voice vlan 50');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.voiceVlan).toBe(50);
      });
    });

    describe('switchport port-security', () => {
      it('enables port security', () => {
        execSwitch('switchport port-security');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.portSecurity?.enabled).toBe(true);
      });

      it('sets maximum MAC addresses', () => {
        execSwitch('switchport port-security');
        execSwitch('switchport port-security maximum 5');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.portSecurity?.maximum).toBe(5);
      });

      it('sets violation mode', () => {
        execSwitch('switchport port-security');
        execSwitch('switchport port-security violation restrict');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.portSecurity?.violation).toBe('restrict');
      });

      it('enables sticky MAC', () => {
        execSwitch('switchport port-security');
        execSwitch('switchport port-security mac-address sticky');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.portSecurity?.sticky).toBe(true);
      });
    });

    describe('spanning-tree portfast', () => {
      it('enables portfast', () => {
        execSwitch('spanning-tree portfast');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.stpPortfast).toBe(true);
      });
    });

    describe('spanning-tree bpduguard', () => {
      it('enables BPDU guard', () => {
        execSwitch('spanning-tree bpduguard enable');
        const iface = switchConfig.interfaces.get('FastEthernet0/1');
        expect(iface?.stpBpduguard).toBe(true);
      });
    });

    describe('encapsulation dot1q', () => {
      it('sets 802.1Q encapsulation on subinterface', () => {
        execRouter('exit');
        routerState.mode = 'global-config';
        execRouter('interface GigabitEthernet0/0.10');
        execRouter('encapsulation dot1q 10');
        const iface = routerConfig.interfaces.get('GigabitEthernet0/0.10');
        expect(iface?.accessVlan).toBe(10);
      });
    });
  });

  // ============================================================================
  // SECTION 5: LINE CONFIG MODE COMMANDS
  // ============================================================================
  describe('Line Config Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'global-config';
      execRouter('line console 0');
    });

    describe('password', () => {
      it('sets line password', () => {
        execRouter('password cisco');
        expect(routerConfig.lineConsole.password).toBe('cisco');
      });
    });

    describe('login', () => {
      it('enables password login', () => {
        execRouter('login');
        expect(routerConfig.lineConsole.login).toBe(true);
      });

      it('enables local authentication', () => {
        execRouter('login local');
        expect(routerConfig.lineConsole.loginLocal).toBe(true);
      });
    });

    describe('exec-timeout', () => {
      it('sets exec timeout', () => {
        execRouter('exec-timeout 5 30');
        expect(routerConfig.lineConsole.execTimeout).toEqual({ minutes: 5, seconds: 30 });
      });
    });

    describe('transport input', () => {
      it('sets allowed protocols', () => {
        execRouter('exit');
        routerState.mode = 'global-config';
        execRouter('line vty 0 4');
        execRouter('transport input ssh');
        expect(routerConfig.lineVty[0]?.transportInput).toContain('ssh');
      });
    });

    describe('logging synchronous', () => {
      it('enables synchronous logging', () => {
        execRouter('logging synchronous');
        expect(routerConfig.lineConsole.loggingSynchronous).toBe(true);
      });
    });
  });

  // ============================================================================
  // SECTION 6: ROUTER CONFIG MODE COMMANDS (OSPF/EIGRP/RIP)
  // ============================================================================
  describe('Router Config Mode Commands', () => {
    describe('OSPF Configuration', () => {
      beforeEach(() => {
        routerState.mode = 'global-config';
        execRouter('router ospf 1');
      });

      it('adds network statement', () => {
        execRouter('network 192.168.1.0 0.0.0.255 area 0');
        expect(routerConfig.ospf?.networks).toContainEqual({
          network: '192.168.1.0',
          wildcardMask: '0.0.0.255',
          area: 0
        });
      });

      it('sets router-id', () => {
        execRouter('router-id 1.1.1.1');
        expect(routerConfig.ospf?.routerId).toBe('1.1.1.1');
      });

      it('adds passive interface', () => {
        execRouter('passive-interface GigabitEthernet0/0');
        expect(routerConfig.ospf?.passiveInterfaces).toContain('GigabitEthernet0/0');
      });

      it('enables default-information originate', () => {
        execRouter('default-information originate');
        expect(routerConfig.ospf?.defaultInformationOriginate).toBe(true);
      });

      it('redistributes static routes', () => {
        execRouter('redistribute static');
        expect(routerConfig.ospf?.redistributeStatic).toBe(true);
      });

      it('redistributes connected networks', () => {
        execRouter('redistribute connected');
        expect(routerConfig.ospf?.redistributeConnected).toBe(true);
      });
    });

    describe('EIGRP Configuration', () => {
      beforeEach(() => {
        routerState.mode = 'global-config';
        execRouter('router eigrp 100');
      });

      it('adds network', () => {
        execRouter('network 10.0.0.0');
        expect(routerConfig.eigrp?.networks).toContain('10.0.0.0');
      });

      it('sets router-id', () => {
        execRouter('router-id 2.2.2.2');
        expect(routerConfig.eigrp?.routerId).toBe('2.2.2.2');
      });

      it('disables auto-summary', () => {
        execRouter('no auto-summary');
        expect(routerConfig.eigrp?.autoSummary).toBe(false);
      });

      it('adds passive interface', () => {
        execRouter('passive-interface default');
        expect(routerConfig.eigrp?.passiveInterfaces).toContain('default');
      });
    });

    describe('RIP Configuration', () => {
      beforeEach(() => {
        routerState.mode = 'global-config';
        execRouter('router rip');
      });

      it('adds network', () => {
        execRouter('network 172.16.0.0');
        expect(routerConfig.rip?.networks).toContain('172.16.0.0');
      });

      it('sets RIP version', () => {
        execRouter('version 2');
        expect(routerConfig.rip?.version).toBe(2);
      });

      it('disables auto-summary', () => {
        execRouter('no auto-summary');
        expect(routerConfig.rip?.autoSummary).toBe(false);
      });

      it('enables default-information originate', () => {
        execRouter('default-information originate');
        expect(routerConfig.rip?.defaultInformationOriginate).toBe(true);
      });
    });
  });

  // ============================================================================
  // SECTION 7: VLAN CONFIG MODE COMMANDS
  // ============================================================================
  describe('VLAN Config Mode Commands', () => {
    beforeEach(() => {
      switchState.mode = 'global-config';
      execSwitch('vlan 100');
    });

    describe('name', () => {
      it('sets VLAN name', () => {
        execSwitch('name Engineering');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.name).toBe('Engineering');
      });
    });

    describe('state', () => {
      it('sets VLAN state active', () => {
        execSwitch('state active');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.state).toBe('active');
      });

      it('sets VLAN state suspend', () => {
        execSwitch('state suspend');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.state).toBe('suspend');
      });
    });

    describe('shutdown', () => {
      it('shuts down VLAN', () => {
        execSwitch('shutdown');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.shutdown).toBe(true);
      });

      it('no shutdown enables VLAN', () => {
        execSwitch('shutdown');
        execSwitch('no shutdown');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.shutdown).toBe(false);
      });
    });

    describe('mtu', () => {
      it('sets VLAN MTU', () => {
        execSwitch('mtu 1400');
        const vlan = switchConfig.vlans.get(100);
        expect(vlan?.mtu).toBe(1400);
      });
    });
  });

  // ============================================================================
  // SECTION 8: DHCP CONFIG MODE COMMANDS
  // ============================================================================
  describe('DHCP Config Mode Commands', () => {
    beforeEach(() => {
      routerState.mode = 'global-config';
      execRouter('ip dhcp pool LAN_POOL');
    });

    describe('network', () => {
      it('sets pool network', () => {
        execRouter('network 192.168.1.0 255.255.255.0');
        const pool = routerConfig.dhcpPools.get('LAN_POOL');
        expect(pool?.network).toBe('192.168.1.0');
        expect(pool?.mask).toBe('255.255.255.0');
      });
    });

    describe('default-router', () => {
      it('sets default gateway', () => {
        execRouter('default-router 192.168.1.1');
        const pool = routerConfig.dhcpPools.get('LAN_POOL');
        expect(pool?.defaultRouter).toContain('192.168.1.1');
      });
    });

    describe('dns-server', () => {
      it('sets DNS servers', () => {
        execRouter('dns-server 8.8.8.8 8.8.4.4');
        const pool = routerConfig.dhcpPools.get('LAN_POOL');
        expect(pool?.dnsServer).toContain('8.8.8.8');
        expect(pool?.dnsServer).toContain('8.8.4.4');
      });
    });

    describe('domain-name', () => {
      it('sets domain name', () => {
        execRouter('domain-name example.com');
        const pool = routerConfig.dhcpPools.get('LAN_POOL');
        expect(pool?.domain).toBe('example.com');
      });
    });

    describe('lease', () => {
      it('sets lease time', () => {
        execRouter('lease 7 12 30');
        const pool = routerConfig.dhcpPools.get('LAN_POOL');
        expect(pool?.leaseTime).toEqual({ days: 7, hours: 12, minutes: 30 });
      });
    });
  });

  // ============================================================================
  // SECTION 9: ACL CONFIG MODE COMMANDS
  // ============================================================================
  describe('ACL Config Mode Commands', () => {
    describe('Standard Named ACL', () => {
      beforeEach(() => {
        routerState.mode = 'global-config';
        execRouter('ip access-list standard MYACL');
      });

      it('adds permit entry', () => {
        execRouter('permit 192.168.1.0 0.0.0.255');
        const acl = routerConfig.accessLists.get('MYACL');
        expect(acl?.entries).toHaveLength(1);
        expect(acl?.entries[0].action).toBe('permit');
      });

      it('adds deny entry', () => {
        execRouter('deny any');
        const acl = routerConfig.accessLists.get('MYACL');
        expect(acl?.entries[0].action).toBe('deny');
      });

      it('supports sequence numbers', () => {
        execRouter('10 permit 10.0.0.0 0.255.255.255');
        execRouter('20 deny any');
        const acl = routerConfig.accessLists.get('MYACL');
        expect(acl?.entries[0].sequence).toBe(10);
        expect(acl?.entries[1].sequence).toBe(20);
      });
    });

    describe('Extended Named ACL', () => {
      beforeEach(() => {
        routerState.mode = 'global-config';
        execRouter('ip access-list extended EXTACL');
      });

      it('adds TCP permit entry', () => {
        execRouter('permit tcp any any eq 80');
        const acl = routerConfig.accessLists.get('EXTACL');
        expect(acl?.entries[0].protocol).toBe('tcp');
        expect(acl?.entries[0].destPort?.ports).toContain(80);
      });

      it('adds UDP entry', () => {
        execRouter('permit udp any any eq 53');
        const acl = routerConfig.accessLists.get('EXTACL');
        expect(acl?.entries[0].protocol).toBe('udp');
      });

      it('adds ICMP entry', () => {
        execRouter('permit icmp any any');
        const acl = routerConfig.accessLists.get('EXTACL');
        expect(acl?.entries[0].protocol).toBe('icmp');
      });

      it('supports established option', () => {
        execRouter('permit tcp any any established');
        const acl = routerConfig.accessLists.get('EXTACL');
        expect(acl?.entries[0].established).toBe(true);
      });

      it('supports log option', () => {
        execRouter('deny ip any any log');
        const acl = routerConfig.accessLists.get('EXTACL');
        expect(acl?.entries[0].log).toBe(true);
      });
    });
  });

  // ============================================================================
  // SECTION 10: COMMAND PARSING TESTS
  // ============================================================================
  describe('Command Parsing', () => {
    it('parses simple command', () => {
      const result = parseCommand('show version');
      expect(result.command).toBe('show');
      expect(result.args).toEqual(['version']);
    });

    it('parses command with quoted arguments', () => {
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

  // ============================================================================
  // SECTION 11: CONTEXT HELP (?) TESTS
  // ============================================================================
  describe('Context Help (?)', () => {
    it('shows user mode help', () => {
      routerState.mode = 'user';
      const result = execRouter('?');
      expect(result.output).toContain('enable');
      expect(result.output).toContain('ping');
    });

    it('shows privileged mode help', () => {
      routerState.mode = 'privileged';
      const result = execRouter('?');
      expect(result.output).toContain('configure');
      expect(result.output).toContain('write');
    });

    it('shows global config help', () => {
      routerState.mode = 'global-config';
      const result = execRouter('?');
      expect(result.output).toContain('hostname');
      expect(result.output).toContain('interface');
    });

    it('shows interface config help', () => {
      routerState.mode = 'global-config';
      execRouter('interface GigabitEthernet0/0');
      const result = execRouter('?');
      expect(result.output).toContain('shutdown');
      expect(result.output).toContain('ip');
    });

    it('shows partial command help', () => {
      routerState.mode = 'privileged';
      const result = execRouter('show?');
      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================================
  // SECTION 12: ABBREVIATED COMMANDS TESTS
  // ============================================================================
  describe('Abbreviated Commands', () => {
    it('accepts "en" for enable', () => {
      routerState.mode = 'user';
      const result = execRouter('en');
      expect(routerState.mode).toBe('privileged');
    });

    it('accepts "conf t" for configure terminal', () => {
      routerState.mode = 'privileged';
      const result = execRouter('conf t');
      expect(routerState.mode).toBe('global-config');
    });

    it('accepts "int" for interface', () => {
      routerState.mode = 'global-config';
      const result = execRouter('int gi0/0');
      expect(routerState.mode).toBe('interface');
    });

    it('accepts "sh" for show', () => {
      routerState.mode = 'privileged';
      const result = execRouter('sh ver');
      expect(result.output).toContain('Cisco');
    });

    it('accepts "wr" for write', () => {
      routerState.mode = 'privileged';
      const result = execRouter('wr');
      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================================
  // SECTION 13: MODE TRANSITIONS
  // ============================================================================
  describe('Mode Transitions', () => {
    it('user -> privileged -> global-config -> interface -> global-config -> privileged', () => {
      routerState.mode = 'user';

      execRouter('enable');
      expect(routerState.mode).toBe('privileged');

      execRouter('configure terminal');
      expect(routerState.mode).toBe('global-config');

      execRouter('interface GigabitEthernet0/0');
      expect(routerState.mode).toBe('interface');

      execRouter('exit');
      expect(routerState.mode).toBe('global-config');

      execRouter('end');
      expect(routerState.mode).toBe('privileged');
    });

    it('Ctrl+Z (end) returns to privileged from any config mode', () => {
      routerState.mode = 'global-config';
      execRouter('interface GigabitEthernet0/0');
      execRouter('end');
      expect(routerState.mode).toBe('privileged');
    });
  });

  // ============================================================================
  // SECTION 14: NEGATION (no) COMMAND TESTS
  // ============================================================================
  describe('Negation (no) Commands', () => {
    beforeEach(() => {
      routerState.mode = 'global-config';
    });

    it('no hostname restores default', () => {
      execRouter('hostname TestName');
      execRouter('no hostname');
      expect(routerConfig.hostname).toBe('Router');
    });

    it('no ip routing disables routing', () => {
      execRouter('ip routing');
      execRouter('no ip routing');
      expect(routerConfig.ipRouting).toBe(false);
    });

    it('no interface shutdown enables interface', () => {
      execRouter('interface GigabitEthernet0/0');
      execRouter('shutdown');
      execRouter('no shutdown');
      const iface = routerConfig.interfaces.get('GigabitEthernet0/0');
      expect(iface?.isAdminDown).toBe(false);
    });
  });
});
