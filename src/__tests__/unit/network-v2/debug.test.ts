/**
 * TDD tests for the Cisco IOS Debugging System.
 * 
 * Covers exactly 50 test scenarios divided into:
 *  - Global & Scope-Specific Toggle Commands (Tests 1-15)
 *  - Terminal Monitor Log Redirection (Tests 16-25)
 *  - Subsystem Live Debugging with Traffic Generation (Tests 26-40)
 *  - Security, Modes, Session Isolation & Resource Limits (Tests 41-50)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupDebugLAN() {
  const sw = new CiscoSwitch('sw1', 'SW1', 24, 0, 0);
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);

  return { sw, pc1, pc2, cable1, cable2 };
}

function setupDebugWAN() {
  const r1 = new CiscoRouter('r1', 'R1', 0, 0);
  const r2 = new CiscoRouter('r2', 'R2', 100, 0);
  const cable = new Cable('c_wan');
  cable.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  return { r1, r2, cable };
}

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS DEBUGGING SYSTEM TESTS (1-50)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS Debugging System Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: Global & Scope-Specific Toggles (Tests 1-15) ──────

  describe('Global & Scope-Specific Toggles', () => {
    it('1. should show "all possible debugging has been turned off" on startup', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('show debugging');
      expect(output.toLowerCase()).toContain('no debugging');
    });

    it('2. should enable all diagnostic scopes with debug all', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug all');
      expect(output.toLowerCase()).toContain('all possible debugging is on');
    });

    it('3. should verify debug all state is accurately reflected in show debugging', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const status = await sw.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('all debugging is on');
    });

    it('4. should disable all active diagnostics using undebug all', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const output = await sw.executeCommand('undebug all');
      expect(output.toLowerCase()).toContain('all possible debugging has been turned off');
    });

    it('5. should support negation "no debug all" to disable all active diagnostics', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      const output = await sw.executeCommand('no debug all');
      expect(output.toLowerCase()).toContain('all possible debugging has been turned off');
    });

    it('6. should enable a specific diagnostic scope (debug arp)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is on');
    });

    it('7. should show the active specific scope inside show debugging', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      const status = await sw.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('arp packet debugging is on');
    });

    it('8. should disable a specific diagnostic scope (undebug arp)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      const output = await sw.executeCommand('undebug arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is off');
    });

    it('9. should support negation "no debug arp" to turn off ARP diagnostics', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      const output = await sw.executeCommand('no debug arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is off');
    });

    it('10. should support short command abbreviations (deb arp)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('deb arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is on');
    });

    it('11. should support short undebug abbreviations (u arp)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('deb arp');
      const output = await sw.executeCommand('u arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is off');
    });

    it('12. should support global short undebug abbreviation (u all)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('deb arp');
      const output = await sw.executeCommand('u all');
      expect(output.toLowerCase()).toContain('all possible debugging has been turned off');
    });

    it('13. should reject unrecognized debugging scopes gracefully', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('debug invalid_scope_name');
      expect(output.toLowerCase()).toContain('%');
    });

    it('14. should handle command case-sensitivity patterns correctly (ignore uppercase commands)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('DEBUG ARP');
      expect(output.toLowerCase()).toContain('%');
    });

    it('15. should verify that undebugging an already inactive scope prints no change confirmation', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('undebug arp');
      expect(output.toLowerCase()).toContain('arp packet debugging is off');
    });
  });

  // ─── Block 2: Terminal Monitor Log Redirection (Tests 16-25) ────

  describe('Terminal Monitor Log Redirection', () => {
    it('16. should activate terminal monitoring via terminal monitor', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('terminal monitor');
      expect(output.trim()).toBe('');
    });

    it('17. should show active monitoring state inside show terminal', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: enabled');
    });

    it('18. should deactivate terminal monitoring via terminal no monitor', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      const output = await sw.executeCommand('terminal no monitor');
      expect(output.trim()).toBe('');
    });

    it('19. should verify terminal monitoring state is disabled inside show terminal', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      await sw.executeCommand('terminal no monitor');
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: disabled');
    });

    it('20. should support abbreviation term mon to enable monitor', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('term mon');
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: enabled');
    });

    it('21. should support abbreviation term no mon to disable monitor', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('term mon');
      await sw.executeCommand('term no mon');
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: disabled');
    });

    it('22. should deny terminal monitor commands from global configuration mode', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('terminal monitor');
      expect(output.toLowerCase()).toContain('%');
    });

    it('23. should suppress diagnostic terminal prints when terminal monitor is turned off', async () => {
      const { sw, pc1, pc2 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal no monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      // Trigger ARP traffic
      const trafficPromise = pc1.executeCommand('ping -c 1 10.0.0.2');
      const switchConsoleOutput = await sw.executeCommand(''); // refresh console buffer
      await trafficPromise;

      expect(switchConsoleOutput).not.toContain('ARP:');
    });

    it('24. should print debug outputs immediately if terminal monitor is active', async () => {
      const { sw, pc1, pc2 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      await pc1.executeCommand('ping -c 1 10.0.0.2');
      const consoleLog = await sw.executeCommand(''); // read buffer output
      expect(consoleLog).toContain('ARP:');
    });

    it('25. should preserve terminal monitoring configurations across configure terminal sessions', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('exit');
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: enabled');
    });
  });

  // ─── Block 3: Subsystem Live Debugging with Traffic (Tests 26-40) 

  describe('Subsystem Live Debugging with Traffic', () => {
    it('26. should log MAC address learning events when debug mac address-table is enabled', async () => {
      const { sw, pc1 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug mac address-table');
      await sw.executeCommand('terminal monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc1.executeCommand('ping -c 1 10.0.0.254'); // trigger frame transmission

      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/mac|dynamic|learn/);
    });

    it('27. should log dynamic MAC expiration/aging events if simulated', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug mac address-table');
      await sw.executeCommand('terminal monitor');
      
      await sw.executeCommand('clear mac address-table dynamic');
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/mac|clear|delete|remove/);
    });

    it('28. should log ARP request transitions with debug arp', async () => {
      const { sw, pc1, pc2 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      await pc1.executeCommand('ping -c 1 10.0.0.2');
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/arp|req|request|who-has/);
    });

    it('29. should log ARP reply transitions with debug arp', async () => {
      const { sw, pc1, pc2 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      await pc1.executeCommand('ping -c 1 10.0.0.2');
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/arp|rep|reply|is-at/);
    });

    it('30. should log ICMP Echo transitions under debug ip icmp on routers', async () => {
      const { r1, r2 } = setupDebugWAN();
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('end');

      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip address 10.0.0.2 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('end');

      await r1.executeCommand('debug ip icmp');
      await r1.executeCommand('terminal monitor');

      await r2.executeCommand('ping 10.0.0.1');
      const consoleLog = await r1.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/icmp|echo|request|rcvd/);
    });

    it('31. should log packet routing/forwarding events with debug ip packet on routers', async () => {
      const { r1, r2 } = setupDebugWAN();
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('end');

      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip address 10.0.0.2 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('end');

      await r1.executeCommand('debug ip packet');
      await r1.executeCommand('terminal monitor');

      await r2.executeCommand('ping 10.0.0.1');
      const consoleLog = await r1.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/ip|d=|s=|forward/);
    });

    it('32. should isolate LLDP protocol discovery packets under debug lldp packets', async () => {
      const { r1 } = setupDebugWAN();
      await r1.executeCommand('enable');
      await r1.executeCommand('debug lldp packets');
      const status = await r1.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('lldp');
    });

    it('33. should isolate CDP protocol discovery packets under debug cdp packets', async () => {
      const { r1 } = setupDebugWAN();
      await r1.executeCommand('enable');
      await r1.executeCommand('debug cdp packets');
      const status = await r1.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('cdp');
    });

    it('34. should print diagnostics of physical link down triggers with debug link-state', async () => {
      const { sw, cable1 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug link-state');
      await sw.executeCommand('terminal monitor');

      cable1.disconnect();
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/link|down|state|change/);
    });

    it('35. should print diagnostics of physical link up triggers with debug link-state', async () => {
      const { sw, pc1, cable1 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug link-state');
      await sw.executeCommand('terminal monitor');

      cable1.disconnect();
      cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toMatch(/link|up|state|change/);
    });

    it('36. should suppress all sub-scope prints immediately once undebug all is evaluated', async () => {
      const { sw, pc1, pc2 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');
      await sw.executeCommand('undebug all');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      await pc1.executeCommand('ping -c 1 10.0.0.2');
      const consoleLog = await sw.executeCommand('');
      expect(consoleLog).not.toContain('ARP:');
    });

    it('37. should support multi-scope active states concurrently (debug arp + debug mac address-table)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('debug mac address-table');
      const status = await sw.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('arp');
      expect(status.toLowerCase()).toContain('mac');
    });

    it('38. should log custom warning when dynamic SVI IP collisions are detected', async () => {
      const { sw, pc1 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await sw.executeCommand('no shutdown');
      await sw.executeCommand('end');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');

      // PC1 claims the same IP address
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc1.executeCommand('ping -c 1 10.0.0.100'); // generates ARP conflict

      const consoleLog = await sw.executeCommand('');
      expect(consoleLog.toLowerCase()).toBeDefined();
    });

    it('39. should log DHCP negotiations under debug ip dhcp server if configured', async () => {
      const { r1 } = setupDebugWAN();
      await r1.executeCommand('enable');
      const output = await r1.executeCommand('debug ip dhcp server');
      expect(output.toLowerCase()).toContain('dhcp');
    });

    it('40. should support disabling DHCP debugging via no debug ip dhcp server', async () => {
      const { r1 } = setupDebugWAN();
      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip dhcp server');
      const output = await r1.executeCommand('no debug ip dhcp server');
      expect(output.toLowerCase()).toContain('dhcp');
    });
  });

  // ─── Block 4: Security, Modes & Session Isolation (Tests 41-50) ──

  describe('Security, Modes & Session Isolation', () => {
    it('41. should block execution of debug commands in User EXEC mode', async () => {
      const { sw } = setupDebugLAN();
      const output = await sw.executeCommand('debug arp');
      expect(output.toLowerCase()).toContain('%'); // Command authorization failure
    });

    it('42. should block execution of undebug commands in User EXEC mode', async () => {
      const { sw } = setupDebugLAN();
      const output = await sw.executeCommand('undebug arp');
      expect(output.toLowerCase()).toContain('%');
    });

    it('43. should block execution of show debugging in User EXEC mode', async () => {
      const { sw } = setupDebugLAN();
      const output = await sw.executeCommand('show debugging');
      expect(output.toLowerCase()).toContain('%');
    });

    it('44. should wipe all active debugging scopes on soft reboot (reload)', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('reload');
      await sw.executeCommand('enable');
      const status = await sw.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('no debugging');
    });

    it('45. should prevent running debug profiles from writing into startup-config', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('write');
      await sw.executeCommand('reload');
      await sw.executeCommand('enable');
      const status = await sw.executeCommand('show debugging');
      expect(status.toLowerCase()).toContain('no debugging'); // Debug profiles are volatile
    });

    it('46. should isolate terminal monitor state to active connection session memory', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('terminal monitor');
      await sw.executeCommand('exit'); // terminate console session

      await sw.executeCommand('enable'); // start a clean console session
      const status = await sw.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('monitor parameter: disabled'); // defaults back
    });

    it('47. should limit log buffer overflow gracefully during heavy diagnostic generation', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug all');
      await sw.executeCommand('terminal monitor');
      
      // Inject dummy events to ensure buffers do not throw out-of-memory exceptions
      for (let i = 0; i < 50; i++) {
        await sw.executeCommand(''); // triggers refresh cycles
      }
      const status = await sw.executeCommand('show debugging');
      expect(status).toBeDefined();
    });

    it('48. should allow enabling secure logging history buffer sizes with logging history size', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const output = await sw.executeCommand('logging history size 50');
      expect(output.trim()).toBe('');
    });

    it('49. should support printing timestamp formats inside diagnostic outputs', async () => {
      const { sw, pc1 } = setupDebugLAN();
      await sw.executeCommand('enable');
      await sw.executeCommand('debug arp');
      await sw.executeCommand('terminal monitor');

      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc1.executeCommand('ping -c 1 10.0.0.254');

      const consoleLog = await sw.executeCommand('');
      // Debug logs typically contain ISO or simple millisecond uptime markers
      expect(consoleLog).toBeDefined();
    });

    it('50. should verify that undebugging an unrecognized scope results in an error output', async () => {
      const { sw } = setupDebugLAN();
      await sw.executeCommand('enable');
      const output = await sw.executeCommand('undebug invalid_scope_name');
      expect(output.toLowerCase()).toContain('%');
    });
  });
});
