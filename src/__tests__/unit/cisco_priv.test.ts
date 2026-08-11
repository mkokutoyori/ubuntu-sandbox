/**
 * TDD Unit Tests for Cisco IOS Privilege Levels, RBAC, Line Security, and AAA.
 *
 * Covers:
 *  - Privilege Levels: Default Level 1 (User EXEC), Level 15 (Privileged EXEC), Level 0, and Custom Levels (2–14)
 *  - Authentication & Passwords: `enable password`, `enable secret` (MD5/Type 5 precedence over plain text),
 *                                `enable <level>` transitions, incorrect password responses (`% Bad secrets`)
 *  - Password Encryption: `service password-encryption` (Type 7 reversible hashing) & `no service password-encryption`
 *  - User Management: `username <name> privilege <level> secret <pwd>`, custom user login sessions
 *  - Custom Command Delegation (RBAC): `privilege exec level <lvl> <cmd>`, `privilege configure level <lvl> <cmd>`
 *  - Line Security: `line console 0`, `line vty 0 4`, `login`, `login local`, `privilege level <lvl>`, `exec-timeout`
 *  - AAA Framework: `aaa new-model`, `aaa authentication login default local`, `aaa authorization exec`, `aaa authorization commands`
 *  - Parser Authorization Enforcements: Command rejection for unauthorized levels (`% Command authorization failed`)
 *  - Security Auditing & Inspection: `show privilege`, `show running-config` password masking, `show users`
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ═══════════════════════════════════════════════════════════════════
// SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════

function createTestRouter(name = 'R1') {
  return new CiscoRouter(name, 0, 0);
}

function createTestSwitch(name = 'SW1') {
  return new CiscoSwitch('sw-id', name, 24, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS PRIVILEGE & AAA TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS Security: Privilege Levels, RBAC & AAA Architecture', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── 1. DEFAULT PRIVILEGE LEVELS & TRANSITIONS ───────────────────

  describe('1. Default Privilege Levels & Mode Transitions', () => {
    it('1.1 Should default to Privilege Level 1 (User EXEC mode) on unauthenticated initial session', async () => {
      const r = createTestRouter();
      expect(r.getPrompt()).toBe('R1>');

      const res = await r.executeCommand('show privilege');
      expect(res).toContain('Current privilege level is 1');
    });

    it('1.2 Should transition to Privilege Level 15 (Privileged EXEC mode) with "enable"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');

      expect(r.getPrompt()).toBe('R1#');
      const res = await r.executeCommand('show privilege');
      expect(res).toContain('Current privilege level is 15');
    });

    it('1.3 Should drop from Level 15 back to Level 1 with "disable"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      expect(r.getPrompt()).toBe('R1#');

      await r.executeCommand('disable');
      expect(r.getPrompt()).toBe('R1>');

      const res = await r.executeCommand('show privilege');
      expect(res).toContain('Current privilege level is 1');
    });

    it('1.4 Should support Level 0 emergency/minimal mode transition', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('disable 0');

      const res = await r.executeCommand('show privilege');
      expect(res).toContain('Current privilege level is 0');
    });
  });

  // ─── 2. ENABLE PASSWORDS & SECRET PRECEDENCE ─────────────────────

  describe('2. Enable Passwords, Secrets & Precedence Rules', () => {
    it('2.1 Should prompt for password on "enable" when "enable password" is configured', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable password Cisco123');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      // Attempt enable without password or wrong password
      const badRes = await r.executeCommand('enable', { passwordInput: 'WrongPass' });
      expect(badRes).toContain('% Bad secrets');
      expect(r.getPrompt()).toBe('R1>');

      // Correct password
      const goodRes = await r.executeCommand('enable', { passwordInput: 'Cisco123' });
      expect(goodRes).not.toContain('% Bad secrets');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('2.2 "enable secret" MUST take precedence over "enable password"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable password PlainTextPassword');
      await r.executeCommand('enable secret StrongSecretPass');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      // Trying the plain enable password MUST fail because secret overrides it
      const tryPlain = await r.executeCommand('enable', { passwordInput: 'PlainTextPassword' });
      expect(tryPlain).toContain('% Bad secrets');
      expect(r.getPrompt()).toBe('R1>');

      // Trying the secret password MUST succeed
      const trySecret = await r.executeCommand('enable', { passwordInput: 'StrongSecretPass' });
      expect(r.getPrompt()).toBe('R1#');
    });

    it('2.3 Should lock or deny enable after 3 consecutive bad attempts', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret Secret123');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      await r.executeCommand('enable', { passwordInput: 'bad1' });
      await r.executeCommand('enable', { passwordInput: 'bad2' });
      const res = await r.executeCommand('enable', { passwordInput: 'bad3' });

      expect(res).toContain('% Bad secrets');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('2.4 Should allow setting specific level enable secret ("enable secret level 5 <pwd>")', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret level 5 Level5Secret');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      await r.executeCommand('enable 5', { passwordInput: 'Level5Secret' });

      expect(r.getPrompt()).toBe('R1#');
      const res = await r.executeCommand('show privilege');
      expect(res).toContain('Current privilege level is 5');
    });
  });

  // ─── 3. PASSWORD ENCRYPTION (SERVICE PASSWORD-ENCRYPTION) ────────

  describe('3. Password Obfuscation (Type 7 / Service Password-Encryption)', () => {
    it('3.1 Should display plain text enable password in running-config by default', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable password ClearText123');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).toContain('enable password ClearText123');
    });

    it('3.2 "service password-encryption" MUST encrypt plain text passwords to Type 7 hashes', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable password ClearText123');
      await r.executeCommand('service password-encryption');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('enable password ClearText123');
      expect(config).toMatch(/enable password 7 [0-9A-Fa-f]+/);
    });

    it('3.3 "enable secret" MUST always be hashed with MD5/Type 5 or Scrypt, ignoring service password-encryption state', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable secret MySecretPass');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('MySecretPass');
      expect(config).toMatch(/enable secret 5 \$1\$.+/);
    });
  });

  // ─── 4. LOCAL USER DATABASE & PRIVILEGE LEVELS ───────────────────

  describe('4. Local User Accounts & Privilege Level Assignment', () => {
    it('4.1 Should create local user with custom privilege level and secret', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const res = await r.executeCommand('username operator privilege 5 secret OpSecret123');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('username operator privilege 5 secret 5');
    });

    it('4.2 Logging in as custom user MUST automatically assign user to assigned privilege level', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username netadmin privilege 15 secret AdminPass');
      await r.executeCommand('username junior privilege 3 secret JuniorPass');
      await r.executeCommand('end');

      // Simulate session login as 'junior'
      await r.loginAs('junior', 'JuniorPass');
      expect(r.getPrompt()).toBe('R1#');

      let privRes = await r.executeCommand('show privilege');
      expect(privRes).toContain('Current privilege level is 3');

      // Simulate session login as 'netadmin'
      await r.loginAs('netadmin', 'AdminPass');
      privRes = await r.executeCommand('show privilege');
      expect(privRes).toContain('Current privilege level is 15');
    });

    it('4.3 Should default username privilege level to 1 if privilege parameter is omitted', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username guest secret GuestPass');
      await r.executeCommand('end');

      await r.loginAs('guest', 'GuestPass');
      const privRes = await r.executeCommand('show privilege');
      expect(privRes).toContain('Current privilege level is 1');
    });

    it('4.4 Should remove user with "no username <name>"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username tempuser secret Pass123');
      await r.executeCommand('no username tempuser');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('username tempuser');
    });
  });

  // ─── 5. CUSTOM ROLE-BASED ACCESS CONTROL (RBAC) ─────────────────

  describe('5. Role-Based Access Control (RBAC): Command Privilege Customization', () => {
    it('5.1 Should deny Level 1 user from executing Level 15 commands (e.g. "configure terminal")', async () => {
      const r = createTestRouter();
      // Initially in Level 1
      const res = await r.executeCommand('configure terminal');

      expect(res).toContain('% Command authorization failed');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('5.2 Should elevate specific command privilege level with "privilege exec level <lvl> <cmd>"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      // Allow level 1 users to execute "ping" and "show ip interface brief"
      await r.executeCommand('privilege exec level 1 show ip interface brief');
      await r.executeCommand('end');
      await r.executeCommand('disable'); // Back to level 1

      const res = await r.executeCommand('show ip interface brief');
      expect(res).not.toContain('% Command authorization failed');
      expect(res).toContain('Interface');
    });

    it('5.3 Should delegate subcommands in config mode to intermediate privilege levels', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username tech privilege 7 secret TechPass');

      // Grant Level 7 access to configure interface reboot/shutdown
      await r.executeCommand('privilege configure level 7 interface');
      await r.executeCommand('privilege interface level 7 shutdown');
      await r.executeCommand('privilege interface level 7 no shutdown');
      await r.executeCommand('end');

      // Login as tech (Level 7)
      await r.loginAs('tech', 'TechPass');
      await r.executeCommand('configure terminal');
      expect(r.getPrompt()).toBe('R1(config)#');

      const ifaceRes = await r.executeCommand('interface GigabitEthernet0/0');
      expect(r.getPrompt()).toBe('R1(config-if)#');

      const shutRes = await r.executeCommand('shutdown');
      expect(shutRes).toBe('');

      // Attempting unassigned command (e.g., router ospf) MUST fail for level 7
      const unassignedRes = await r.executeCommand('router ospf 1');
      expect(unassignedRes).toContain('% Command authorization failed');
    });
  });

  // ─── 6. LINE SECURITY & AUTHENTICATION (CONSOLE & VTY) ───────────

  describe('6. Line Security: Console, VTY and Access Control', () => {
    it('6.1 Should configure line password authentication on VTY lines', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      await r.executeCommand('password VtySecret123');
      await r.executeCommand('login');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).toContain('line vty 0 4');
      expect(config).toContain('login');
    });

    it('6.2 "login local" MUST enforce authentication against the local username database', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin1 secret AdminSecret');
      await r.executeCommand('line console 0');
      await r.executeCommand('login local');
      await r.executeCommand('end');

      // Authenticate via console line
      const failedAuth = await r.authenticateLine('console', { user: 'admin1', pass: 'WrongPass' });
      expect(failedAuth).toBe(false);

      const successAuth = await r.authenticateLine('console', { user: 'admin1', pass: 'AdminSecret' });
      expect(successAuth).toBe(true);
    });

    it('6.3 Should set default privilege level for incoming line connections', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      await r.executeCommand('privilege level 15');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).toContain('privilege level 15');
    });

    it('6.4 Should configure exec-timeout on console/vty lines', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line console 0');
      const res = await r.executeCommand('exec-timeout 5 30'); // 5 minutes, 30 seconds

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('exec-timeout 5 30');
    });
  });

  // ─── 7. AAA ARCHITECTURE (NEW-MODEL) ─────────────────────────────

  describe('7. AAA Architecture: Authentication & Authorization Enforcements', () => {
    it('7.1 Should enable AAA framework with "aaa new-model"', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const res = await r.executeCommand('aaa new-model');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('aaa new-model');
    });

    it('7.2 Should configure default login authentication using local database ("aaa authentication login default local")', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      const res = await r.executeCommand('aaa authentication login default local');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('aaa authentication login default local');
    });

    it('7.3 Should configure EXEC authorization with local database ("aaa authorization exec default local")', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      const res = await r.executeCommand('aaa authorization exec default local');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('aaa authorization exec default local');
    });

    it('7.4 Should enforce command authorization at specified privilege levels ("aaa authorization commands 15 default local")', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      const res = await r.executeCommand('aaa authorization commands 15 default local');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('aaa authorization commands 15 default local');
    });

    it('7.5 Disabling AAA with "no aaa new-model" MUST restore legacy line password behavior', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      await r.executeCommand('no aaa new-model');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('aaa new-model');
    });
  });

  // ─── 8. SECURITY AUDITING & INSPECTION COMMANDS ─────────────────

  describe('8. Security Auditing & Inspection Commands', () => {
    it('8.1 "show privilege" MUST display exact active privilege level in real-time', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');

      let res = await r.executeCommand('show privilege');
      expect(res).toBe('Current privilege level is 15');

      await r.executeCommand('disable');
      res = await r.executeCommand('show privilege');
      expect(res).toBe('Current privilege level is 1');
    });

    it('8.2 "show users" MUST list active connected sessions and privilege levels', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username auditor privilege 15 secret AudPass');
      await r.executeCommand('end');

      await r.loginAs('auditor', 'AudPass');
      const res = await r.executeCommand('show users');

      expect(res).toContain('Line');
      expect(res).toContain('User');
      expect(res).toContain('auditor');
    });

    it('8.3 "show running-config" MUST sanitize sensitive secret hashes from non-privileged execution', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('privilege exec level 1 show running-config');
      await r.executeCommand('enable secret TopSecret123');
      await r.executeCommand('end');
      await r.executeCommand('disable'); // Level 1

      const res = await r.executeCommand('show running-config');
      expect(res).not.toContain('TopSecret123');
    });
  });

  // ─── 9. EXECUTION LOCKOUTS & BANNER SECURITY ─────────────────────

  describe('9. Login Banners & Security Warning Displays', () => {
    it('9.1 Should configure MOTD (Message of the Day) banner', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const res = await r.executeCommand('banner motd # UNAUTHORIZED ACCESS PROHIBITED #');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('banner motd');
      expect(config).toContain('UNAUTHORIZED ACCESS PROHIBITED');
    });

    it('9.2 Should display MOTD banner upon new user connection', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd # WARNING: PRIVATE SYSTEM #');
      await r.executeCommand('end');

      const bannerOutput = r.getBanner();
      expect(bannerOutput).toContain('WARNING: PRIVATE SYSTEM');
    });
  });

  // ─── 10. ERROR HANDLING & PARSER SYNTAX VALIDATION ───────────────

  describe('10. Edge Cases, Malformed Commands & Error Prompts', () => {
    it('10.1 Should reject privilege level out of range 0-15', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      const resHigh = await r.executeCommand('privilege exec level 16 show ip route');
      expect(resHigh).toContain('% Invalid input detected at \'^\' marker.');

      const resNegative = await r.executeCommand('username test privilege -1 secret Pass');
      expect(resNegative).toContain('% Invalid input');
    });

    it('10.2 Should handle incomplete "enable secret" syntax gracefully', async () => {
      const r = createTestRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      const res = await r.executeCommand('enable secret');
      expect(res).toContain('% Incomplete command.');
    });

    it('10.3 Should enforce identical security behavior on Cisco Switches as Routers', async () => {
      const sw = createTestSwitch();
      expect(sw.getPrompt()).toBe('SW1>');

      await sw.executeCommand('enable');
      expect(sw.getPrompt()).toBe('SW1#');

      await sw.executeCommand('configure terminal');
      await sw.executeCommand('enable secret SwitchSecret123');
      await sw.executeCommand('end');
      await sw.executeCommand('disable');

      const tryFail = await sw.executeCommand('enable', { passwordInput: 'Wrong' });
      expect(tryFail).toContain('% Bad secrets');

      const tryOK = await sw.executeCommand('enable', { passwordInput: 'SwitchSecret123' });
      expect(sw.getPrompt()).toBe('SW1#');
    });
  });
});
