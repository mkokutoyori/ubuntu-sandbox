/**
 * TDD Unit Tests for Advanced Cisco IOS Security & Privilege Mechanisms.
 *
 * Covers:
 *  - Cisco Role-Based CLI (Parser Views): `parser view <name>`, `enable view <name>`, `root view`
 *  - Modern Password Hashing: Type 8 (SHA-256) and Type 9 (Scrypt) via `algorithm-type`
 *  - Privilege Reset Mechanics: `privilege <mode> reset <command>`
 *  - Brute-Force & Lockout Policies: `login block-for <sec> attempts <num> within <sec>`, quiet period enforcement
 *  - Line Auto-Commands: `autocommand <cmd>` execution on session initiation
 *  - AAA Fallback Mechanism: TACACS+/RADIUS unreachable fallback to `local` database
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ═══════════════════════════════════════════════════════════════════
// SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════

function createRouter(name = 'R1') {
  return new CiscoRouter(name, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════
// ADVANCED PRIVILEGE & SECURITY TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS Security: Advanced Privilege Mechanisms & Parser Views', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── 1. PARSER VIEWS (ROLE-BASED CLI ACCESS) ─────────────────────

  describe('1. Cisco Role-Based CLI: Parser Views & "enable view"', () => {
    it('1.1 Should configure Root View secret and create a custom Parser View', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      // Enable AAA is required for Parser Views in Cisco IOS
      await r.executeCommand('aaa new-model');
      await r.executeCommand('enable view'); // Enables root view configuration
      
      const res = await r.executeCommand('parser view HELPDESK_VIEW');
      expect(r.getPrompt()).toMatch(/R1\(config-view\)#/);
      expect(res).toBe('');

      // Set secret for this view
      await r.executeCommand('secret HelpdeskPass123');
      // Grant specific commands
      await r.executeCommand('commands exec include show ip route');
      await r.executeCommand('commands exec include ping');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).toContain('parser view HELPDESK_VIEW');
      expect(config).toContain('commands exec include show ip route');
    });

    it('1.2 Should switch to custom Parser View using "enable view <view-name>"', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      await r.executeCommand('enable view');
      await r.executeCommand('parser view HELPDESK_VIEW');
      await r.executeCommand('secret HelpdeskPass123');
      await r.executeCommand('commands exec include show ip route');
      await r.executeCommand('commands exec include ping');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      // Switch view
      const viewRes = await r.executeCommand('enable view HELPDESK_VIEW', { passwordInput: 'HelpdeskPass123' });
      expect(viewRes).not.toContain('% Bad secrets');

      const showView = await r.executeCommand('show parser view');
      expect(showView).toContain('Current view is \'HELPDESK_VIEW\'');
    });

    it('1.3 Parser View MUST restrict execution to EXCLUSIVELY included commands', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('aaa new-model');
      await r.executeCommand('enable view');
      await r.executeCommand('parser view LIMITED_VIEW');
      await r.executeCommand('secret Pass123');
      await r.executeCommand('commands exec include ping');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      await r.executeCommand('enable view LIMITED_VIEW', { passwordInput: 'Pass123' });

      // Ping MUST succeed
      const pingRes = await r.executeCommand('ping 127.0.0.1');
      expect(pingRes).not.toContain('% Command authorization failed');

      // Unincluded command (e.g., show ip route or configure terminal) MUST fail
      const unincludedRes = await r.executeCommand('show ip route');
      expect(unincludedRes).toContain('% Command authorization failed');
    });
  });

  // ─── 2. MODERN PASSWORD HASHING (TYPE 8 SHA-256 & TYPE 9 SCRYPT) ──

  describe('2. Modern Hashing Algorithms: Type 8 (SHA-256) & Type 9 (Scrypt)', () => {
    it('2.1 Should generate Type 8 SHA-256 hash with "enable algorithm-type sha256 secret"', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable algorithm-type sha256 secret ShaPass123');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('ShaPass123');
      // Type 8 hashes start with 'enable secret 8 $'
      expect(config).toMatch(/enable secret 8 \$8\$.+/);
    });

    it('2.2 Should generate Type 9 Scrypt hash with "enable algorithm-type scrypt secret"', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable algorithm-type scrypt secret ScryptPass123');
      await r.executeCommand('end');

      const config = await r.executeCommand('show running-config');
      expect(config).not.toContain('ScryptPass123');
      // Type 9 hashes start with 'enable secret 9 $'
      expect(config).toMatch(/enable secret 9 \$9\$.+/);
    });

    it('2.3 Authentication MUST succeed using plain password against Type 9 Scrypt hash', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('enable algorithm-type scrypt secret ScryptPass123');
      await r.executeCommand('end');
      await r.executeCommand('disable');

      const res = await r.executeCommand('enable', { passwordInput: 'ScryptPass123' });
      expect(r.getPrompt()).toBe('R1#');
      expect(res).not.toContain('% Bad secrets');
    });
  });

  // ─── 3. PRIVILEGE RESET MECHANICS ───────────────────────────────

  describe('3. Privilege Reset Mechanics: "privilege <mode> reset <cmd>"', () => {
    it('3.1 Should reset a modified command back to default Level 15 using "privilege <mode> reset <cmd>"', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      // Move 'show clock' to Level 1
      await r.executeCommand('privilege exec level 1 show clock');
      
      // Reset 'show clock' back to default Level 15
      const res = await r.executeCommand('privilege exec reset show clock');
      expect(res).toBe('');

      await r.executeCommand('end');
      await r.executeCommand('disable'); // Level 1

      // Now Level 1 user should no longer be able to run 'show clock' if it was originally Level 15
      const execRes = await r.executeCommand('show clock');
      expect(execRes).toContain('% Command authorization failed');
    });
  });

  // ─── 4. BRUTE-FORCE PROTECTION & LOCKOUT POLICIES ────────────────

  describe('4. Brute-Force Protection & Login Quiet Period', () => {
    it('4.1 Should configure login lockout policy ("login block-for <sec> attempts <num> within <sec>")', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const res = await r.executeCommand('login block-for 60 attempts 3 within 30');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('login block-for 60 attempts 3 within 30');
    });

    it('4.2 MUST trigger Quiet Period and reject ALL login attempts when threshold is exceeded', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin secret CorrectPass');
      await r.executeCommand('line console 0');
      await r.executeCommand('login local');
      await r.executeCommand('exit');
      await r.executeCommand('login block-for 60 attempts 3 within 30');
      await r.executeCommand('end');

      // Fail 3 times within 30s
      await r.authenticateLine('console', { user: 'admin', pass: 'wrong1' });
      await r.authenticateLine('console', { user: 'admin', pass: 'wrong2' });
      await r.authenticateLine('console', { user: 'admin', pass: 'wrong3' });

      // 4th attempt with CORRECT password MUST be blocked due to quiet period
      const quietAttempt = await r.authenticateLine('console', { user: 'admin', pass: 'CorrectPass' });
      expect(quietAttempt).toBe(false);

      const logs = Logger.getLogs();
      expect(logs.some(l => l.includes('QUIET_MODE_ON') || l.includes('login quiet period'))).toBe(true);
    });
  });

  // ─── 5. LINE AUTO-COMMANDS ───────────────────────────────────────

  describe('5. Line Auto-Commands Execution', () => {
    it('5.1 Should configure "autocommand" on VTY line to auto-execute command upon login', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('line vty 0 4');
      const res = await r.executeCommand('autocommand show status');

      expect(res).toBe('');
      const config = await r.executeCommand('show running-config');
      expect(config).toContain('autocommand show status');
    });
  });

  // ─── 6. AAA FALLBACK MECHANISMS ──────────────────────────────────

  describe('6. AAA Fallback to Local Database on Server Failure', () => {
    it('6.1 Should fallback to local database when TACACS+/RADIUS server is unreachable', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username fallbackadmin secret FallbackPass123');
      await r.executeCommand('aaa new-model');
      // Configure AAA with unreachable TACACS+ group, falling back to local
      await r.executeCommand('aaa authentication login default group tacacs+ local');
      await r.executeCommand('end');

      // Simulate TACACS+ server down -> Fallback MUST authenticate against local db successfully
      const authResult = await r.authenticateAAA({
        user: 'fallbackadmin',
        pass: 'FallbackPass123',
        serverAvailable: false, // Server down
      });

      expect(authResult.success).toBe(true);
      expect(authResult.methodUsed).toBe('local');
    });
  });
});
