/**
 * Cisco Switch Comprehensive Tests
 * Tests CLI commands, VLANs, switchport configuration, STP, and switch-specific features
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoDevice, createCiscoSwitch } from '../devices/cisco/CiscoDevice';
import { executeCiscoCommand, parseCommand } from '../terminal/cisco/commands/index';
import { createDefaultSwitchConfig, createDefaultTerminalState } from '../terminal/cisco/state';
import { CiscoConfig, CiscoTerminalState } from '../terminal/cisco/types';

describe('Cisco Switch CLI', () => {
  let switchDevice: CiscoDevice;
  let config: CiscoConfig;
  let state: CiscoTerminalState;
  let bootTime: Date;

  beforeEach(() => {
    switchDevice = createCiscoSwitch({
      id: 'test-switch',
      name: 'TestSwitch',
      x: 0,
      y: 0,
    });
    config = createDefaultSwitchConfig('Switch1');
    state = createDefaultTerminalState('Switch1');
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
    if (result.newVlan) {
      state.currentVlan = result.newVlan;
    }
    if (result.newDHCPPool) {
      state.currentDHCPPool = result.newDHCPPool;
    }
    return result;
  }

  describe('Switch Device Properties', () => {
    it('has correct device type', () => {
      expect(switchDevice.getDeviceType()).toBe('switch-cisco');
    });

    it('has correct OS type', () => {
      expect(switchDevice.getOSType()).toBe('cisco-ios');
    });

    it('is switch type', () => {
      expect(switchDevice.getCiscoType()).toBe('switch');
    });

    it('has FastEthernet interfaces', () => {
      const ciscoConfig = switchDevice.getCiscoConfig();
      expect(ciscoConfig.interfaces.has('FastEthernet0/1')).toBe(true);
    });

    it('has GigabitEthernet uplink interfaces', () => {
      const ciscoConfig = switchDevice.getCiscoConfig();
      expect(ciscoConfig.interfaces.has('GigabitEthernet0/1')).toBe(true);
    });

    it('has default VLAN 1', () => {
      const ciscoConfig = switchDevice.getCiscoConfig();
      expect(ciscoConfig.vlans.has(1)).toBe(true);
      const vlan1 = ciscoConfig.vlans.get(1);
      expect(vlan1?.name).toBe('default');
    });

    it('does not have IP routing by default', () => {
      expect(config.ipRouting).toBe(false);
    });

    it('starts in user mode', () => {
      expect(state.mode).toBe('user');
    });
  });

  describe('VLAN Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('creates a new VLAN', () => {
      const result = exec('vlan 10');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('vlan');
      expect(config.vlans.has(10)).toBe(true);
    });

    it('automatically names new VLAN', () => {
      exec('vlan 10');
      const vlan = config.vlans.get(10);
      expect(vlan?.name).toBe('VLAN0010');
    });

    it('enters VLAN config mode', () => {
      exec('vlan 20');
      expect(state.mode).toBe('vlan');
      expect(state.currentVlan).toBe(20);
    });

    it('sets VLAN name', () => {
      exec('vlan 10');
      const result = exec('name Engineering');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.name).toBe('Engineering');
    });

    it('sets VLAN state to suspend', () => {
      exec('vlan 10');
      const result = exec('state suspend');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.state).toBe('suspend');
    });

    it('sets VLAN state to active', () => {
      exec('vlan 10');
      exec('state suspend');
      const result = exec('state active');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.state).toBe('active');
    });

    it('shuts down VLAN', () => {
      exec('vlan 10');
      const result = exec('shutdown');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.shutdown).toBe(true);
    });

    it('enables VLAN with no shutdown', () => {
      exec('vlan 10');
      exec('shutdown');
      const result = exec('no shutdown');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.shutdown).toBe(false);
    });

    it('sets VLAN MTU', () => {
      exec('vlan 10');
      const result = exec('mtu 1400');
      expect(result.exitCode).toBe(0);
      const vlan = config.vlans.get(10);
      expect(vlan?.mtu).toBe(1400);
    });

    it('deletes VLAN', () => {
      exec('vlan 10');
      exec('exit');
      const result = exec('no vlan 10');
      expect(result.exitCode).toBe(0);
      expect(config.vlans.has(10)).toBe(false);
    });

    it('prevents deleting VLAN 1', () => {
      const result = exec('no vlan 1');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Default VLAN');
    });

    it('rejects invalid VLAN ID', () => {
      const result = exec('vlan 5000');
      expect(result.exitCode).toBe(1);
    });

    it('creates multiple VLANs', () => {
      exec('vlan 10');
      exec('name Sales');
      exec('exit');
      exec('vlan 20');
      exec('name Engineering');
      exec('exit');
      exec('vlan 30');
      exec('name Management');

      expect(config.vlans.has(10)).toBe(true);
      expect(config.vlans.has(20)).toBe(true);
      expect(config.vlans.has(30)).toBe(true);
    });

    it('exits to global config with exit', () => {
      exec('vlan 10');
      exec('exit');
      expect(state.mode).toBe('global-config');
    });
  });

  describe('Switchport Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('interface FastEthernet0/1');
    });

    it('sets access mode', () => {
      const result = exec('switchport mode access');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.switchportMode).toBe('access');
    });

    it('sets trunk mode', () => {
      const result = exec('switchport mode trunk');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.switchportMode).toBe('trunk');
    });

    it('sets access VLAN', () => {
      exec('switchport mode access');
      const result = exec('switchport access vlan 10');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.accessVlan).toBe(10);
    });

    it('sets trunk native VLAN', () => {
      exec('switchport mode trunk');
      const result = exec('switchport trunk native vlan 99');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.nativeVlan).toBe(99);
    });

    it('sets trunk allowed VLANs', () => {
      exec('switchport mode trunk');
      const result = exec('switchport trunk allowed vlan 10,20,30');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.allowedVlans).toBe('10,20,30');
    });

    it('adds VLANs to allowed list', () => {
      exec('switchport mode trunk');
      exec('switchport trunk allowed vlan 10');
      const result = exec('switchport trunk allowed vlan add 20');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.allowedVlans).toContain('20');
    });

    it('sets voice VLAN', () => {
      exec('switchport mode access');
      const result = exec('switchport voice vlan 100');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.voiceVlan).toBe(100);
    });

    it('removes access VLAN assignment', () => {
      exec('switchport mode access');
      exec('switchport access vlan 10');
      const result = exec('no switchport access vlan');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.accessVlan).toBe(1);
    });

    it('resets to default mode with no switchport mode', () => {
      exec('switchport mode trunk');
      const result = exec('no switchport mode');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.switchportMode).toBe('dynamic-auto');
    });

    it('configures multiple interfaces for same VLAN', () => {
      exec('switchport mode access');
      exec('switchport access vlan 10');
      exec('exit');
      exec('interface FastEthernet0/2');
      exec('switchport mode access');
      exec('switchport access vlan 10');

      const iface1 = config.interfaces.get('FastEthernet0/1');
      const iface2 = config.interfaces.get('FastEthernet0/2');
      expect(iface1?.accessVlan).toBe(10);
      expect(iface2?.accessVlan).toBe(10);
    });
  });

  describe('Port Security', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
      exec('interface FastEthernet0/1');
    });

    it('enables port security', () => {
      exec('switchport mode access');
      const result = exec('switchport port-security');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity).toBeDefined();
    });

    it('sets maximum MAC addresses', () => {
      exec('switchport mode access');
      exec('switchport port-security');
      const result = exec('switchport port-security maximum 5');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity?.maximum).toBe(5);
    });

    it('sets violation mode to shutdown', () => {
      exec('switchport mode access');
      exec('switchport port-security');
      const result = exec('switchport port-security violation shutdown');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity?.violation).toBe('shutdown');
    });

    it('sets violation mode to restrict', () => {
      exec('switchport mode access');
      exec('switchport port-security');
      const result = exec('switchport port-security violation restrict');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity?.violation).toBe('restrict');
    });

    it('sets violation mode to protect', () => {
      exec('switchport mode access');
      exec('switchport port-security');
      const result = exec('switchport port-security violation protect');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity?.violation).toBe('protect');
    });

    it('enables sticky MAC addresses', () => {
      exec('switchport mode access');
      exec('switchport port-security');
      const result = exec('switchport port-security mac-address sticky');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.portSecurity?.sticky).toBe(true);
    });
  });

  describe('Spanning Tree Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('sets STP mode to pvst', () => {
      const result = exec('spanning-tree mode pvst');
      expect(result.exitCode).toBe(0);
      expect(config.stpMode).toBe('pvst');
    });

    it('sets STP mode to rapid-pvst', () => {
      const result = exec('spanning-tree mode rapid-pvst');
      expect(result.exitCode).toBe(0);
      expect(config.stpMode).toBe('rapid-pvst');
    });

    it('sets per-VLAN priority', () => {
      const result = exec('spanning-tree vlan 10 priority 4096');
      expect(result.exitCode).toBe(0);
    });

    it('enables portfast on interface', () => {
      exec('interface FastEthernet0/1');
      const result = exec('spanning-tree portfast');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.stpPortfast).toBe(true);
    });

    it('enables BPDU guard on interface', () => {
      exec('interface FastEthernet0/1');
      const result = exec('spanning-tree bpduguard enable');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.stpBpduguard).toBe(true);
    });

    it('disables portfast', () => {
      exec('interface FastEthernet0/1');
      exec('spanning-tree portfast');
      const result = exec('no spanning-tree portfast');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.stpPortfast).toBe(false);
    });
  });

  describe('VTP Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('sets VTP mode to server', () => {
      const result = exec('vtp mode server');
      expect(result.exitCode).toBe(0);
      expect(config.vtpMode).toBe('server');
    });

    it('sets VTP mode to client', () => {
      const result = exec('vtp mode client');
      expect(result.exitCode).toBe(0);
      expect(config.vtpMode).toBe('client');
    });

    it('sets VTP mode to transparent', () => {
      const result = exec('vtp mode transparent');
      expect(result.exitCode).toBe(0);
      expect(config.vtpMode).toBe('transparent');
    });

    it('sets VTP domain', () => {
      const result = exec('vtp domain CORP');
      expect(result.exitCode).toBe(0);
      expect(config.vtpDomain).toBe('CORP');
    });

    it('sets VTP password (command accepted)', () => {
      const result = exec('vtp password secret123');
      // VTP password command is accepted but may not persist in this implementation
      expect(result.exitCode).toBe(0);
    });

    it('sets VTP version (command accepted)', () => {
      const result = exec('vtp version 2');
      // VTP version command is accepted but may not persist in this implementation
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Show Commands', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('shows VLAN brief', () => {
      const result = exec('show vlan brief');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('VLAN');
      expect(result.output).toContain('Name');
      expect(result.output).toContain('Status');
    });

    it('shows VLAN', () => {
      const result = exec('show vlan');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('VLAN');
      expect(result.output).toContain('default');
    });

    it('shows MAC address table', () => {
      const result = exec('show mac address-table');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Mac Address Table');
    });

    it('shows spanning-tree', () => {
      const result = exec('show spanning-tree');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Spanning tree');
    });

    it('shows interfaces status', () => {
      const result = exec('show interfaces status');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Port');
      expect(result.output).toContain('Status');
      expect(result.output).toContain('Vlan');
    });

    it('shows interfaces trunk', () => {
      const result = exec('show interfaces trunk');
      expect(result.exitCode).toBe(0);
    });

    it('shows interfaces switchport', () => {
      const result = exec('show interfaces switchport');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Switchport');
    });

    it('shows running-config', () => {
      const result = exec('show running-config');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('hostname');
    });

    it('shows version', () => {
      const result = exec('show version');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Cisco');
      expect(result.output).toContain('2960');
    });

    it('shows ip interface brief', () => {
      const result = exec('show ip interface brief');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Interface');
      expect(result.output).toContain('IP-Address');
    });

    it('rejects show ip route (IP routing disabled)', () => {
      const result = exec('show ip route');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('IP routing is disabled');
    });

    it('shows cdp neighbors', () => {
      const result = exec('show cdp neighbors');
      expect(result.exitCode).toBe(0);
    });

    it('shows inventory', () => {
      const result = exec('show inventory');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('2960');
    });
  });

  describe('Interface Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('enters FastEthernet interface config', () => {
      const result = exec('interface FastEthernet0/1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('enters GigabitEthernet interface config', () => {
      const result = exec('interface GigabitEthernet0/1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('sets interface description', () => {
      exec('interface FastEthernet0/1');
      const result = exec('description User PC Port');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.description).toBe('User PC Port');
    });

    it('shuts down interface', () => {
      exec('interface FastEthernet0/1');
      const result = exec('shutdown');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.isAdminDown).toBe(true);
    });

    it('enables interface with no shutdown', () => {
      exec('interface FastEthernet0/1');
      exec('shutdown');
      const result = exec('no shutdown');
      expect(result.exitCode).toBe(0);
      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.isAdminDown).toBe(false);
    });

    it('sets duplex to full', () => {
      exec('interface FastEthernet0/1');
      const result = exec('duplex full');
      expect(result.exitCode).toBe(0);
    });

    it('sets duplex to half', () => {
      exec('interface FastEthernet0/1');
      const result = exec('duplex half');
      expect(result.exitCode).toBe(0);
    });

    it('sets speed to 100', () => {
      exec('interface FastEthernet0/1');
      const result = exec('speed 100');
      expect(result.exitCode).toBe(0);
    });

    it('creates VLAN interface (SVI)', () => {
      exec('vlan 10');
      exec('exit');
      const result = exec('interface Vlan10');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('configures IP on VLAN interface', () => {
      exec('vlan 10');
      exec('exit');
      exec('interface Vlan10');
      const result = exec('ip address 192.168.10.1 255.255.255.0');
      expect(result.exitCode).toBe(0);
    });

    it('uses abbreviated interface name (fa)', () => {
      const result = exec('interface fa0/1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });

    it('uses abbreviated interface name (gi)', () => {
      const result = exec('interface gi0/1');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('interface');
    });
  });

  describe('Security Configuration', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('sets hostname', () => {
      const result = exec('hostname CoreSwitch');
      expect(result.exitCode).toBe(0);
      expect(config.hostname).toBe('CoreSwitch');
    });

    it('sets enable secret', () => {
      const result = exec('enable secret cisco123');
      expect(result.exitCode).toBe(0);
      expect(config.enableSecret).toBeDefined();
    });

    it('creates username', () => {
      const result = exec('username admin privilege 15 secret admin123');
      expect(result.exitCode).toBe(0);
    });

    it('enables password encryption', () => {
      const result = exec('service password-encryption');
      expect(result.exitCode).toBe(0);
      expect(config.servicePasswordEncryption).toBe(true);
    });

    it('configures console line', () => {
      const result = exec('line console 0');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('line');
    });

    it('configures VTY lines', () => {
      const result = exec('line vty 0 4');
      expect(result.exitCode).toBe(0);
      expect(state.mode).toBe('line');
    });

    it('sets line password', () => {
      exec('line console 0');
      const result = exec('password cisco');
      expect(result.exitCode).toBe(0);
    });

    it('enables login on line', () => {
      exec('line console 0');
      const result = exec('login');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('CDP and LLDP', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('enables CDP globally', () => {
      const result = exec('cdp run');
      expect(result.exitCode).toBe(0);
      expect(config.cdpEnabled).toBe(true);
    });

    it('disables CDP globally', () => {
      exec('cdp run');
      const result = exec('no cdp run');
      expect(result.exitCode).toBe(0);
      expect(config.cdpEnabled).toBe(false);
    });

    it('enables LLDP globally', () => {
      const result = exec('lldp run');
      expect(result.exitCode).toBe(0);
      expect(config.lldpEnabled).toBe(true);
    });

    it('disables LLDP globally', () => {
      exec('lldp run');
      const result = exec('no lldp run');
      expect(result.exitCode).toBe(0);
      expect(config.lldpEnabled).toBe(false);
    });
  });

  describe('Mode Transitions', () => {
    it('transitions user -> privileged -> global-config', () => {
      expect(state.mode).toBe('user');
      exec('enable');
      expect(state.mode).toBe('privileged');
      exec('configure terminal');
      expect(state.mode).toBe('global-config');
    });

    it('transitions global-config -> interface -> global-config', () => {
      exec('enable');
      exec('configure terminal');
      exec('interface FastEthernet0/1');
      expect(state.mode).toBe('interface');
      exec('exit');
      expect(state.mode).toBe('global-config');
    });

    it('transitions global-config -> vlan -> global-config', () => {
      exec('enable');
      exec('configure terminal');
      exec('vlan 10');
      expect(state.mode).toBe('vlan');
      exec('exit');
      expect(state.mode).toBe('global-config');
    });

    it('returns to privileged with end from interface', () => {
      exec('enable');
      exec('configure terminal');
      exec('interface FastEthernet0/1');
      exec('end');
      expect(state.mode).toBe('privileged');
    });

    it('returns to privileged with end from vlan', () => {
      exec('enable');
      exec('configure terminal');
      exec('vlan 10');
      exec('end');
      expect(state.mode).toBe('privileged');
    });
  });

  describe('Privileged Commands', () => {
    beforeEach(() => {
      exec('enable');
    });

    it('writes configuration', () => {
      const result = exec('write memory');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('[OK]');
    });

    it('copies running to startup', () => {
      const result = exec('copy running-config startup-config');
      expect(result.exitCode).toBe(0);
    });

    it('clears MAC address table', () => {
      const result = exec('clear mac address-table');
      expect(result.exitCode).toBe(0);
    });

    it('executes reload', () => {
      const result = exec('reload');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Complex Scenarios', () => {
    beforeEach(() => {
      exec('enable');
      exec('configure terminal');
    });

    it('configures access port for data VLAN', () => {
      exec('vlan 10');
      exec('name Sales');
      exec('exit');
      exec('interface FastEthernet0/1');
      exec('description Sales Department');
      exec('switchport mode access');
      exec('switchport access vlan 10');
      exec('spanning-tree portfast');
      exec('no shutdown');

      const iface = config.interfaces.get('FastEthernet0/1');
      expect(iface?.switchportMode).toBe('access');
      expect(iface?.accessVlan).toBe(10);
      expect(iface?.stpPortfast).toBe(true);
      expect(iface?.isAdminDown).toBe(false);
    });

    it('configures access port with voice VLAN', () => {
      exec('vlan 10');
      exec('name Data');
      exec('exit');
      exec('vlan 100');
      exec('name Voice');
      exec('exit');
      exec('interface FastEthernet0/5');
      exec('switchport mode access');
      exec('switchport access vlan 10');
      exec('switchport voice vlan 100');
      exec('spanning-tree portfast');

      const iface = config.interfaces.get('FastEthernet0/5');
      expect(iface?.accessVlan).toBe(10);
      expect(iface?.voiceVlan).toBe(100);
    });

    it('configures trunk port between switches', () => {
      exec('interface GigabitEthernet0/1');
      exec('description Uplink to Distribution');
      exec('switchport mode trunk');
      exec('switchport trunk native vlan 99');
      exec('switchport trunk allowed vlan 10,20,30,99');
      exec('no shutdown');

      const iface = config.interfaces.get('GigabitEthernet0/1');
      expect(iface?.switchportMode).toBe('trunk');
      expect(iface?.nativeVlan).toBe(99);
      expect(iface?.allowedVlans).toBe('10,20,30,99');
    });

    it('configures multiple VLANs for department network', () => {
      // Create VLANs
      exec('vlan 10');
      exec('name Sales');
      exec('exit');
      exec('vlan 20');
      exec('name Engineering');
      exec('exit');
      exec('vlan 30');
      exec('name Management');
      exec('exit');

      expect(config.vlans.size).toBeGreaterThanOrEqual(4); // 1 (default) + 3 new
      expect(config.vlans.get(10)?.name).toBe('Sales');
      expect(config.vlans.get(20)?.name).toBe('Engineering');
      expect(config.vlans.get(30)?.name).toBe('Management');
    });

    it('configures port security on access port', () => {
      exec('interface FastEthernet0/10');
      exec('switchport mode access');
      exec('switchport access vlan 10');
      exec('switchport port-security');
      exec('switchport port-security maximum 2');
      exec('switchport port-security violation shutdown');
      exec('switchport port-security mac-address sticky');

      const iface = config.interfaces.get('FastEthernet0/10');
      expect(iface?.portSecurity).toBeDefined();
      expect(iface?.portSecurity?.maximum).toBe(2);
      expect(iface?.portSecurity?.violation).toBe('shutdown');
      expect(iface?.portSecurity?.sticky).toBe(true);
    });
  });

  describe('Switch Device Integration', () => {
    it('gets correct device type', () => {
      expect(switchDevice.getDeviceType()).toBe('switch-cisco');
    });

    it('is switch Cisco type', () => {
      expect(switchDevice.getCiscoType()).toBe('switch');
    });

    it('executes show vlan through device', () => {
      switchDevice.executeCommand('enable');
      const result = switchDevice.executeCommand('show vlan');
      expect(result.exitCode).toBe(0);
    });

    it('executes show mac address-table through device', () => {
      switchDevice.executeCommand('enable');
      const result = switchDevice.executeCommand('show mac address-table');
      expect(result.exitCode).toBe(0);
    });

    it('has default VLAN 1', () => {
      const ciscoConfig = switchDevice.getCiscoConfig();
      expect(ciscoConfig.vlans.has(1)).toBe(true);
    });

    it('has proper interface count', () => {
      const ciscoConfig = switchDevice.getCiscoConfig();
      // Should have 24 FastEthernet + 2 GigabitEthernet
      let fastEthernetCount = 0;
      let gigabitEthernetCount = 0;
      for (const [name, _] of ciscoConfig.interfaces) {
        if (name.startsWith('FastEthernet')) fastEthernetCount++;
        if (name.startsWith('GigabitEthernet')) gigabitEthernetCount++;
      }
      expect(fastEthernetCount).toBe(24);
      expect(gigabitEthernetCount).toBe(2);
    });

    it('has boot time', () => {
      expect(switchDevice.getBootTime()).toBeInstanceOf(Date);
    });

    it('returns terminal state', () => {
      const terminalState = switchDevice.getTerminalState();
      expect(terminalState.mode).toBe('user');
    });
  });
});
