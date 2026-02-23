/**
 * TDD Tests for Linux UFW (Uncomplicated Firewall)
 * ~40 scénarios couvrant enable/disable, rules, status, logging, etc.
 * Fidèle au comportement réel de ufw sur Ubuntu/Debian.
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: UFW — Uncomplicated Firewall
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: UFW (Uncomplicated Firewall)', () => {

  // ─── 8.1: ufw enable / disable / status ────────────────────────────

  describe('G8-01: Activation et statut', () => {
    it('should show inactive status by default', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw status');
      expect(out).toContain('Status: inactive');
    });

    it('should enable ufw', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw enable');
      expect(out).toContain('Firewall is active and enabled on system startup');
    });

    it('should show active status after enable', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw status');
      expect(out).toContain('Status: active');
    });

    it('should disable ufw', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw disable');
      expect(out).toContain('Firewall stopped and disabled on system startup');
    });

    it('should show inactive after disable', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw disable');
      const out = await server.executeCommand('ufw status');
      expect(out).toContain('Status: inactive');
    });

    it('should require root/sudo for ufw commands', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      const out = await pc.executeCommand('ufw status');
      expect(out).toContain('Permission denied');
    });

    it('should work with sudo on non-root', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      const out = await pc.executeCommand('sudo ufw status');
      expect(out).toContain('Status: inactive');
    });

    it('should reset ufw to default state', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');

      const out = await server.executeCommand('ufw reset');
      expect(out).toContain('Resetting all rules to installed defaults');

      // After reset, ufw should be disabled and rules cleared
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('Status: inactive');
    });

    it('should reload ufw rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw reload');
      expect(out).toContain('Firewall reloaded');
    });
  });

  // ─── 8.2: Default policies ─────────────────────────────────────────

  describe('G8-02: Politiques par défaut', () => {
    it('should set default incoming policy to deny', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw default deny incoming');
      expect(out).toContain('Default incoming policy changed to');
      expect(out).toContain('deny');
    });

    it('should set default outgoing policy to allow', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw default allow outgoing');
      expect(out).toContain('Default outgoing policy changed to');
      expect(out).toContain('allow');
    });

    it('should set default incoming policy to reject', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw default reject incoming');
      expect(out).toContain('Default incoming policy changed to');
      expect(out).toContain('reject');
    });

    it('should reject invalid default policy', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw default badpolicy incoming');
      expect(out).toContain('ERROR');
    });

    it('should show default policies in verbose status', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw default deny incoming');
      await server.executeCommand('ufw default allow outgoing');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('Default: deny (incoming), allow (outgoing)');
    });
  });

  // ─── 8.3: Allow / Deny rules by port ──────────────────────────────

  describe('G8-03: Règles allow/deny par port', () => {
    it('should allow a port', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 22');
      expect(out).toContain('Rule added');
    });

    it('should allow port with protocol', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 80/tcp');
      expect(out).toContain('Rule added');
    });

    it('should deny a port', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw deny 23');
      expect(out).toContain('Rule added');
    });

    it('should reject a port', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw reject 25/tcp');
      expect(out).toContain('Rule added');
    });

    it('should show rules in status output', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw deny 23');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status');
      expect(out).toContain('22/tcp');
      expect(out).toContain('ALLOW');
      expect(out).toContain('80/tcp');
      expect(out).toContain('23');
      expect(out).toContain('DENY');
    });

    it('should show numbered rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw allow 443/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status numbered');
      expect(out).toContain('[ 1]');
      expect(out).toContain('[ 2]');
      expect(out).toContain('[ 3]');
      expect(out).toContain('22/tcp');
      expect(out).toContain('80/tcp');
      expect(out).toContain('443/tcp');
    });

    it('should allow port range', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 6000:6007/tcp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('6000:6007/tcp');
    });

    it('should allow port range with udp', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 60000:61000/udp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('60000:61000/udp');
    });
  });

  // ─── 8.4: Service name rules ──────────────────────────────────────

  describe('G8-04: Règles par nom de service', () => {
    it('should allow ssh service', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow ssh');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22/tcp');
    });

    it('should allow http service', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow http');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('80/tcp');
    });

    it('should allow https service', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow https');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('443/tcp');
    });

    it('should deny dns service', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw deny dns');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('53');
      expect(status).toContain('DENY');
    });
  });

  // ─── 8.5: IP-based rules ──────────────────────────────────────────

  describe('G8-05: Règles basées sur IP', () => {
    it('should allow from specific IP', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 192.168.1.100');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('192.168.1.100');
      expect(status).toContain('ALLOW');
    });

    it('should deny from specific IP', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw deny from 10.0.0.5');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('10.0.0.5');
      expect(status).toContain('DENY');
    });

    it('should allow from subnet', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 192.168.1.0/24');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('192.168.1.0/24');
    });

    it('should allow from IP to specific port', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 192.168.1.0/24 to any port 22');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22');
      expect(status).toContain('192.168.1.0/24');
    });

    it('should allow from IP to port with protocol', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 10.0.0.0/8 to any port 3306 proto tcp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('3306/tcp');
      expect(status).toContain('10.0.0.0/8');
    });

    it('should deny from Anywhere to specific port', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw deny from any to any port 3389');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('3389');
      expect(status).toContain('DENY');
      expect(status).toContain('Anywhere');
    });
  });

  // ─── 8.6: Delete rules ────────────────────────────────────────────

  describe('G8-06: Suppression de règles', () => {
    it('should delete rule by number', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw allow 443/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw delete 2');
      expect(out).toContain('Rule deleted');

      const status = await server.executeCommand('ufw status numbered');
      expect(status).toContain('22/tcp');
      expect(status).toContain('443/tcp');
      expect(status).not.toContain('80/tcp');
    });

    it('should delete rule by specification', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw delete allow 80/tcp');
      expect(out).toContain('Rule deleted');

      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22/tcp');
      expect(status).not.toContain('80/tcp');
    });

    it('should error on invalid rule number', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');

      const out = await server.executeCommand('ufw delete 99');
      expect(out).toContain('ERROR');
    });

    it('should error on deleting non-existent rule', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw delete allow 9999/tcp');
      expect(out).toContain('Could not delete non-existent rule');
    });
  });

  // ─── 8.7: Insert rules ────────────────────────────────────────────

  describe('G8-07: Insertion de règles', () => {
    it('should insert rule at specific position', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 443/tcp');

      const out = await server.executeCommand('ufw insert 2 allow 80/tcp');
      expect(out).toContain('Rule inserted');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status numbered');
      // Order should be: 22, 80, 443
      const lines = status.split('\n');
      const rule1 = lines.find(l => l.includes('[ 1]'));
      const rule2 = lines.find(l => l.includes('[ 2]'));
      const rule3 = lines.find(l => l.includes('[ 3]'));
      expect(rule1).toContain('22/tcp');
      expect(rule2).toContain('80/tcp');
      expect(rule3).toContain('443/tcp');
    });

    it('should error on invalid insert position', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw insert 0 allow 80/tcp');
      expect(out).toContain('ERROR');
    });
  });

  // ─── 8.8: Logging ────────────────────────────────────────────────

  describe('G8-08: Logging', () => {
    it('should enable logging', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw logging on');
      expect(out).toContain('Logging enabled');
    });

    it('should disable logging', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw logging on');
      const out = await server.executeCommand('ufw logging off');
      expect(out).toContain('Logging disabled');
    });

    it('should set logging level', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw logging medium');
      expect(out).toContain('Logging enabled');
    });

    it('should show logging in verbose status', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw logging on');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('Logging: on');
    });
  });

  // ─── 8.9: status verbose / status numbered ────────────────────────

  describe('G8-09: Affichage détaillé du statut', () => {
    it('should show verbose status with all info', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw default deny incoming');
      await server.executeCommand('ufw default allow outgoing');
      await server.executeCommand('ufw logging on');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('Status: active');
      expect(out).toContain('Logging: on');
      expect(out).toContain('Default: deny (incoming), allow (outgoing)');
      expect(out).toContain('To');
      expect(out).toContain('Action');
      expect(out).toContain('From');
      expect(out).toContain('22/tcp');
      expect(out).toContain('80/tcp');
    });

    it('should show Anywhere in From column when no source', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status');
      expect(out).toContain('Anywhere');
    });

    it('should show (v6) rules too', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status');
      // Real ufw also adds IPv6 rules
      expect(out).toContain('22/tcp (v6)');
      expect(out).toContain('Anywhere (v6)');
    });
  });

  // ─── 8.10: Error handling and edge cases ──────────────────────────

  describe('G8-10: Gestion des erreurs', () => {
    it('should show usage on invalid subcommand', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw badcommand');
      expect(out).toContain('ERROR');
    });

    it('should show usage when no arguments', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw');
      expect(out).toContain('Usage:');
    });

    it('should not add duplicate rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      const out = await server.executeCommand('ufw allow 22/tcp');
      expect(out).toContain('Skipping adding existing rule');
    });

    it('should handle ufw app list', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw app list');
      expect(out).toContain('Available applications:');
      expect(out).toContain('OpenSSH');
    });

    it('should handle ufw app info', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw app info OpenSSH');
      expect(out).toContain('Profile: OpenSSH');
      expect(out).toContain('22/tcp');
    });

    it('should show ufw version', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw version');
      expect(out).toContain('ufw');
    });
  });

  // ─── 8.11: Complex rule combinations ──────────────────────────────

  describe('G8-11: Combinaisons de règles complexes', () => {
    it('should handle typical web server setup', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      await server.executeCommand('ufw default deny incoming');
      await server.executeCommand('ufw default allow outgoing');
      await server.executeCommand('ufw allow ssh');
      await server.executeCommand('ufw allow http');
      await server.executeCommand('ufw allow https');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('Status: active');
      expect(out).toContain('deny (incoming)');
      expect(out).toContain('allow (outgoing)');
      expect(out).toContain('22/tcp');
      expect(out).toContain('80/tcp');
      expect(out).toContain('443/tcp');
    });

    it('should handle database server setup with IP restrictions', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      await server.executeCommand('ufw default deny incoming');
      await server.executeCommand('ufw allow from 10.0.0.0/24 to any port 5432 proto tcp');
      await server.executeCommand('ufw allow ssh');
      await server.executeCommand('ufw deny 5432');
      await server.executeCommand('ufw enable');

      const status = await server.executeCommand('ufw status numbered');
      // The allow from 10.0.0.0/24 should be listed before the deny 5432
      expect(status).toContain('5432/tcp');
      expect(status).toContain('10.0.0.0/24');
      expect(status).toContain('ALLOW');
      expect(status).toContain('DENY');
    });

    it('should handle limit rule for SSH brute-force protection', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw limit ssh');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22/tcp');
      expect(status).toContain('LIMIT');
    });

    it('should show complete status with To/Action/From headers', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw status');
      const lines = out.split('\n');
      // Should have header line with To, Action, From
      const headerLine = lines.find(l => l.includes('To') && l.includes('Action') && l.includes('From'));
      expect(headerLine).toBeDefined();
      // Should have separator line with dashes
      const separatorLine = lines.find(l => l.includes('--'));
      expect(separatorLine).toBeDefined();
    });
  });
});
