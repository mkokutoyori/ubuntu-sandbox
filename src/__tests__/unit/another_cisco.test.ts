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
      expect(pingRes).not.toContain("% Invalid input detected at '^' marker.");

      /**
       * Une vue REMPLACE l'arbre visible : une commande qui n'y est pas
       * n'est pas « refusee », elle est ABSENTE, et IOS rend le meme
       * message que pour une commande inexistante. Les transcriptions de
       * vues montrent bien `% Invalid input detected` sur `show run`,
       * `conf t` et `ping` hors vue. `% Command authorization failed`
       * appartient a l'autorisation AAA par commande, un autre
       * mecanisme.
       */
      const unincludedRes = await r.executeCommand('show ip route');
      expect(unincludedRes).toContain("% Invalid input detected at '^' marker.");
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
    /**
     * La commande de reference est celle de la documentation Cisco
     * elle-meme : « to remove the command privilege exec level reload
     * command from the configuration and return the reload command to
     * its default privilege of 15 use the privilege exec reset reload
     * command ». `show clock` ne conviendrait pas comme cobaye — c'est
     * une commande de NIVEAU 1 sur un vrai IOS (`Router>show clock`
     * repond), donc la remettre a son defaut la laisse accessible et le
     * test ne distinguerait rien.
     */
    it('3.1 Should reset a modified command back to default Level 15 using "privilege <mode> reset <cmd>"', async () => {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      await r.executeCommand('privilege exec level 1 reload');
      expect(await r.executeCommand('do show running-config'))
        .toContain('privilege exec level 1 reload');

      const res = await r.executeCommand('privilege exec reset reload');
      expect(res).toBe('');

      await r.executeCommand('end');
      // La regle disparait de la configuration : sans ce retrait elle
      // renaitrait au rechargement de la topologie, que l'import rejoue.
      expect(await r.executeCommand('show running-config'))
        .not.toContain('privilege exec level 1 reload');

      await r.executeCommand('disable'); // Level 1
      const execRes = await r.executeCommand('reload');
      expect(execRes).toContain("% Invalid input detected at '^' marker.");
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

    /**
     * Le mode silencieux ferme les lignes RESEAU, jamais la console.
     * Cisco l'ecrit dans le guide de `login block-for` : « when the
     * device is in quiet mode, all login requests are denied and the
     * only available connection is through the console », et la
     * fonction ne se configure que « for Telnet or SSH virtual
     * connections ». Une console fermee par le mode silencieux
     * enfermerait l'operateur dehors, ce que ce mecanisme existe
     * justement pour eviter ; le cas console ci-dessous est donc la
     * moitie qui compte.
     */
    async function labyrintheQuietMode() {
      const r = createRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin secret CorrectPass');
      await r.executeCommand('line console 0');
      await r.executeCommand('login local');
      await r.executeCommand('exit');
      await r.executeCommand('line vty 0 4');
      await r.executeCommand('login local');
      await r.executeCommand('exit');
      await r.executeCommand('login block-for 60 attempts 3 within 30');
      await r.executeCommand('end');
      return r;
    }

    it('4.2 MUST trigger Quiet Period and reject ALL vty login attempts when threshold is exceeded', async () => {
      const r = await labyrintheQuietMode();

      // Fail 3 times within 30s
      expect(await r.authenticateLine('vty', { user: 'admin', pass: 'wrong1' })).toBe(false);
      expect(await r.authenticateLine('vty', { user: 'admin', pass: 'wrong2' })).toBe(false);
      expect(await r.authenticateLine('vty', { user: 'admin', pass: 'wrong3' })).toBe(false);

      expect(r.getLoginBlocker()?.isBlocked()).toBe(true);

      // 4th attempt with CORRECT password MUST be blocked due to quiet period
      const quietAttempt = await r.authenticateLine('vty', { user: 'admin', pass: 'CorrectPass' });
      expect(quietAttempt).toBe(false);
    });

    it('4.3 The console stays open during the quiet period — it is the way back in', async () => {
      const r = await labyrintheQuietMode();
      await r.authenticateLine('vty', { user: 'admin', pass: 'wrong1' });
      await r.authenticateLine('vty', { user: 'admin', pass: 'wrong2' });
      await r.authenticateLine('vty', { user: 'admin', pass: 'wrong3' });
      expect(r.getLoginBlocker()?.isBlocked()).toBe(true);

      expect(await r.authenticateLine('console', { user: 'admin', pass: 'CorrectPass' })).toBe(true);
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
