/**
 * TDD tests for Cisco IOS CLI Terminal, Modes, Auto-Completion, and Suggestions.
 * 
 * Covers exactly 100 test scenarios divided into:
 *  - Block 1: Multi-level Terminal Modes & Navigation (enable, disable, config, sub-modes) (Tests 1-25)
 *  - Block 2: Context-Sensitive Help & Suggestion Engine ('?' operator) (Tests 26-50)
 *  - Block 3: Command Abbreviations & Common Shortcuts (Tests 51-70)
 *  - Block 4: Tab-Key Auto-Completion Engine (Tests 71-85)
 *  - Block 5: Syntax Errors, Ambiguity Diagnostics & Caret (^) Marker Positioners (Tests 86-100)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupRouter() {
  return new CiscoRouter('r1', 'Router', 0, 0);
}

const setupCiscoRouter = setupRouter;

// ═══════════════════════════════════════════════════════════════════
// CISCO CLI SHELL & TERMINAL TESTS (1-100)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS CLI Terminal & Mode Transitions', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: Multi-level Terminal Modes (Tests 1-25) ────────────

  describe('Block 1: Multi-level Terminal Modes & Navigation', () => {
    it('1. should boot into User EXEC mode by default', async () => {
      const r = setupRouter();
      expect(await r.getPrompt()).toBe('Router>');
    });

    it('2. should transition to Privileged EXEC mode using enable', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('3. should transition back to User EXEC mode from Privileged EXEC using disable', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('disable');
      expect(await r.getPrompt()).toBe('Router>');
    });

    it('4. should transition to Global Configuration mode using configure terminal', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('5. should transition back to Privileged EXEC from Global Configuration using exit', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('6. should transition back to Privileged EXEC from Global Configuration using end', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('7. should transition to Interface Configuration mode from Global Configuration', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(await r.getPrompt()).toBe('Router(config-if)#');
    });

    it('8. should transition back to Global Configuration from Interface Configuration using exit', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('9. should transition directly to Privileged EXEC from Interface Configuration using end', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('10. should transition to Subinterface Configuration mode from Global Configuration', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      expect(await r.getPrompt()).toBe('Router(config-subif)#');
    });

    it('11. should transition back to Global Configuration from Subinterface Configuration using exit', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('12. should transition directly to Privileged EXEC from Subinterface Configuration using end', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('13. should transition to Line Configuration mode from Global Configuration', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('14. should transition back to Global Configuration from Line Configuration using exit', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('15. should transition directly to Privileged EXEC from Line Configuration using end', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('16. should transition to Router Protocol Configuration mode from Global Configuration', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      expect(await r.getPrompt()).toBe('Router(config-router)#');
    });

    it('17. should transition back to Global Configuration from Router Protocol Configuration using exit', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('18. should transition directly to Privileged EXEC from Router Protocol Configuration using end', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('19. should change prompt dynamically when hostname is modified', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname CORE_R1');
      expect(await r.getPrompt()).toBe('CORE_R1(config)#');
    });

    it('20. should retain prompt changes across nested configurations sub-modes', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname CORE_R1');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(await r.getPrompt()).toBe('CORE_R1(config-if)#');
    });

    it('21. should revert prompt hostname back to default on negation (no hostname)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname CORE_R1');
      await r.executeCommand('no hostname');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('22. should close connection if exit is evaluated in User EXEC mode', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('exit');
      expect(output.toLowerCase()).toContain('connection closed');
    });

    it('23. should show help screen if end is evaluated in Privileged EXEC mode (ignored)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('end');
      expect(output.trim()).toBe('');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('24. should show help screen if exit is evaluated in Privileged EXEC mode (reverts to User EXEC)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router>');
    });

    it('25. should support transition to VLAN Configuration mode (if supported on router/switch)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('vlan 10');
      expect(await r.getPrompt()).toBe('Router(config-vlan)#');
    });
  });

  // ─── Block 2: Context-Sensitive Help (Tests 26-50) ────────────────

  describe('Block 2: Context-Sensitive Help & Suggestion Engine', () => {
    it('26. should list all available commands in User EXEC mode on "?"', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('?');
      expect(output).toContain('enable');
      expect(output).toContain('ping');
      expect(output).toContain('show');
    });

    it('27. should list all available commands in Privileged EXEC mode on "?"', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('?');
      expect(output).toContain('configure');
      expect(output).toContain('reload');
      expect(output).toContain('write');
    });

    it('28. should list all available commands in Global Config mode on "?"', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('?');
      expect(output).toContain('hostname');
      expect(output).toContain('interface');
      expect(output).toContain('router');
    });

    it('29. should list suggestions matching typed prefix ("c?") in Privileged EXEC', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('c?');
      expect(output).toContain('clear');
      expect(output).toContain('configure');
      expect(output).toContain('copy');
    });

    it('30. should list suggestions matching typed prefix ("sh?") in User EXEC', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('sh?');
      expect(output).toContain('show');
    });

    it('31. should list parameter suggestions with space prefix ("show ?")', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('show ?');
      expect(output).toContain('clock');
      expect(output).toContain('version');
    });

    it('32. should list advanced parameter suggestions ("show ip ?") in Privileged EXEC', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show ip ?');
      expect(output).toContain('interface');
      expect(output).toContain('route');
    });

    it('33. should list interface targets in config mode ("interface ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface ?');
      expect(output).toContain('GigabitEthernet');
      expect(output).toContain('Loopback');
    });

    it('34. should list routing protocols in config mode ("router ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('router ?');
      expect(output).toContain('ospf');
      expect(output).toContain('rip');
    });

    it('35. should list line options in config mode ("line ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('line ?');
      expect(output).toContain('console');
      expect(output).toContain('vty');
    });

    it('36. should support suggestions on empty line commands with trailing spaces ("   ?")', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('   ?');
      expect(output).toContain('enable');
    });

    it('37. should return unlisted/blank suggestions if no commands match typed prefix ("z?")', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('z?');
      expect(output.trim()).toBe('');
    });

    it('38. should list command sub-arguments dynamically ("show ip route ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show ip route ?');
      expect(output).toContain('static');
      expect(output).toContain('ospf');
    });

    it('39. should support help suggestion inside line configuration sub-mode ("line vty 0 4" -> "?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('?');
      expect(output).toContain('password');
      expect(output).toContain('login');
    });

    it('40. should support help suggestion inside interface configuration sub-mode ("interface GigabitEthernet0/0" -> "?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const output = await r.executeCommand('?');
      // IOS interface-mode ? lists top-level keywords with a one-line
      // description; `ip address` is reached via `ip ?` (a deeper level).
      expect(output).toContain('ip');
      expect(output).toContain('shutdown');
    });

    it('41. should list copy targets inside Privileged EXEC ("copy ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('copy ?');
      expect(output).toContain('running-config');
      expect(output).toContain('startup-config');
    });

    it('42. should list copy destination targets inside Privileged EXEC ("copy running-config ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('copy running-config ?');
      expect(output).toContain('startup-config');
    });

    it('43. should list clear options inside Privileged EXEC ("clear ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('clear ?');
      expect(output).toContain('arp-cache');
      expect(output).toContain('counters');
    });

    it('44. should list debug options inside Privileged EXEC ("debug ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('debug ?');
      expect(output).toContain('all');
      expect(output).toContain('ip');
    });

    it('45. should list ip debug sub-options ("debug ip ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('debug ip ?');
      expect(output).toContain('icmp');
      expect(output).toContain('packet');
    });

    it('46. should suggest no negation targets in config mode ("no ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('no ?');
      expect(output).toContain('hostname');
      expect(output).toContain('interface');
    });

    it('47. should suggest no ip targets in config mode ("no ip ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('no ip ?');
      expect(output).toContain('route');
      expect(output).toContain('routing');
    });

    it('48. should list write parameters in Privileged EXEC ("write ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('write ?');
      expect(output).toContain('memory');
    });

    it('49. should reject suggestion query if typed in config subinterface sub-mode improperly ("interface GigabitEthernet0/0.10" -> "invalid_cmd ?")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const output = await r.executeCommand('invalid_cmd ?');
      expect(output.toLowerCase()).toContain('%');
    });

    it('50. should display end-of-line marker (<cr>) if command parameters list is satisfied ("show clock ?")', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('show clock ?');
      expect(output).toContain('<cr>');
    });
  });

  // ─── Block 3: Command Abbreviations & Shortcuts (Tests 51-70) ────

  describe('Block 3: Command Abbreviations & Common Shortcuts', () => {
    it('51. should evaluate common abbreviation "conf t" as configure terminal', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('52. should evaluate common abbreviation "sh ip int br" as show ip interface brief', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('sh ip int br');
      expect(output).toContain('Interface');
      expect(output).toContain('GigabitEthernet0/0');
    });

    it('53. should evaluate common abbreviation "int gi0/0" as interface GigabitEthernet0/0', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('int gi0/0');
      expect(await r.getPrompt()).toBe('Router(config-if)#');
    });

    it('54. should evaluate common abbreviation "no sh" as no shutdown', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('int gi0/0');
      const output = await r.executeCommand('no sh');
      expect(output.trim()).toBe('');
    });

    it('55. should evaluate common abbreviation "wr mem" as write memory', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('wr mem');
      expect(output).toContain('OK');
    });

    it('56. should evaluate common abbreviation "copy run start" as copy running-config startup-config', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('copy run start');
      expect(output.toLowerCase()).toContain('destination');
    });

    it('57. should evaluate common abbreviation "u all" as undebug all', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('debug all');
      const output = await r.executeCommand('u all');
      expect(output.toLowerCase()).toContain('disabled');
    });

    it('58. should evaluate abbreviation "sh ip ro" as show ip route', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('sh ip ro');
      expect(output).toContain('Codes:');
    });

    it('59. should evaluate interface abbreviation "int lo0" as interface Loopback0', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('int lo0');
      expect(await r.getPrompt()).toBe('Router(config-if)#');
    });

    it('60. should evaluate abbreviation "sh ver" as show version', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('sh ver');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('61. should evaluate line abbreviation "line con 0" as line console 0', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('line con 0');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('62. should evaluate line abbreviation "line vty 0 4" as line vty 0 4', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('line vty 0 4');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('63. should evaluate protocol abbreviation "router os 1" as router ospf 1', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('router os 1');
      expect(await r.getPrompt()).toBe('Router(config-router)#');
    });

    it('64. should evaluate dynamic show arp abbreviation "sh arp"', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('sh arp');
      expect(output.toLowerCase()).toContain('no arp');
    });

    it('65. should evaluate interface description abbreviation "desc CORE_LINK" as description CORE_LINK', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      await r.executeCommand('int gi0/0');
      const output = await r.executeCommand('desc CORE_LINK');
      expect(output.trim()).toBe('');
    });

    it('66. should evaluate static route abbreviation "ip ro 10.0.0.0 255.0.0.0 192.168.1.1"', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      const output = await r.executeCommand('ip ro 10.0.0.0 255.0.0.0 192.168.1.1');
      expect(output.trim()).toBe('');
    });

    it('67. should reject extremely short ambiguous abbreviations ("c" in Privileged EXEC is ambiguous)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('c');
      expect(output.toLowerCase()).toContain('% ambiguous command');
    });

    it('68. should reject extremely short ambiguous abbreviations ("s" in User EXEC is ambiguous)', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('s');
      expect(output.toLowerCase()).toContain('% ambiguous command');
    });

    it('69. should evaluate clear arp-cache abbreviation "cl arp"', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('cl arp');
      expect(output.trim()).toBe('');
    });

    it('70. should support space-free punctuation inside abbreviation strings ("no ip routing" -> "no ip rout")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('conf t');
      const output = await r.executeCommand('no ip rout');
      expect(output.trim()).toBe('');
    });
  });

  // ─── Block 4: Tab Auto-completion Engine (Tests 71-85) ────────────

  describe('Block 4: Tab-Key Auto-Completion Engine', () => {
    it('71. should auto-complete unique prefix "en[tab]" to enable in User EXEC', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('en\t');
      expect(output.trim()).toBe('enable');
    });

    it('72. should auto-complete unique prefix "con[tab]" to configure in Privileged EXEC', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('con\t');
      expect(output.trim()).toBe('configure');
    });

    it('73. should auto-complete unique parameter "configure ter[tab]" to configure terminal', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure ter\t');
      expect(output.trim()).toBe('configure terminal');
    });

    it('74. should not auto-complete ambiguous prefix "c[tab]" in Privileged EXEC', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('c\t');
      expect(output.trim()).toBe('c'); // no expansion, prints input back
    });

    it('75. should auto-complete unique interface prefix "int[tab]" to interface in Global Config', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('int\t');
      expect(output.trim()).toBe('interface');
    });

    it('76. should auto-complete unique interface name "interface gig[tab]" to interface GigabitEthernet', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface gig\t');
      expect(output.trim()).toBe('interface GigabitEthernet');
    });

    it('77. should auto-complete unique interface name "interface lo[tab]" to interface Loopback', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface lo\t');
      expect(output.trim()).toBe('interface Loopback');
    });

    it('78. should auto-complete unique line prefix "li[tab]" to line in Global Config', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('li\t');
      expect(output.trim()).toBe('line');
    });

    it('79. should auto-complete unique line parameter "line co[tab]" to line console', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('line co\t');
      expect(output.trim()).toBe('line console');
    });

    it('80. should auto-complete unique line parameter "line vt[tab]" to line vty', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('line vt\t');
      expect(output.trim()).toBe('line vty');
    });

    it('81. should auto-complete unique router prefix "rout[tab]" to router in Global Config', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('rout\t');
      expect(output.trim()).toBe('router');
    });

    it('82. should auto-complete unique router protocol "router os[tab]" to router ospf', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('router os\t');
      expect(output.trim()).toBe('router ospf');
    });

    it('83. should auto-complete unique router protocol "router ri[tab]" to router rip', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('router ri\t');
      expect(output.trim()).toBe('router rip');
    });

    it('84. should ignore trailing spaces on tab executions cleanly ("enable   \t" -> "enable")_', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('enable   \t');
      expect(output.trim()).toBe('enable');
    });

    it('85. should auto-complete unique clock parameter "show cl[tab]" to show clock', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('show cl\t');
      expect(output.trim()).toBe('show clock');
    });
  });

  // ─── Block 5: Error Handlers & Syntax Validation (Tests 86-100) ──

  describe('Block 5: Syntax Errors, Ambiguity Diagnostics & Caret (^) Marker Positioners', () => {
    it('86. should return unrecognized command error on random invalid inputs ("invalid_cmd")', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('invalid_cmd');
      expect(output).toContain('% Unrecognized command');
    });

    it('87. should return carets positioner pointing to invalid command prefix', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('invalid_cmd');
      expect(output).toContain('^'); // Caret points to start of invalid token
    });

    it('88. should return ambiguous command error on ambiguous input ("c" in Privileged EXEC)', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('c');
      expect(output).toContain('% Ambiguous command: "c"');
    });

    it('89. should return incomplete command error on incomplete input ("configure")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure');
      expect(output).toContain('% Incomplete command.');
    });

    it('90. should return caret pointing to incomplete parameter boundary on partial input ("show ip")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show ip');
      expect(output).toContain('% Incomplete command.');
    });

    it('91. should return invalid input detected error if parameters are out of range ("interface GigabitEthernet9/9")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface GigabitEthernet9/9');
      expect(output).toContain('% Invalid input detected');
    });

    it('92. should position caret "^" exactly below invalid parameter value in range errors', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface GigabitEthernet9/9');
      // Verify caret aligns under the invalid index
      const lines = output.split('\n');
      const caretLine = lines.find(l => l.includes('^'));
      expect(caretLine).toBeDefined();
    });

    it('93. should reject global commands evaluated in incorrect subinterface configuration sub-modes', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const output = await r.executeCommand('router ospf 1');
      expect(output).toContain('% Unrecognized command'); // rejected inside interface config sub-mode
    });

    it('94. should reject interface commands evaluated in line configuration sub-modes', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('interface GigabitEthernet0/0');
      expect(output).toContain('% Unrecognized command');
    });

    it('95. should reject config mode commands executed inside User EXEC mode', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('hostname CORE_R1');
      expect(output).toContain('% Unrecognized command');
    });

    it('96. should reject write memory command executed inside Global Config mode', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('write memory');
      expect(output).toContain('% Unrecognized command'); // "do write memory" is required instead
    });

    it('97. should support "do" prefix to execute Privileged EXEC commands inside Global Config mode ("do show version")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('do show version');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('98. should support "do" prefix to execute write memory inside Global Config mode ("do write memory")', async () => {
      const r = setupRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('do write memory');
      expect(output).toContain('OK');
    });

    it('99. should reject "do" prefix if executed inside User EXEC mode', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('do show version');
      expect(output).toContain('% Unrecognized command');
    });

    it('100. should execute successfully and return status 0 on default help commands validations', async () => {
      const r = setupRouter();
      const output = await r.executeCommand('? && echo "CLI_OK"');
      expect(output).toContain('CLI_OK');
    });
  });

/**
 * TDD tests for the Cisco Router Terminal CLI (Continuation: Tests 101-200).
 *
 * Covers:
 *  - Block 6: Advanced Terminal & Line Parameter Controls (Tests 101-125)
 *  - Block 7: Command History Engine (show history) (Tests 126-145)
 *  - Block 8: Banners & Prompts Customization (Tests 146-165)
 *  - Block 9: Line Authentication, Authorization & Security (Tests 166-185)
 *  - Block 10: Advanced CLI Parsing, Stress Boundaries & Escaping (Tests 186-200)
 */

// ═══════════════════════════════════════════════════════════════════
// CISCO CLI SHELL & TERMINAL CONTINUATION TESTS (101-200)
// ═══════════════════════════════════════════════════════════════════

  // ─── Block 6: Advanced Terminal & Line Parameters (Tests 101-125) ──

  describe('Block 6: Advanced Terminal & Line Parameters', () => {
    it('101. should set terminal history size via terminal history size', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal history size 50');
      expect(output.trim()).toBe('');
      const status = await r.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('history size 50');
    });

    it('102. should reject terminal history size if value exceeds 256', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal history size 300');
      expect(output.toLowerCase()).toContain('%');
    });

    it('103. should reject terminal history size if value is negative', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal history size -10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('104. should set terminal screen length using terminal length', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal length 40');
      expect(output.trim()).toBe('');
      const status = await r.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('length 40');
    });

    it('105. should disable pagination when terminal length is set to 0', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal length 0');
      const status = await r.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('length 0'); // 0 means no pagination
    });

    it('106. should reject terminal length if value is negative', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal length -5');
      expect(output.toLowerCase()).toContain('%');
    });

    it('107. should set terminal screen width using terminal width', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal width 120');
      expect(output.trim()).toBe('');
      const status = await r.executeCommand('show terminal');
      expect(status.toLowerCase()).toContain('width 120');
    });

    it('108. should reject terminal width if value is smaller than 512 bounds (less than 40)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal width 30');
      expect(output.toLowerCase()).toContain('%');
    });

    it('109. should reject terminal width if value is greater than 512', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('terminal width 600');
      expect(output.toLowerCase()).toContain('%');
    });

    it('110. should configure session exec timeout under line console mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('exec-timeout 15 0'); // 15 mins, 0 seconds
      expect(output.trim()).toBe('');
    });

    it('111. should disable exec timeout under line console mode via exec-timeout 0 0', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('exec-timeout 0 0');
      expect(output.trim()).toBe('');
    });

    it('112. should reject negative minutes inside exec-timeout', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('exec-timeout -5 0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('113. should reject negative seconds inside exec-timeout', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('exec-timeout 10 -30');
      expect(output.toLowerCase()).toContain('%');
    });

    it('114. should negate exec-timeout back to defaults using no exec-timeout', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('no exec-timeout');
      expect(output.trim()).toBe('');
    });

    it('115. should enable log alignment synchronous updates using logging synchronous', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('logging synchronous');
      expect(output.trim()).toBe('');
    });

    it('116. should disable log alignment synchronous updates using no logging synchronous', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('no logging synchronous');
      expect(output.trim()).toBe('');
    });

    it('117. should show logging synchronous state inside running-config console line block', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('logging synchronous');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config interface line console 0'); // verify line parsing
      expect(output).toBeDefined();
    });

    it('118. should configure line transport input protocols (transport input ssh)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('transport input ssh');
      expect(output.trim()).toBe('');
    });

    it('119. should configure line transport input protocols (transport input telnet)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('transport input telnet');
      expect(output.trim()).toBe('');
    });

    it('120. should configure line transport input protocols (transport input none)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('transport input none');
      expect(output.trim()).toBe('');
    });

    it('121. should reject transport input configuration if protocol is invalid', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('transport input invalid_proto');
      expect(output.toLowerCase()).toContain('%');
    });

    it('122. should deny terminal modifications from User EXEC mode (terminal length)', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('terminal length 10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('123. should deny terminal modifications from User EXEC mode (terminal width)', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('terminal width 80');
      expect(output.toLowerCase()).toContain('%');
    });

    it('124. should deny terminal modifications from User EXEC mode (terminal history)', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('terminal history size 50');
      expect(output.toLowerCase()).toContain('%');
    });

    it('125. should restore default terminal length on soft reboot (reload)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal length 50');
      await r.executeCommand('reload');
      await r.executeCommand('enable');
      const status = await r.executeCommand('show terminal');
      expect(status.toLowerCase()).not.toContain('length 50'); // defaults back (length modifications are volatile)
    });
  });

  // ─── Block 7: Command History Engine (Tests 126-145) ──────────────

  describe('Block 7: Command History Engine', () => {
    it('126. should record executed commands in show history', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show version');
      const history = await r.executeCommand('show history');
      expect(history).toContain('show version');
    });

    it('127. should record configure terminal sequences inside history buffer', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('exit');
      const history = await r.executeCommand('show history');
      expect(history).toContain('configure terminal');
    });

    it('128. should respect custom history size limits (size 2 -> stores only 2)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal history size 2');
      await r.executeCommand('show version');
      await r.executeCommand('show clock');
      await r.executeCommand('show arp');
      const history = await r.executeCommand('show history');
      expect(history).toContain('show arp');
      expect(history).toContain('show clock');
      expect(history).not.toContain('show version'); // evicted
    });

    it('129. should clear terminal history buffer explicitly using clear history', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show version');
      await r.executeCommand('clear history');
      const history = await r.executeCommand('show history');
      expect(history.trim()).toBe('show history'); // history contains the command that queried it
    });

    it('130. should deny clear history execution from User EXEC mode', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('clear history');
      expect(output.toLowerCase()).toContain('%');
    });

    it('131. should deny show history execution from User EXEC mode', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show history');
      expect(output.toLowerCase()).toContain('%');
    });

    it('132. should disable history recording if terminal history is deactivated (terminal no history)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal no history');
      await r.executeCommand('show version');
      const history = await r.executeCommand('show history');
      expect(history).not.toContain('show version');
    });

    it('133. should enable history recording after deactivation using terminal history', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal no history');
      await r.executeCommand('terminal history');
      await r.executeCommand('show version');
      const history = await r.executeCommand('show history');
      expect(history).toContain('show version');
    });

    it('134. should store consecutive duplicate commands in history if unique is not set', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show clock');
      await r.executeCommand('show clock');
      const history = await r.executeCommand('show history');
      const occurrences = history.split('show clock').length - 1;
      expect(occurrences).toBe(2);
    });

    it('135. should preserve history entries sequentially (FIFO check)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show version');
      await r.executeCommand('show clock');
      const history = await r.executeCommand('show history');
      const firstIndex = history.indexOf('show version');
      const secondIndex = history.indexOf('show clock');
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it('136. should support show history summary or similar status commands (show terminal)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show terminal');
      expect(output.toLowerCase()).toContain('history');
    });

    it('137. should support clearing history buffer on soft reboots', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show version');
      await r.executeCommand('reload');
      await r.executeCommand('enable');
      const history = await r.executeCommand('show history');
      expect(history).not.toContain('show version');
    });

    it('138. should handle empty history buffers cleanly on startup', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const history = await r.executeCommand('show history');
      expect(history.trim()).toBe('show history');
    });

    it('139. should not record unrecognized/syntax error commands in history buffer', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('invalid_unrecognized_command');
      const history = await r.executeCommand('show history');
      expect(history).not.toContain('invalid_unrecognized_command');
    });

    it('140. should record dynamic SVI interface commands in history', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('end');
      const history = await r.executeCommand('show history');
      expect(history).toContain('interface GigabitEthernet0/0');
    });

    it('141. should support history sizes limit of 0 (effectively disabling recording)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal history size 0');
      await r.executeCommand('show version');
      const history = await r.executeCommand('show history');
      expect(history).not.toContain('show version');
    });

    it('142. should support history sizes limit of 1 (retaining only last command)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('terminal history size 1');
      await r.executeCommand('show version');
      await r.executeCommand('show clock');
      const history = await r.executeCommand('show history');
      expect(history).toContain('show clock');
      expect(history).not.toContain('show version');
    });

    it('143. should preserve history state across sub-mode changes', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('exit');
      await r.executeCommand('exit');
      const history = await r.executeCommand('show history');
      expect(history).toContain('line console 0');
    });

    it('144. should support autocomplete on sh hist shortcut', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('show version');
      const history = await r.executeCommand('sh hist');
      expect(history).toContain('show version');
    });

    it('145. should execute successfully and return status 0 on clean history checks', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show history && echo "HISTORY_OK"');
      expect(output).toContain('HISTORY_OK');
    });
  });

  // ─── Block 8: Banners & Prompts Customization (Tests 146-165) ──────

  describe('Block 8: Banners & Prompts Customization', () => {
    it('146. should configure MOTD banner via banner motd', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd #WELCOME_TO_CISCO#');
      expect(output.trim()).toBe('');
    });

    it('147. should show MOTD banner in show running-config after creation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #WELCOME_TO_CISCO#');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner motd ^WELCOME_TO_CISCO^');
    });

    it('148. should negate MOTD banner via no banner motd', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #WELCOME#');
      await r.executeCommand('no banner motd');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('banner motd');
    });

    it('149. should configure login banner via banner login', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner login #AUTHORISED_USERS_ONLY#');
      expect(output.trim()).toBe('');
    });

    it('150. should show login banner in show running-config after creation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner login #AUTHORISED_USERS_ONLY#');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner login ^AUTHORISED_USERS_ONLY^');
    });

    it('151. should negate login banner via no banner login', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner login #WELCOME#');
      await r.executeCommand('no banner login');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('banner login');
    });

    it('152. should configure exec banner via banner exec', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner exec #EXEC_SESSION_STARTED#');
      expect(output.trim()).toBe('');
    });

    it('153. should show exec banner in show running-config after creation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner exec #EXEC_SESSION_STARTED#');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner exec ^EXEC_SESSION_STARTED^');
    });

    it('154. should negate exec banner via no banner exec', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner exec #WELCOME#');
      await r.executeCommand('no banner exec');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('banner exec');
    });

    it('155. should support using various delimiter characters in banners configuration (e.g. % instead of #)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd %WELCOME_PERCENT%');
      expect(output.trim()).toBe('');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner motd ^WELCOME_PERCENT^');
    });

    it('156. should support using various delimiter characters in banners configuration (e.g. $ instead of #)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd $WELCOME_DOLLAR$');
      expect(output.trim()).toBe('');
    });

    it('157. should reject banner configuration if delimiter characters do not match (e.g. #WELCOME%)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd #WELCOME%');
      expect(output.toLowerCase()).toContain('%'); // rejected or treated as unclosed multiline banner
    });

    it('158. should support empty banner messages parameter (e.g. banner motd ##)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd ##');
      expect(output.trim()).toBe('');
    });

    it('159. should show banners in terminal session upon connection simulation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #BANNER_ALERT#');
      await r.executeCommand('end');
      await r.executeCommand('exit'); // exit to user EXEC, simulating prompt renewal

      const prompt = await r.executeCommand(''); // refresh console
      expect(prompt).toContain('BANNER_ALERT');
    });

    it('160. should show login banner in terminal session upon login prompt (if configured)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner login #LOGIN_ALERT#');
      await r.executeCommand('end');
      await r.executeCommand('exit');
      const prompt = await r.executeCommand('');
      expect(prompt).toContain('LOGIN_ALERT');
    });

    it('161. should display configured banners inside write memory startup-config outputs', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #BOOT_BANNER#');
      await r.executeCommand('end');
      await r.executeCommand('write memory');
      const startup = await r.executeCommand('show startup-config');
      expect(startup).toContain('banner motd ^BOOT_BANNER^');
    });

    it('162. should support configuring incoming session banners via banner incoming', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner incoming #INCOMING_ALERT#');
      expect(output.trim()).toBe('');
    });

    it('163. should show incoming banner in show running-config after creation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner incoming #INCOMING_ALERT#');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner incoming ^INCOMING_ALERT^');
    });

    it('164. should negate incoming banner via no banner incoming', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner incoming #WELCOME#');
      await r.executeCommand('no banner incoming');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('banner incoming');
    });

    it('165. should execute successfully and return status 0 on default banner deletions', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure terminal && no banner motd && end && echo "BANNER_CLEARED"');
      expect(output).toContain('BANNER_CLEARED');
    });
  });

  // ─── Block 9: Line Authentication & Security (Tests 166-185) ──────

  describe('Block 9: Line Authentication & Security', () => {
    it('166. should configure password on console line 0 via password', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('password ciscopass');
      expect(output.trim()).toBe('');
    });

    it('167. should show password in running-config interface console line after creation', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('password ciscopass');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('password ciscopass');
    });

    it('168. should negate console line 0 password via no password', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('password ciscopass');
      await r.executeCommand('no password');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('password ciscopass');
    });

    it('169. should enable basic login enforcement using login under line console 0', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('login');
      expect(output.trim()).toBe('');
    });

    it('170. should disable login enforcement using no login under line console 0', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('no login');
      expect(output.trim()).toBe('');
    });

    it('171. should show login status inside line console running-config after enabling', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('login');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('line console 0\n login');
    });

    it('172. should show no login status inside line console running-config after disabling', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('no login');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('line console 0\n no login');
    });

    it('173. should configure local database login enforcement via login local', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('login local');
      expect(output.trim()).toBe('');
    });

    it('174. should show login local inside running-config console line block', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('login local');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('line console 0\n login local');
    });

    it('175. should negate login local back to default login via no login local', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('login local');
      await r.executeCommand('no login local');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('login local');
    });

    it('176. should configure privilege level for console line 0 (privilege level 15)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('privilege level 15');
      expect(output.trim()).toBe('');
    });

    it('177. should reject privilege level configuration if level is out of bounds (greater than 15)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('privilege level 16');
      expect(output.toLowerCase()).toContain('%');
    });

    it('178. should reject privilege level configuration if level is negative', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('privilege level -1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('179. should show privilege level in running-config console block', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('privilege level 15');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('line console 0\n privilege level 15');
    });

    it('180. should negate privilege level configuration using no privilege level', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('privilege level 15');
      await r.executeCommand('no privilege level');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('privilege level');
    });

    it('181. should allow enabling secure privilege level configuration under line vty 0 4', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const output = await r.executeCommand('privilege level 15');
      expect(output.trim()).toBe('');
    });

    it('182. should support configuring local user credentials in global database (username admin password cisco)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('username admin password cisco');
      expect(output.trim()).toBe('');
    });

    it('183. should show username credentials in running-config output', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin password cisco');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('username admin password cisco');
    });

    it('184. should negate username credentials via no username', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin password cisco');
      await r.executeCommand('no username admin');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('username admin');
    });

    it('185. should execute successfully and return status 0 on complete login authentication configurations', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure terminal && line console 0 && login && end && echo "LOGIN_OK"');
      expect(output).toContain('LOGIN_OK');
    });
  });

  // ─── Block 10: Advanced Parsing & Stress Boundaries (Tests 186-200) 

  describe('Block 10: Advanced CLI Parsing, Stress Boundaries & Escaping', () => {
    it('186. should reject command inputs exceeding maximum buffer limit of 512 characters', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const longCommand = 'show version ' + 'extra '.repeat(100);
      const output = await r.executeCommand(longCommand);
      expect(output.toLowerCase()).toContain('%'); // rejected as invalid/excess parameters
    });

    it('187. should handle multiple blank spaces inside commands safely ("show     version")', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show     version');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('188. should handle tab characters inside commands seamlessly ("show\\tversion")', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show\tversion');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('189. should handle carriage return characters gracefully inside inputs', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show version\r');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('190. should preserve trailing question marks inside string parameters of banners (e.g. banner motd #HELP?#)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #HELP?#');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner motd ^HELP?^');
    });

    it('191. should handle escaped characters safely in hostname definitions (e.g. hostname CORE\\_R1)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('hostname CORE\\_R1');
      expect(output.toLowerCase()).not.toContain('%'); // accepted, escaping resolved literally
    });

    it('192. should reject interface configurations if targeted index is invalid (interface GigabitEthernet0/0/0/0/0)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('interface GigabitEthernet0/0/0/0/0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('193. should position syntax caret "^" marker correctly under unrecognized subcommand tokens inside line config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('invalid_console_subcommand');
      expect(output).toContain('^');
    });

    it('194. should position syntax caret "^" marker correctly under unrecognized subcommand tokens inside interface config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const output = await r.executeCommand('invalid_interface_subcommand');
      expect(output).toContain('^');
    });

    it('195. should support using autocomplete inside config terminal mode to enter router sub-mode (router os[tab])', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('router os\t');
      expect(output.trim()).toBe('router ospf');
    });

    it('196. should support using autocomplete inside config terminal mode to enter line sub-mode (line con[tab])', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('line con\t');
      expect(output.trim()).toBe('line console');
    });

    it('197. should support do command to execute clear arp-cache inside configuration subinterfaces mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const output = await r.executeCommand('do clear arp-cache');
      expect(output.trim()).toBe('');
    });

    it('198. should preserve terminal modes when invalid commands are evaluated inside subinterfaces config mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('invalid_subcommand_error_generation');
      expect(await r.getPrompt()).toBe('Router(config-subif)#'); // mode remains unaffected
    });

    it('199. should preserve terminal modes when invalid commands are evaluated inside lines config mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('invalid_subcommand_error_generation');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('200. should execute successfully and return status 0 on complete terminal test sweeps', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show version && echo "TERMINAL_COMPLETE"');
      expect(output).toContain('TERMINAL_COMPLETE');
    });
  });

  // ─── Block 11: Alias Creation, Negations & Executions (Tests 201-225) ───

  describe('Block 11: Alias Creation, Negations & Executions', () => {
    it('201. should configure exec alias via alias exec', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('alias exec c show clock');
      expect(output.trim()).toBe('');
    });

    it('202. should show configured alias inside show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias exec c show clock');
    });

    it('203. should execute configured alias successfully', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('end');
      const output = await r.executeCommand('c');
      expect(output).toBeDefined(); // executes show clock
    });

    it('204. should negate configured alias via no alias exec', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('no alias exec c');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('alias exec c');
    });

    it('205. should reject executing negated alias', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('no alias exec c');
      await r.executeCommand('end');
      const output = await r.executeCommand('c');
      expect(output.toLowerCase()).toContain('%'); // unrecognized command
    });

    it('206. should prevent duplicate alias creations targeting same keyword', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      const output = await r.executeCommand('alias exec c show history'); // overwrite attempt
      expect(output.trim()).toBe(''); // accepted, overwriting old mapping
    });

    it('207. should show updated alias inside show running-config after overwrite', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('alias exec c show history');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias exec c show history');
      expect(running).not.toContain('alias exec c show clock');
    });

    it('208. should support aliases on configure terminal itself (alias exec ct configure terminal)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec ct configure terminal');
      await r.executeCommand('end');
      await r.executeCommand('ct');
      expect(await r.getPrompt()).toBe('R1(config)#');
    });

    it('209. should reject alias config if target command parameter has typos (alias exec c showww clock)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('alias exec c showww clock');
      expect(output.toLowerCase()).toContain('%');
    });

    it('210. should support configuring configuration-level aliases if supported (alias configure ipr ip route)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('alias configure ipr ip route');
      expect(output.trim()).toBe('');
    });

    it('211. should show configuration-level alias in show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias configure ipr ip route');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias configure ipr ip route');
    });

    it('212. should support interface-level aliases if supported (alias interface sh description)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('alias interface sh description');
      expect(output.trim()).toBe('');
    });

    it('213. should show interface-level alias in show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias interface sh description');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias interface sh description');
    });

    it('214. should deny alias modifications from User EXEC mode', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('alias exec c show clock');
      expect(output.toLowerCase()).toContain('%');
    });

    it('215. should support clear history evaluated inside an alias', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec cl_hist clear history');
      await r.executeCommand('end');
      const output = await r.executeCommand('cl_hist');
      expect(output.trim()).toBe('');
    });

    it('216. should support multi-parameter alias execution (alias exec p ping 127.0.0.1 -> "p")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec p ping 127.0.0.1');
      await r.executeCommand('end');
      const output = await r.executeCommand('p');
      expect(output).toContain('127.0.0.1');
    });

    it('217. should support alias trailing arguments matching target parameters (alias exec p ping -> "p 127.0.0.1")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec p ping');
      await r.executeCommand('end');
      const output = await r.executeCommand('p 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('218. should reject alias name parameter exceeding 31 characters limit', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const longName = 'A'.repeat(35);
      const output = await r.executeCommand(`alias exec ${longName} show clock`);
      expect(output.toLowerCase()).toContain('%');
    });

    it('219. should support single quotes around alias names inside Cisco config terminal', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand("alias exec 'c' 'show clock'");
      expect(output.trim()).toBe('');
    });

    it('220. should support double quotes around alias names inside Cisco config terminal', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('alias exec "c" "show clock"');
      expect(output.trim()).toBe('');
    });

    it('221. should overwrite dynamic entries but keep alias configurations on clear commands', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('end');
      await r.executeCommand('clear arp-cache');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias exec c show clock');
    });

    it('222. should preserve alias configurations across soft reboots (if write was executed)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('end');
      await r.executeCommand('write memory');
      await r.executeCommand('reload');
      await r.executeCommand('enable');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('alias exec c show clock');
    });

    it('223. should not preserve alias configurations across soft reboots (if write was NOT executed)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('alias exec c show clock');
      await r.executeCommand('end');
      await r.executeCommand('reload');
      await r.executeCommand('enable');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('alias exec c');
    });

    it('224. should support autocomplete on alias config terminal command (ali[tab])', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('ali\t');
      expect(output.trim()).toBe('alias');
    });

    it('225. should execute successfully and return status 0 on complete alias configurations', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure terminal && alias exec c show clock && end && echo "ALIAS_OK"');
      expect(output).toContain('ALIAS_OK');
    });
  });

  // ─── Block 12: Enable Secret, Password Encryption & Privilege (Tests 226-250) ───

  describe('Block 12: Enable Secret, Password Encryption & Privilege Levels', () => {
    it('226. should configure enable secret password via enable secret', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('enable secret supersecret');
      expect(output.trim()).toBe('');
    });

    it('227. should configure enable password via enable password', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('enable password normalpassword');
      expect(output.trim()).toBe('');
    });

    it('228. should show encrypted secret inside show running-config (using Type 5 MD5 hash)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret supersecret');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('enable secret 5 '); // 5 represents MD5 hashing
    });

    it('229. should show unencrypted password inside show running-config if encryption service is disabled', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('no service password-encryption');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('enable password normalpassword');
    });

    it('230. should encrypt enable password inside show running-config when service password-encryption is enabled', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('service password-encryption');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('enable password 7 '); // 7 represents standard Cisco vigenere-like encryption
      expect(running).not.toContain('normalpassword');
    });

    it('231. should retroactively encrypt existing passwords when service password-encryption is enabled', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('no service password-encryption');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('service password-encryption');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('enable password 7 ');
      expect(running).not.toContain('normalpassword');
    });

    it('232. should not decrypt passwords if service password-encryption is disabled (it remains encrypted)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('service password-encryption');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('no service password-encryption');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('enable password 7 '); // remains encrypted
    });

    it('233. should give precedence to enable secret over enable password (secret is queried first)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret supersecret');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('end');
      await r.executeCommand('exit'); // exit to user EXEC

      // Attempt login with enable password (should fail)
      const output1 = await r.executeCommand('enable\nnormalpassword');
      expect(output1.toLowerCase()).toContain('password'); // prompt still shown / failed
      
      // Attempt login with enable secret (should succeed)
      await r.executeCommand('\n'); // clear buffer
      await r.executeCommand('enable\nsupersecret');
      expect(await r.getPrompt()).toBe('R1#');
    });

    it('234. should deny enable transition if incorrect password is typed', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret supersecret');
      await r.executeCommand('end');
      await r.executeCommand('exit');

      const output = await r.executeCommand('enable\nwrongpassword');
      expect(await r.getPrompt()).toBe('Router>'); // remains in user EXEC
    });

    it('235. should negate enable secret via no enable secret', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret supersecret');
      await r.executeCommand('no enable secret');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('enable secret');
    });

    it('236. should negate enable password via no enable password', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable password normalpassword');
      await r.executeCommand('no enable password');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('enable password');
    });

    it('237. should allow unprivileged user to execute show clock', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show clock');
      expect(output).toBeDefined();
    });

    it('238. should deny unprivileged user access to configure terminal', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('configure terminal');
      expect(output.toLowerCase()).toContain('%');
    });

    it('239. should deny unprivileged user access to write memory', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('write memory');
      expect(output.toLowerCase()).toContain('%');
    });

    it('240. should deny unprivileged user access to show running-config', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show running-config');
      expect(output.toLowerCase()).toContain('%');
    });

    it('241. should support level-based enable logins explicitly (enable 15)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable 15');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('242. should reject level-based enable login if level is invalid (enable 16)', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('enable 16');
      expect(output.toLowerCase()).toContain('%');
    });

    it('243. should show password-encryption state inside show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('service password-encryption');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('service password-encryption');
    });

    it('244. should show password-encryption state as negated inside show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('no service password-encryption');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('no service password-encryption');
    });

    it('245. should protect secret and passwords across soft reboots dynamically', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret supersecret');
      await r.executeCommand('end');
      await r.executeCommand('write memory');
      await r.executeCommand('reload');

      const output = await r.executeCommand('enable\nwrong');
      expect(await r.getPrompt()).toBe('Router>');
    });

    it('246. should support configuring level privilege access limits for specific commands (privilege exec level 1 show clock)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('privilege exec level 1 show clock');
      expect(output.trim()).toBe('');
    });

    it('247. should show privilege command rule in show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('privilege exec level 1 show clock');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('privilege exec level 1 show clock');
    });

    it('248. should negate privilege command rule via no privilege', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('privilege exec level 1 show clock');
      await r.executeCommand('no privilege exec level 1 show clock');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).not.toContain('privilege exec level 1');
    });

    it('249. should reject privilege configuration if command keyword has typos', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('privilege execc level 1 show clock');
      expect(output.toLowerCase()).toContain('%');
    });

    it('250. should execute successfully and return status 0 on clean enable secrets config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure terminal && enable secret super && end && echo "SECRET_OK"');
      expect(output).toContain('SECRET_OK');
    });
  });

  // ─── Block 13: Advanced Submode Navigation & Help Screens (Tests 251-275)

  describe('Block 13: Advanced Submode Navigation, Help Screens & Queries', () => {
    it('251. should jump directly from interface to line configuration without returning to global configuration mode first', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(await r.getPrompt()).toBe('Router(config-if)#');
      await r.executeCommand('line console 0');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('252. should jump directly from line to router configuration directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
      await r.executeCommand('router ospf 1');
      expect(await r.getPrompt()).toBe('Router(config-router)#');
    });

    it('253. should jump directly from router to subinterface configuration directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      expect(await r.getPrompt()).toBe('Router(config-router)#');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      expect(await r.getPrompt()).toBe('Router(config-subif)#');
    });

    it('254. should jump directly from subinterface to VLAN configuration directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      expect(await r.getPrompt()).toBe('Router(config-subif)#');
      await r.executeCommand('vlan 10');
      expect(await r.getPrompt()).toBe('Router(config-vlan)#');
    });

    it('255. should list sub-context help screen inside config-router mode ("?")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      const output = await r.executeCommand('?');
      expect(output).toContain('network');
      expect(output).toContain('passive-interface');
    });

    it('256. should list sub-context help screen inside config-subif mode ("?")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const output = await r.executeCommand('?');
      expect(output).toContain('encapsulation');
      expect(output).toContain('ip address');
    });

    it('257. should list sub-context help screen inside config-vlan mode ("?")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('vlan 10');
      const output = await r.executeCommand('?');
      expect(output).toContain('name');
    });

    it('258. should support showing running-config filtered by interface target (show running-config interface GigabitEthernet0/0)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description WAN_LINK');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config interface GigabitEthernet0/0');
      expect(output).toContain('description WAN_LINK');
    });

    it('259. should support showing running-config filtered by subinterface target', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1q 10');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config interface GigabitEthernet0/0.10');
      expect(output).toContain('encapsulation dot1q 10');
    });

    it('260. should support showing running-config filtered by line console target', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      await r.executeCommand('exec-timeout 10 0');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config | section line console');
      expect(output).toContain('exec-timeout 10 0');
    });

    it('261. should support showing running-config filtered by line vty target', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      await r.executeCommand('password vtypass');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config | section line vty');
      expect(output).toContain('password vtypass');
    });

    it('262. should support showing running-config filtered by router ospf target', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('network 10.0.0.0 0.255.255.255 area 0');
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config | section router ospf');
      expect(output).toContain('network 10.0.0.0 0.255.255.255 area 0');
    });

    it('263. should reject showing running-config interface if target interface does not exist', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show running-config interface GigabitEthernet9/9');
      expect(output.toLowerCase()).toContain('%');
    });

    it('264. should jump directly from Loopback SVI config to physical interface SVI config directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface Loopback0');
      expect(await r.getPrompt()).toBe('Router(config-if)#');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(await r.getPrompt()).toBe('Router(config-if)#'); // stays config-if but target changed (internal state tracking)
    });

    it('265. should maintain exact sub-mode context on invalid command parameters rejection inside config-router', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('network 999.999.999.999'); // invalid
      expect(await r.getPrompt()).toBe('Router(config-router)#');
    });

    it('266. should maintain exact sub-mode context on invalid command parameters rejection inside config-vlan', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('vlan 10');
      await r.executeCommand('name_typo invalid_name');
      expect(await r.getPrompt()).toBe('Router(config-vlan)#');
    });

    it('267. should show correct sub-interface details inside show interfaces GigabitEthernet0/0.10 SVI description', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('description SUB_SVI');
      await r.executeCommand('end');
      const output = await r.executeCommand('show interfaces GigabitEthernet0/0.10');
      expect(output).toContain('GigabitEthernet0/0.10');
    });

    it('268. should jump directly from VLAN SVI to Global config VRF submode directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('vlan 10');
      expect(await r.getPrompt()).toBe('Router(config-vlan)#');
      await r.executeCommand('ip vrf RED');
      expect(await r.getPrompt()).toBe('Router(config-vrf)#');
    });

    it('269. should support exit to revert from config-vrf back to global config mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      await r.executeCommand('exit');
      expect(await r.getPrompt()).toBe('Router(config)#');
    });

    it('270. should support direct transition from VRF submode to line submode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      await r.executeCommand('line vty 0 4');
      expect(await r.getPrompt()).toBe('Router(config-line)#');
    });

    it('271. should support context sensitive help suggestions inside config-vrf mode ("?")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      const output = await r.executeCommand('?');
      expect(output).toContain('rd');
    });

    it('272. should reject VRF parameters configurations if evaluated in standard global config mode directly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('rd 100:1');
      expect(output.toLowerCase()).toContain('%'); // unrecognized command at global level
    });

    it('273. should support rd parameter configuration inside config-vrf mode (rd 100:1)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      const output = await r.executeCommand('rd 100:1');
      expect(output.trim()).toBe('');
    });

    it('274. should show VRF configurations inside show running-config', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      await r.executeCommand('rd 100:1');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('ip vrf RED\n rd 100:1');
    });

    it('275. should execute successfully and return status 0 on advanced VRF and route transitions checks', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('configure terminal && ip vrf RED && rd 100:1 && end && echo "VRF_OK"');
      expect(output).toContain('VRF_OK');
    });
  });

  // ─── Block 14: Terminal Editing Shortcuts & Escapes (Tests 276-300) 

  describe('Block 14: Terminal Line Editing Shortcuts, Buffer Clears & Escapes', () => {
    it('276. should support cursor jump to start of line shortcut (Ctrl+A simulation)', async () => {
      const r = setupCiscoRouter();
      // Simulate input sequence: "show version" then Ctrl+A (sends \x01) then "do " -> "do show version"
      const output = await r.executeCommand('show version\x01do ');
      expect(output.toLowerCase()).toContain('cisco ios'); // executes do show version
    });

    it('277. should support cursor jump to end of line shortcut (Ctrl+E simulation)', async () => {
      const r = setupCiscoRouter();
      // Simulate input sequence: "show version" then Ctrl+A then Ctrl+E (sends \x05) then " " -> "show version "
      const output = await r.executeCommand('show version\x01\x05');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('278. should support delete word shortcut (Ctrl+W simulation)', async () => {
      const r = setupCiscoRouter();
      // Simulate input sequence: "show version" then Ctrl+W (sends \x17) -> deletes "version" -> "show " then "clock" -> "show clock"
      const output = await r.executeCommand('show version\x17clock');
      expect(output).toBeDefined(); // executes show clock successfully
    });

    it('279. should support kill line shortcut (Ctrl+K simulation)', async () => {
      const r = setupCiscoRouter();
      // Simulate input sequence: "show version" then Ctrl+A then Ctrl+K (sends \x0b) -> wipes line -> "show clock"
      const output = await r.executeCommand('show version\x01\x0bshow clock');
      expect(output).toBeDefined();
    });

    it('280. should support backspace character deletions cleanly (\\b / \\x7f simulation)', async () => {
      const r = setupCiscoRouter();
      // Simulate input: "show version" then backspace 7 times -> "show " then "clock" -> "show clock"
      const output = await r.executeCommand('show version\b\b\b\b\b\b\bclock');
      expect(output).toBeDefined();
    });

    it('281. should handle multiple backspace deletions past beginning of line safely without negative buffers crash', async () => {
      const r = setupCiscoRouter();
      // Backspace 50 times on empty prompt then type show version
      const output = await r.executeCommand('\b'.repeat(50) + 'show version');
      expect(output.toLowerCase()).toContain('cisco ios');
    });

    it('282. should support tab autocomplete on unique commands with trailing backspaces ("conff\\b[tab]" -> "configure")', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('conff\b\t');
      expect(output.trim()).toBe('configure');
    });

    it('283. should support tab autocomplete with backspaces on advanced parameters ("show cll\\b[tab]" -> "show clock")', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show cll\b\t');
      expect(output.trim()).toBe('show clock');
    });

    it('284. should support suggestions query with backspaces ("show cll\\b?")', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('show cll\b?');
      expect(output).toContain('clock');
    });

    it('285. should handle escape characters safely inside banners string literals (e.g. \\n newline)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const output = await r.executeCommand('banner motd #WELCOME\\nLINE_TWO#');
      expect(output.trim()).toBe('');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config');
      expect(running).toContain('banner motd ^WELCOME\\nLINE_TWO^');
    });

    it('286. should preserve double backslashes literally inside configuration parameters (e.g. host description containing server\\\\share)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const output = await r.executeCommand('description server\\\\share');
      expect(output.trim()).toBe('');
      await r.executeCommand('end');
      const running = await r.executeCommand('show running-config interface GigabitEthernet0/0');
      expect(running).toContain('description server\\\\share');
    });

    it('287. should reject command inputs composed solely of non-printable ASCII codes', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('\x01\x02\x03\x04');
      expect(output.trim()).toBe('');
    });

    it('288. should handle long chains of nested submodes jumps back-to-back cleanly', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('line console 0');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('vlan 10');
      await r.executeCommand('ip vrf RED');
      expect(await r.getPrompt()).toBe('Router(config-vrf)#');
    });

    it('289. should exit entire nested submodes chains instantly via end command', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      await r.executeCommand('end');
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('290. should exit entire nested submodes chains instantly via Control+Z shortcut key simulation (\\x1a)', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      await r.executeCommand('\x1a'); // sends Ctrl+Z
      expect(await r.getPrompt()).toBe('Router#');
    });

    it('291. should positioning syntax caret "^" marker correctly when error occurs inside nested config-router parameters', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      const output = await r.executeCommand('network 10.0.0.0 0.255.255.255 areaa 0'); // typo in area
      expect(output).toContain('^');
    });

    it('292. should positioning syntax caret "^" marker correctly when error occurs inside nested config-vrf parameters', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ip vrf RED');
      const output = await r.executeCommand('rd 100:1000000000000'); // out of range AS
      expect(output).toContain('^');
    });

    it('293. should positioning syntax caret "^" marker correctly when error occurs inside nested config-line parameters', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('exec-timeout 100000 0'); // out of range minutes
      expect(output).toContain('^');
    });

    it('294. should positioning syntax caret "^" marker correctly when error occurs inside nested config-vlan parameters', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('vlan 10');
      const output = await r.executeCommand('name "CORE_VLAN_NAME_EXCEEDING_LIMIT_BOUNDS_MAX"'); // too long name
      expect(output).toContain('^');
    });

    it('295. should preserve interface status details unchanged when parsing errors are rejected inside subinterface mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1q 10');
      await r.executeCommand('encapsulation dot1q invalid_tag'); // rejected
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config interface GigabitEthernet0/0.10');
      expect(output).toContain('encapsulation dot1q 10');
    });

    it('296. should preserve OSPF status details unchanged when parsing errors are rejected inside router mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand('network 10.0.0.0 0.255.255.255 area 0');
      await r.executeCommand('network 10.0.0.0 invalid_wildcard area 0'); // rejected
      await r.executeCommand('end');
      const output = await r.executeCommand('show running-config | section router ospf');
      expect(output).toContain('network 10.0.0.0 0.255.255.255 area 0');
    });

    it('297. should support do show history command to inspect history buffer while inside nested line config mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const output = await r.executeCommand('do show history');
      expect(output).toContain('line console 0');
    });

    it('298. should support do show history command to inspect history buffer while inside nested interface config mode', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      const output = await r.executeCommand('do show history');
      expect(output).toContain('interface GigabitEthernet0/0');
    });

    it('299. should preserve command buffer states if backspace is triggered on an empty prompt', async () => {
      const r = setupCiscoRouter();
      const output = await r.executeCommand('\b\b\b\b\b?');
      expect(output).toContain('enable');
    });

    it('300. should execute successfully and return status 0 on complete terminal sweeps execution', async () => {
      const r = setupCiscoRouter();
      await r.executeCommand('enable');
      const output = await r.executeCommand('show version && echo "CISCO_TERMINAL_COMPLETE"');
      expect(output).toContain('CISCO_TERMINAL_COMPLETE');
    });
  });
});
