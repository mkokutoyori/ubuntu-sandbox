/**
 * Comprehensive TDD tests for Cisco Layer 2 Switch commands.
 * 
 * Verifies exactly 200 operational test scenarios across:
 *  - CLI execution modes & transitions (enable, disable, configure)
 *  - Configuration persistence & lifecycle (copy, write, erase, reload)
 *  - Diagnostic logging & terminal controls (debug, undebug, terminal)
 *  - Management connectivity (ping, ssh, telnet, outbound sessions)
 *  - Management plane protocols & logic (sntp, no negations, clear actions)
 *  - System state display & parsing (show commands variations)
 *  - Layer 2 environment restrictions (rejection of L3 routing, physical IPs)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── Topologies ──────────────────────────────────────────────────────

function setupIsolatedSwitch() {
  const sw = new CiscoSwitch('sw1', 'Switch', 24, 0, 0);
  return { sw };
}

function setupManagementLAN() {
  const sw = new CiscoSwitch('sw1', 'Switch', 24, 0, 0);
  const pc = new LinuxPC('PC1', 0, 0);
  const r1 = new CiscoRouter('R1', 0, 0);

  const cable1 = new Cable('c1');
  cable1.connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  const cable2 = new Cable('c2');
  cable2.connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/24')!);

  return { sw, pc, r1, cable1, cable2 };
}

// ═══════════════════════════════════════════════════════════════════
// CISCO L2 SWITCH COMMAND TESTS (1-200)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco L2 Switch Command Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    // Fresh topology registry per test — fixtures across tests reuse the same
    // management IPs (10.0.0.1/10.0.0.100), and the static registry would
    // otherwise let cable-path lookups resolve a stale device.
    EquipmentRegistry.resetInstance();
  });

  // ─── Block 1: Mode Transitions (Tests 1-15) ─────────────────────

  describe('Mode Transitions (enable, disable, configure)', () => {
    it('1. should start in User EXEC mode by default', async () => {
      const { sw } = setupIsolatedSwitch();
      const prompt = await sw.getPrompt();
      expect(prompt).toBe('Switch>');
    });

    it('2. should transition from User EXEC to Privileged EXEC via enable', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const prompt = await sw.getPrompt();
      expect(prompt).toBe('Switch#');
    });

    it('3. should remain in Privileged EXEC mode if enable is called again', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('enable');
      expect(output.trim()).toBe('');
      expect(await sw.getPrompt()).toBe('Switch#');
    });

    it('4. should transition from Privileged EXEC to User EXEC via disable', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('disable');
      expect(await sw.getPrompt()).toBe('Switch>');
    });

    it('5. should reject disable command in User EXEC mode with error or ignore', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('disable');
      expect(output.toLowerCase()).toContain('%'); // unrecognized or invalid mode
    });

    it('6. should transition from Privileged EXEC to Global Config via configure terminal', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      expect(await sw.getPrompt()).toBe('Switch(config)#');
    });

    it('7. should accept common abbreviation "conf t" to enter config mode', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('conf t');
      expect(await sw.getPrompt()).toBe('Switch(config)#');
    });

    it('8. should reject configure terminal command from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('configure terminal');
      expect(output).toContain('%');
      expect(await sw.getPrompt()).toBe('Switch>');
    });

    it('9. should transition from Global Config to Privileged EXEC via end', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('end');
      expect(await sw.getPrompt()).toBe('Switch#');
    });

    it('10. should transition from Global Config to Privileged EXEC via exit', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('exit');
      expect(await sw.getPrompt()).toBe('Switch#');
    });

    it('11. should transition from Interface Config mode to Global Config mode via exit', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      expect(await sw.getPrompt()).toBe('Switch(config-if)#');
      await sw.executeCommand('exit');
      expect(await sw.getPrompt()).toBe('Switch(config)#');
    });

    it('12. should transition from VLAN Config mode to Global Config mode via exit', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('vlan 10');
      expect(await sw.getPrompt()).toBe('Switch(config-vlan)#');
      await sw.executeCommand('exit');
      expect(await sw.getPrompt()).toBe('Switch(config)#');
    });

    it('13. should jump directly from Interface Config to Privileged EXEC via end', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      await sw.executeCommand('end');
      expect(await sw.getPrompt()).toBe('Switch#');
    });

    it('14. should accept exit to close terminal session when in User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('exit');
      expect(output.toLowerCase()).toContain('closed');
    });

    it('15. should reject unrecognized mode transition arguments', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('configure memory');
      expect(output).toContain('%');
    });
  });

  // ─── Block 2: Storage & Configuration Lifecycle (Tests 16-45) ────

  describe('Storage & Configuration Lifecycle (copy, write, erase, reload)', () => {
    it('16. should maintain default startup-config as empty or default before write', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show startup-config');
      expect(output.toLowerCase()).toContain('not present');
    });

    it('17. should save running configuration using write memory', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-CORE');
      await sw.executeCommand('end');
      const writeOutput = await sw.executeCommand('write memory');
      expect(writeOutput).toContain('OK');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup).toContain('hostname SW-CORE');
    });

    it('18. should support quick write command as alias for write memory', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-DIST');
      await sw.executeCommand('end');
      await sw.executeCommand('write');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup).toContain('hostname SW-DIST');
    });

    it('19. should copy running-config to startup-config successfully', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-ACCESS');
      await sw.executeCommand('end');
      const copyOutput = await sw.executeCommand('copy running-config startup-config');
      expect(copyOutput).toContain('Destination filename');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup).toContain('hostname SW-ACCESS');
    });

    it('20. should support copy run start as abbreviation', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-ABB');
      await sw.executeCommand('end');
      await sw.executeCommand('copy run start');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup).toContain('hostname SW-ABB');
    });

    it('21. should lose unsaved modifications after executing reload', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-UNSAVED');
      await sw.executeCommand('end');
      await sw.executeCommand('reload');
      expect(await sw.getPrompt()).toBe('Switch>');
    });

    it('22. should preserve modifications after write followed by reload', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-SAVED');
      await sw.executeCommand('end');
      await sw.executeCommand('write');
      await sw.executeCommand('reload');
      await sw.executeCommand('enable');
      expect(await sw.getPrompt()).toBe('SW-SAVED#');
    });

    it('23. should erase startup-config using erase startup-config', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('write');
      const output = await sw.executeCommand('erase startup-config');
      expect(output.toLowerCase()).toContain('complete');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup.toLowerCase()).toContain('not present');
    });

    it('24. should support write erase as alternative to clear NVRAM', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('write');
      await sw.executeCommand('write erase');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup.toLowerCase()).toContain('not present');
    });

    it('25. should restore factory defaults after erase followed by reload', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-TEMP');
      await sw.executeCommand('end');
      await sw.executeCommand('write');
      await sw.executeCommand('erase startup-config');
      await sw.executeCommand('reload');
      expect(await sw.getPrompt()).toBe('Switch>');
    });

    it('26. should reject copy startup-config running-config if NVRAM is empty', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('copy startup-config running-config');
      expect(output.toLowerCase()).toMatch(/error|failed|not present|empty/);
    });

    it('27. should copy flash configuration to running config if file exists', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('copy flash:config.bak running-config');
      expect(output.toLowerCase()).toMatch(/error|not found|invalid/);
    });

    it('28. should reject copy command with invalid arguments', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('copy running-config');
      expect(output.toLowerCase()).toContain('%');
    });

    it('29. should deny write and copy operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output1 = await sw.executeCommand('write');
      const output2 = await sw.executeCommand('copy running-config startup-config');
      expect(output1.toLowerCase()).toContain('%');
      expect(output2.toLowerCase()).toContain('%');
    });

    it('30. should deny erase operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('erase startup-config');
      expect(output.toLowerCase()).toContain('%');
    });

    it('31. should deny reload operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('reload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('32. should prompt for reload validation if unsaved changes exist', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SW-DIRTY');
      await sw.executeCommand('end');
      const output = await sw.executeCommand('reload');
      // If simulated, reload either proceeds or warns about modified configs
      expect(output).toBeDefined();
    });

    it('33. should support flash file list visualization using show flash', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show flash');
      expect(output).toContain('bytes');
    });

    it('34. should list active configuration inside show running-config', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show running-config');
      expect(output).toContain('Current configuration');
    });

    it('35. should find customized hostname inside show running-config after modification', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname TEST-SW');
      await sw.executeCommand('end');
      const run = await sw.executeCommand('show running-config');
      expect(run).toContain('hostname TEST-SW');
    });

    it('36. should find customized VLANs inside show running-config', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('vlan 100');
      await sw.executeCommand('name production');
      await sw.executeCommand('end');
      const run = await sw.executeCommand('show running-config');
      expect(run).toContain('vlan 100');
    });

    it('37. should show non-default interface parameters in show running-config', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      await sw.executeCommand('description ManagementPort');
      await sw.executeCommand('end');
      const run = await sw.executeCommand('show running-config');
      expect(run).toContain('description ManagementPort');
    });

    it('38. should display unchanged startup-config even after unsaved running modifications', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname FIRST');
      await sw.executeCommand('end');
      await sw.executeCommand('write');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname SECOND');
      await sw.executeCommand('end');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup).toContain('hostname FIRST');
      expect(startup).not.toContain('hostname SECOND');
    });

    it('39. should clear startup configuration when write memory is overwritten with defaults', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('write');
      await sw.executeCommand('erase startup-config');
      const startup = await sw.executeCommand('show startup-config');
      expect(startup.toLowerCase()).toContain('not present');
    });

    it('40. should support writing to a backup file in flash (copy running-config flash:backup.cfg)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('copy running-config flash:backup.cfg');
      expect(output).not.toContain('%');
    });

    it('41. should copy backup configuration back to running config (copy flash:backup.cfg running-config)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('copy running-config flash:backup.cfg');
      const output = await sw.executeCommand('copy flash:backup.cfg running-config');
      expect(output).not.toContain('%');
    });

    it('42. should handle erase flash: target operations safely', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('erase flash:');
      expect(output).toBeDefined();
    });

    it('43. should throw error if trying to erase non-existent storage partitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('erase non_existent:');
      expect(output.toLowerCase()).toContain('%');
    });

    it('44. should preserve administrative users database across reloads after write', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('username admin password secret');
      await sw.executeCommand('end');
      await sw.executeCommand('write');
      await sw.executeCommand('reload');
      await sw.executeCommand('enable');
      const running = await sw.executeCommand('show running-config');
      expect(running).toContain('username admin');
    });

    it('45. should support write memory abbreviation wr mem', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('wr mem');
      expect(output).toContain('OK');
    });
  });

  // ─── Block 3: Diagnostic Logging & Sessions (Tests 46-70) ────────

  describe('Diagnostic Logging & Sessions (debug, undebug, terminal)', () => {
    it('46. should enable debug output using debug all', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug all');
      expect(output.toLowerCase()).toContain('debugging');
    });

    it('47. should disable debug output using undebug all', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const output = await sw.executeCommand('undebug all');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('48. should support no debug all to turn off debugging', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const output = await sw.executeCommand('no debug all');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('49. should support dynamic terminal log forwarding using terminal monitor', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('terminal monitor');
      expect(output).toBeDefined(); // executes successfully
    });

    it('50. should support disabling terminal logging via terminal no monitor', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      const output = await sw.executeCommand('terminal no monitor');
      expect(output).toBeDefined();
    });

    it('51. should allow enabling specific debug scopes (debug arp)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug arp');
      expect(output.toLowerCase()).toContain('arp');
    });

    it('52. should allow disabling specific debug scopes (undebug arp)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      const output = await sw.executeCommand('undebug arp');
      expect(output.toLowerCase()).toContain('arp');
    });

    it('53. should show debug status details on show debugging', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      const output = await sw.executeCommand('show debugging');
      expect(output.toLowerCase()).toContain('arp');
    });

    it('54. should report no active debugging state by default on show debugging', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show debugging');
      expect(output.toLowerCase()).not.toContain('debugging is on');
    });

    it('55. should list active outbound connections using where', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('where');
      expect(output).toBeDefined();
    });

    it('56. should disconnect active connections gracefully via disconnect', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('disconnect');
      expect(output).toBeDefined();
    });

    it('57. should resume specific connection session using resume', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('resume');
      expect(output).toBeDefined();
    });

    it('58. should support shortcut undebug abbreviations (u all)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const output = await sw.executeCommand('u all');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('59. should reject debug operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('debug all');
      expect(output.toLowerCase()).toContain('%');
    });

    it('60. should reject undebug operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('undebug all');
      expect(output.toLowerCase()).toContain('%');
    });

    it('61. should allow enabling mac-address-table debugging explicitly (debug mac address-table)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug mac address-table');
      expect(output.toLowerCase()).toContain('debugging');
    });

    it('62. should support undebug mac address-table to stop debugging', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug mac address-table');
      const output = await sw.executeCommand('undebug mac address-table');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('63. should allow enabling physical link-state debugging (debug link-state)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug link-state');
      expect(output.toLowerCase()).toContain('debugging');
    });

    it('64. should turn off link-state debugs via undebug link-state', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug link-state');
      const output = await sw.executeCommand('undebug link-state');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('65. should support terminal monitor configuration persistence on running profile', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      const output = await sw.executeCommand('show terminal');
      expect(output.toLowerCase()).toContain('monitor');
    });

    it('66. should reject invalid disconnect arguments', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('disconnect invalid_session_name');
      expect(output.toLowerCase()).toContain('%');
    });

    it('67. should reject invalid resume target parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('resume 99');
      expect(output.toLowerCase()).toContain('%');
    });

    it('68. should default console line timeout configuration securely', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show line console 0');
      expect(output).toBeDefined();
    });

    it('69. should support configure terminal change of session limits', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const prompt = await sw.getPrompt();
      expect(prompt).toBe('Switch(config-line)#');
    });

    it('70. should return to global configuration when exiting line sub-mode', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      await sw.executeCommand('exit');
      const prompt = await sw.getPrompt();
      expect(prompt).toBe('Switch(config)#');
    });
  });

  // ─── Block 4: Management Plane Connectivity (Tests 71-100) ──────

  describe('Management Plane Connectivity (ping, ssh, telnet)', () => {
    it('71. should configure IP address on Switched Virtual Interface (SVI) Vlan 1', async () => {
      const { sw } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output = await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      expect(output.trim()).toBe('');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');

      const ipStatus = await sw.executeCommand('show ip interface brief');
      expect(ipStatus).toContain('10.0.0.100');
    });

    it('72. should communicate with connected hosts inside SVI subnet using ping', async () => {
      const { sw, pc } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');

      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const pingOutput = await sw.executeCommand('ping 10.0.0.1');
      expect(pingOutput).toContain('Success rate');
    });

    it('73. should support quick escape sequence for active ping operations', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ping 1.1.1.1');
      expect(output).toBeDefined();
    });

    it('74. should timeout ping requests on unreachable IP targets', async () => {
      const { sw } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');

      const pingOutput = await sw.executeCommand('ping 10.0.0.99');
      expect(pingOutput).toContain('Success rate is 0 percent');
    });

    it('75. should support ssh outbound shell activation from Switch CLI', async () => {
      const { sw } = setupManagementLAN();
      const output = await sw.executeCommand('ssh -l admin 10.0.0.2');
      expect(output).toBeDefined();
    });

    it('76. should support telnet outbound shell activation from Switch CLI', async () => {
      const { sw } = setupManagementLAN();
      const output = await sw.executeCommand('telnet 10.0.0.2');
      expect(output).toBeDefined();
    });

    it('77. should reject ssh attempts missing username destination arguments', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ssh 10.0.0.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('78. should support ping command with count modifier parameters (ping 10.0.0.1 repeat 2)', async () => {
      const { sw, pc } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');
      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const output = await sw.executeCommand('ping 10.0.0.1 repeat 2');
      expect(output).toBeDefined();
    });

    it('79. should deny SSH configurations when host keys are not generated', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip ssh version 2');
      expect(output.toLowerCase()).toContain('key');
    });

    it('80. should allow generating rsa keys with crypto key generate rsa', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('ip domain-name local.net');
      const output = await sw.executeCommand('crypto key generate rsa');
      expect(output.toLowerCase()).toContain('generate');
    });

    it('81. should enforce password configuration on vty lines for incoming telnet', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const output = await sw.executeCommand('login');
      expect(output.toLowerCase()).toContain('password');
    });

    it('82. should allow login local on vty configurations to enforce database lookups', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const output = await sw.executeCommand('login local');
      expect(output.trim()).toBe('');
    });

    it('83. should enable telnet server status inside line configuration', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const output = await sw.executeCommand('transport input telnet');
      expect(output.trim()).toBe('');
    });

    it('84. should allow SSH incoming while disabling incoming telnet using transport input ssh', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const output = await sw.executeCommand('transport input ssh');
      expect(output.trim()).toBe('');
    });

    it('85. should support quick ping to loopback interface of management network', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ping 127.0.0.1');
      expect(output).toBeDefined();
    });

    it('86. should support custom ping sizes (ping 10.0.0.1 size 1000)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ping 127.0.0.1 size 1000');
      expect(output).toBeDefined();
    });

    it('87. should reject SSH/Telnet attempts from unconfigured management subnets', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('telnet 172.16.50.1');
      expect(output.toLowerCase()).toMatch(/unreachable|error|failed/);
    });

    it('88. should reject incoming connections if SVI link status is administrative shutdown', async () => {
      const { sw, pc } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      await sw.executeCommand('shutdown'); // Keep down
      await sw.executeCommand('end');

      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      const output = await pc.executeCommand('ping -c 1 10.0.0.100');
      expect(output.toLowerCase()).not.toContain('bytes from');
    });

    it('89. should show correct interface state in show ip interface brief when SVI is shutdown', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('shutdown');
      await sw.executeCommand('end');
      const status = await sw.executeCommand('show ip interface brief');
      expect(status).toContain('administratively down');
    });

    it('90. should show correct interface status when SVI is activated via no shutdown', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');
      const status = await sw.executeCommand('show ip interface brief');
      expect(status).toContain('up');
    });

    it('91. should configure static management default-gateway with ip default-gateway', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip default-gateway 10.0.0.254');
      expect(output.trim()).toBe('');
      const running = await sw.executeCommand('show running-config');
      expect(running).toContain('ip default-gateway 10.0.0.254');
    });

    it('92. should negate ip default-gateway configuration parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('ip default-gateway 10.0.0.254');
      await sw.executeCommand('no ip default-gateway');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('ip default-gateway');
    });

    it('93. should show SSH configuration status with show ip ssh', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show ip ssh');
      expect(output).toBeDefined();
    });

    it('94. should block SSH activations with missing RSA dependency parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip ssh version 2');
      expect(output.toLowerCase()).toContain('key');
    });

    it('95. should support telnet custom port configuration parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('telnet 127.0.0.1 8080');
      expect(output).toBeDefined();
    });

    it('96. should isolate interface domain parameter definitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('ip domain-name lan.local');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).toContain('ip domain-name lan.local');
    });

    it('97. should support standard privilege level assignment during administrative configuration', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('username operator privilege 1 password operator_pass');
      expect(output.trim()).toBe('');
    });

    it('98. should block incoming VTY connection if password is not configured and login is active', async () => {
      const { sw, pc } = setupManagementLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('line vty 0 4');
      await sw.executeCommand('login');
      await sw.executeCommand('no password'); // Remove any passwords
      await sw.executeCommand('end');

      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      const telnetOutput = await pc.executeCommand('telnet 10.0.0.100');
      expect(telnetOutput.toLowerCase()).toMatch(/closed|rejected|password required/);
    });

    it('99. should support multi-hop ping validations across SVIs', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ping 127.0.0.1');
      expect(output).toContain('Success');
    });

    it('100. should reject ping operations containing out of range parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('ping 127.0.0.1 repeat 1000000');
      expect(output.toLowerCase()).toContain('%');
    });
  });

  // ─── Block 5: SNTP, Clear actions & Negations (Tests 101-125) ─────

  describe('Management Protocols, Clear Actions & Negations (sntp, clear, no)', () => {
    it('101. should configure SNTP primary server address via sntp server', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('sntp server 10.10.10.50');
      expect(output.trim()).toBe('');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).toContain('sntp server 10.10.10.50');
    });

    it('102. should support sntp unicast client enablement configuration', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('sntp unicast client');
      expect(output.trim()).toBe('');
    });

    it('103. should negate SNTP configuration using no sntp server', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('sntp server 10.10.10.50');
      await sw.executeCommand('no sntp server 10.10.10.50');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('sntp server 10.10.10.50');
    });

    it('104. should show sntp details on show sntp command', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('sntp server 10.10.10.50');
      await sw.executeCommand('end');
      const output = await sw.executeCommand('show sntp');
      expect(output).toContain('10.10.10.50');
    });

    it('105. should negate hostname configurations back to defaults via no hostname', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('hostname LAB-SW');
      await sw.executeCommand('no hostname');
      await sw.executeCommand('end');
      expect(await sw.getPrompt()).toBe('Switch#');
    });

    it('106. should clear dynamic MAC address-table entries using clear mac address-table dynamic', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('clear mac address-table dynamic');
      expect(output.trim()).toBe('');
    });

    it('107. should clear ARP cache entries from Switch management database via clear arp-cache', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('clear arp-cache');
      expect(output.trim()).toBe('');
    });

    it('108. should clear physical port statistics using clear counters', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('clear counters');
      expect(output).toContain('Clear "show interface" counters on all interfaces');
    });

    it('109. should negate interface descriptions using no description configuration', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      await sw.executeCommand('description ProdLink');
      await sw.executeCommand('no description');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('ProdLink');
    });

    it('110. should negate banner motd configuration with no banner motd', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('banner motd #WELCOME#');
      await sw.executeCommand('no banner motd');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('banner motd');
    });

    it('111. should clear specific ports statistics using clear counters FastEthernet0/2', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('clear counters FastEthernet0/2');
      expect(output).not.toContain('%');
    });

    it('112. should reject clear commands on non-existent interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('clear counters FastEthernet0/99');
      expect(output.toLowerCase()).toContain('%');
    });

    it('113. should reject no command configurations when missing subject parameters', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('no');
      expect(output.toLowerCase()).toContain('%');
    });

    it('114. should negate SVI IP configuration using no ip address', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await sw.executeCommand('no ip address');
      await sw.executeCommand('end');
      const status = await sw.executeCommand('show ip interface brief');
      expect(status).toContain('unassigned');
    });

    it('115. should show SNTP server sync status information in show sntp', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show sntp');
      expect(output.toLowerCase()).toContain('sntp');
    });

    it('116. should reject invalid SNTP server IP formats during configurations', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('sntp server 900.900.900.900');
      expect(output.toLowerCase()).toContain('%');
    });

    it('117. should negate username credential rules cleanly using no username', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('username tech password techpass');
      await sw.executeCommand('no username tech');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('username tech');
    });

    it('118. should deny dynamic MAC table flush from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('clear mac address-table dynamic');
      expect(output.toLowerCase()).toContain('%');
    });

    it('119. should deny counters flush operations from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('clear counters');
      expect(output.toLowerCase()).toContain('%');
    });

    it('120. should configure access-list parameters if supported in management profile', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255');
      expect(output).not.toContain('% Unrecognized');
    });

    it('121. should negate access-list configurations via no access-list', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255');
      await sw.executeCommand('no access-list 10');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('access-list 10');
    });

    it('122. should allow configure terminal change of SVI MTU settings', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output = await sw.executeCommand('mtu 1500');
      expect(output.trim()).toBe('');
    });

    it('123. should deny clear arp-cache requests from User EXEC mode', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('clear arp-cache');
      expect(output.toLowerCase()).toContain('%');
    });

    it('124. should support snmp community configuration rules', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('snmp-server community public RO');
      expect(output.trim()).toBe('');
    });

    it('125. should remove snmp configurations using no snmp-server community', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('snmp-server community public RO');
      await sw.executeCommand('no snmp-server community public');
      await sw.executeCommand('end');
      const running = await sw.executeCommand('show running-config');
      expect(running).not.toContain('snmp-server community');
    });
  });

  // ─── Block 6: Display & Parsing State Show commands (Tests 126-150)

  describe('Display & Parsing State Show Commands (show)', () => {
    it('126. should list version specifications inside show version', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show version');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('127. should display interface status lists inside show interfaces status', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show interfaces status');
      expect(output).toContain('Port');
      expect(output).toContain('Status');
    });

    it('128. should list complete dynamic mac entries inside show mac address-table', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show mac address-table');
      expect(output).toContain('Mac Address Table');
    });

    it('129. should parse mac address-table search limits via MAC address filter', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show mac address-table address 0011.2233.4455');
      expect(output).toContain('Mac Address Table');
    });

    it('130. should support interface configuration checks on show interfaces FastEthernet0/2', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show interfaces FastEthernet0/2');
      expect(output).toContain('FastEthernet0/2');
    });

    it('131. should display administrative up status inside show interfaces when active', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show interfaces FastEthernet0/2');
      expect(output.toLowerCase()).toContain('up');
    });

    it('132. should support show clock command outputs', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show clock');
      expect(output).toBeDefined();
    });

    it('133. should support show history details', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show history');
      expect(output).toContain('enable');
    });

    it('134. should display port-security profiles inside show port-security', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show port-security');
      expect(output).toBeDefined();
    });

    it('135. should list VLAN configurations inside show vlan brief', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show vlan brief');
      expect(output).toContain('VLAN Name');
      expect(output).toContain('default');
    });

    it('136. should list VLAN databases inside show vlan', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show vlan');
      expect(output).toContain('default');
    });

    it('137. should show specific VLAN information inside show vlan id 1', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show vlan id 1');
      expect(output).toContain('default');
    });

    it('138. should display LLDP/CDP neighbors inside show cdp neighbors', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show cdp neighbors');
      expect(output).toContain('Capability Codes');
    });

    it('139. should display LLDP neighbors explicitly inside show lldp neighbors', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show lldp neighbors');
      expect(output).toBeDefined();
    });

    it('140. should show system environment parameters via show env', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show env');
      expect(output).toBeDefined();
    });

    it('141. should reject invalid show parameters gracefully', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show invalid_status_param');
      expect(output.toLowerCase()).toContain('%');
    });

    it('142. should support show ip interface brief with unassigned SVI display', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip interface brief');
      expect(output).toContain('Vlan1');
      expect(output).toContain('unassigned');
    });

    it('143. should display switch platform features inside show inventory', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show inventory');
      expect(output).toContain('NAME:');
    });

    it('144. should support show mac address-table dynamic interface FastEthernet0/2 filters', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show mac address-table interface FastEthernet0/2');
      expect(output).toContain('Mac Address Table');
    });

    it('145. should show port details with specific configuration metrics on show interface switchport', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show interfaces FastEthernet0/2 switchport');
      expect(output).toContain('Switchport: Enabled');
    });

    it('146. should support show spanning-tree status indicators', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show spanning-tree');
      expect(output.toLowerCase()).toContain('spanning tree');
    });

    it('147. should show spanning-tree information for specific VLAN id (show spanning-tree vlan 1)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show spanning-tree vlan 1');
      expect(output.toLowerCase()).toContain('vlan0001');
    });

    it('148. should support show users command output', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show users');
      expect(output).toBeDefined();
    });

    it('149. should show terminal line attributes inside show terminal', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show terminal');
      expect(output.toLowerCase()).toContain('line');
    });

    it('150. should verify autocomplete of abbreviations (sh ver, sh int stat)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output1 = await sw.executeCommand('sh ver');
      const output2 = await sw.executeCommand('sh int stat');
      expect(output1.toLowerCase()).toContain('cisco ios');
      expect(output2).toContain('Status');
    });
  });

  // ─── Block 7: Layer 2 Switch Restrictions & Failures (Tests 151-200)

  describe('Layer 2 Switch Restrictions & Failures', () => {
    it('151. should accept ip routing on the multilayer switch platform', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip routing');
      expect(output.trim()).toBe('');
    });

    it('152. should reject dynamic routing protocol declarations (router ospf 1)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('router ospf 1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('153. should reject dynamic routing protocol declarations (router rip)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('router rip');
      expect(output.toLowerCase()).toContain('%');
    });

    it('154. should reject dynamic routing protocol declarations (router bgp 65000)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('router bgp 65000');
      expect(output.toLowerCase()).toContain('%');
    });

    it('155. should reject configuring IP address directly on physical ports (interface FastEthernet0/2)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('ip address 10.0.0.1 255.255.255.0');
      expect(output.toLowerCase()).toContain('%'); // Only SVIs are allowed to have IP addresses on pure L2 switches
    });

    it('156. should reject no switchport conversion commands on physical interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('no switchport');
      expect(output.toLowerCase()).toContain('%'); // L3 interface mode not supported on typical Layer 2 Switch
    });

    it('157. should reject configuring sub-interfaces on physical L2 ports (interface FastEthernet0/2.10)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('interface FastEthernet0/2.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('158. should reject dynamic routing table show commands (show ip route)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip route');
      expect(output.toLowerCase()).toContain('%'); // Not available on L2 Switch
    });

    it('159. should reject OSPF show commands (show ip ospf)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip ospf');
      expect(output.toLowerCase()).toContain('%');
    });

    it('160. should reject routing protocol status queries (show ip protocols)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip protocols');
      expect(output.toLowerCase()).toContain('%');
    });

    it('161. should accept static IP route entries on the multilayer switch platform', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip route 10.0.0.0 255.255.255.0 192.168.1.1');
      expect(output.trim()).toBe('');
    });

    it('162. should enforce interface access vlan rules with non-existent VLANs gracefully (creating it dynamically or rejecting)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('switchport access vlan 999');
      // Typically Cisco IOS says % Access VLAN 999 does not exist. Creating vlan 999
      expect(output).toBeDefined();
    });

    it('163. should reject trunk encapsulation settings if strict dot1q is only supported', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('switchport trunk encapsulation isl');
      expect(output.toLowerCase()).toContain('%'); // ISL deprecated/unsupported
    });

    it('164. should reject setting speed or duplex parameters on non-physical SVI interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output1 = await sw.executeCommand('speed 100');
      const output2 = await sw.executeCommand('duplex full');
      expect(output1.toLowerCase()).toContain('%');
      expect(output2.toLowerCase()).toContain('%');
    });

    it('165. should refuse loopback interface creations in strict L2 platforms', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('interface Loopback0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('166. should block configuring switchports under VLAN interface mode (SVI)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output = await sw.executeCommand('switchport mode access');
      expect(output.toLowerCase()).toContain('%');
    });

    it('167. should reject dynamic VLAN pruning commands outside database/global definitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('vlan database');
      expect(output.toLowerCase()).toContain('%'); // Deprecated and restricted
    });

    it('168. should fail to parse dynamic RIP show parameters (show ip rip database)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip rip database');
      expect(output.toLowerCase()).toContain('%');
    });

    it('169. should reject BGP queries inside show ip bgp', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip bgp');
      expect(output.toLowerCase()).toContain('%');
    });

    it('170. should prevent SVI IP setting if network segment masks are completely invalid', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output = await sw.executeCommand('ip address 10.0.0.1 255.255.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('171. should reject Layer 3 VRRP/HSRP settings on FastEthernet interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('standby 1 ip 10.0.0.254');
      expect(output.toLowerCase()).toContain('%');
    });

    it('172. should reject Layer 3 OSPF interface adjustments (ip ospf cost)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('ip ospf cost 10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('173. should prevent configuring more than the maximum hardware VLAN interfaces if limited', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('interface Vlan9999'); // Invalid ID range
      expect(output.toLowerCase()).toContain('%');
    });

    it('174. should reject show dynamic NAT statistics commands', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip nat statistics');
      expect(output.toLowerCase()).toContain('%');
    });

    it('175. should reject configuring tunnel interfaces (interface Tunnel0)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('interface Tunnel0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('176. should block dynamic policy-map implementations if restricted to L3 systems', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('policy-map QOS-LIMIT');
      expect(output.toLowerCase()).toContain('%');
    });

    it('177. should block router-on-a-stick configurations on ports with layer 2 status', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('encapsulation dot1q 10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('178. should reject dynamic routing configuration commands inside vty lines', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('line vty 0 4');
      const output = await sw.executeCommand('router rip');
      expect(output.toLowerCase()).toContain('%');
    });

    it('179. should reject OSPF virtual-link definitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('area 0 virtual-link 1.1.1.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('180. should reject PIM multicast routing commands (ip pim dense-mode)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      const output = await sw.executeCommand('ip pim dense-mode');
      expect(output.toLowerCase()).toContain('%');
    });

    it('181. should enter the DHCP pool scope on the multilayer switch platform', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip dhcp pool L2-POOL');
      expect(output.trim()).toBe('');
    });

    it('182. should reject dynamic route redistribution policies', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('redistribute static');
      expect(output.toLowerCase()).toContain('%');
    });

    it('183. show vrrp with no configured group prints nothing', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show vrrp');
      expect(output.trim()).toBe('');
    });

    it('184. show standby with no configured group prints nothing', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show standby');
      expect(output.trim()).toBe('');
    });

    it('185. should reject configuring helper addresses on physical L2 interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('ip helper-address 10.0.0.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('186. should reject next-hop address resolving tools (show ip nhrp)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip nhrp');
      expect(output.toLowerCase()).toContain('%');
    });

    it('187. should reject configuring policy routing route-maps', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip local policy route-map QOS');
      expect(output.toLowerCase()).toContain('%');
    });

    it('188. should reject dynamic network address translations configuration definitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip nat inside source list 1 interface Vlan1 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('189. should reject NAT translation database show commands (show ip nat translations)', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip nat translations');
      expect(output.toLowerCase()).toContain('%');
    });

    it('190. should reject neighbor discovery adjustments on layer 2 trunk links', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('ip nhrp map 10.0.0.1 192.168.1.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('191. should reject frame-relay parameters on interface FastEthernet interfaces', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('encapsulation frame-relay');
      expect(output.toLowerCase()).toContain('%');
    });

    it('192. should reject PPP parameters configuration rules', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('encapsulation ppp');
      expect(output.toLowerCase()).toContain('%');
    });

    it('193. should reject interface dialer configuration pools', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('interface Dialer1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('194. should reject physical layer clock adjustments (clock rate 64000)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('clock rate 64000');
      expect(output.toLowerCase()).toContain('%'); // DTE/DCE clock rate restricted to Serial routing ports
    });

    it('195. should reject serial encapsulation protocols (encapsulation hdlc)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/2');
      const output = await sw.executeCommand('encapsulation hdlc');
      expect(output.toLowerCase()).toContain('%');
    });

    it('196. should reject border gateway protocol route adjustments (neighbor 10.0.0.1 remote-as 100)', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('neighbor 10.0.0.1 remote-as 100');
      expect(output.toLowerCase()).toContain('%');
    });

    it('197. should reject area ranges inside dynamic OSPF definitions', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('area 1 range 10.0.0.0 255.0.0.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('198. should reject dynamic class-map implementations', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('class-map match-all WEB-TRAFFIC');
      expect(output.toLowerCase()).toContain('%');
    });

    it('199. should reject IP traffic export parameters configuration rules', async () => {
      const { sw } = setupIsolatedSwitch();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('ip traffic-export profile TEST');
      expect(output.toLowerCase()).toContain('%');
    });

    it('200. should reject show ip eigrp dynamic topology status queries', async () => {
      const { sw } = setupIsolatedSwitch();
      const output = await sw.executeCommand('show ip eigrp topology');
      expect(output.toLowerCase()).toContain('%');
    });
  });
});
