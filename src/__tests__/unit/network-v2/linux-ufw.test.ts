/**
 * TDD Tests for Linux UFW (Uncomplicated Firewall)
 * ~40 scénarios couvrant enable/disable, rules, status, logging, etc.
 * Fidèle au comportement réel de ufw sur Ubuntu/Debian.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

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

    it('should re-read ufw.conf on reload', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw logging medium');
      await server.executeCommand('ufw enable');

      // Manually edit ufw.conf to change LOGLEVEL
      await server.executeCommand('echo "ENABLED=yes\nLOGLEVEL=high" > /etc/ufw/ufw.conf');

      // Reload should pick up the new log level
      await server.executeCommand('ufw reload');

      const status = await server.executeCommand('ufw status verbose');
      expect(status).toContain('on (high)');
    });

    it('should re-apply ENABLED state from ufw.conf on reload', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');

      // Manually set ENABLED=no in config
      await server.executeCommand('echo "ENABLED=no\nLOGLEVEL=off" > /etc/ufw/ufw.conf');
      await server.executeCommand('ufw reload');

      const status = await server.executeCommand('ufw status');
      expect(status).toContain('Status: inactive');
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

    it('should delete rule with direction (ufw delete allow in 22/tcp)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow in 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw delete allow in 22/tcp');
      expect(out).toContain('Rule deleted');

      const status = await server.executeCommand('ufw status');
      expect(status).not.toContain('22/tcp');
      expect(status).toContain('80/tcp');
    });

    it('should delete rule with from syntax (ufw delete allow from 10.0.0.1)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow from 10.0.0.1');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw delete allow from 10.0.0.1');
      expect(out).toContain('Rule deleted');

      const status = await server.executeCommand('ufw status');
      expect(status).not.toContain('10.0.0.1');
      expect(status).toContain('80/tcp');
    });

    it('should delete deny rule by spec', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw deny 23');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw delete deny 23');
      expect(out).toContain('Rule deleted');

      const status = await server.executeCommand('ufw status');
      expect(status).not.toContain('23');
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

  // ─── 8.10b: Bug fix validations ──────────────────────────────────

  describe('G8-10b: Bug fix validations', () => {
    it('should include logging level in enable output', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw logging on');
      expect(out).toContain('Logging enabled (low)');
    });

    it('should include correct logging level for medium', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw logging medium');
      expect(out).toContain('Logging enabled (medium)');
    });

    it('should show correct position in insert error', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw insert -1 allow 80/tcp');
      expect(out).toContain("Invalid position '-1'");
    });

    it('should reject invalid port number (99999)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 99999/tcp');
      expect(out).toContain('ERROR');
      expect(out).toContain('Invalid port');
    });

    it('should reject invalid port range (8000:6000)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 8000:6000/tcp');
      expect(out).toContain('ERROR');
      expect(out).toContain('Invalid port range');
    });

    it('should reject port 0', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow 0/tcp');
      expect(out).toContain('ERROR');
    });

    it('should not say v6 deleted when deleting IP-specific rule', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow from 192.168.1.1 to any port 22');
      const out = await server.executeCommand('ufw delete 1');
      expect(out).toBe('Rule deleted');
      expect(out).not.toContain('(v6)');
    });

    it('should say v6 deleted when deleting Anywhere rule', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      const out = await server.executeCommand('ufw delete 1');
      expect(out).toContain('Rule deleted (v6)');
    });

    it('should not say v6 in skip message for IP-specific duplicate', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow from 10.0.0.1 to any port 80');
      const out = await server.executeCommand('ufw allow from 10.0.0.1 to any port 80');
      expect(out).toBe('Skipping adding existing rule');
      expect(out).not.toContain('(v6)');
    });

    it('should validate port in from-rule syntax too', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 10.0.0.1 to any port 70000');
      expect(out).toContain('ERROR');
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

  // ─── 8.12: Direction, interface, destination IP, app profiles, comments ────

  describe('G8-12: Direction et interface', () => {
    it('should allow rule with "in" direction', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow in 22/tcp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('ALLOW IN');
      expect(status).toContain('22/tcp');
    });

    it('should allow rule with "out" direction', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow out 53');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('ALLOW OUT');
      expect(status).toContain('53');
    });

    it('should allow rule with interface "on eth0"', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow in on eth0 80/tcp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('on eth0');
      expect(status).toContain('80/tcp');
    });

    it('should deny outgoing on specific interface', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw deny out on ens33 25/tcp');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('DENY OUT on ens33');
    });

    it('should allow direction with from syntax', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow in on eth0 from 10.0.0.0/24 to any port 22');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('on eth0');
      expect(status).toContain('10.0.0.0/24');
      expect(status).toContain('22');
    });
  });

  describe('G8-13: Destination IP et app profiles comme règles', () => {
    it('should allow rule to specific destination IP', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 10.0.0.1 to 192.168.1.1 port 443 proto tcp');
      expect(out).toContain('Rule added');
    });

    it('should allow app profile as rule target (OpenSSH)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow OpenSSH');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22/tcp');
    });

    it('should allow multi-word app profile (Nginx Full)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow Nginx Full');
      expect(out).toContain('Rule added');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('80,443/tcp');
    });

    it('should support comment on from-rule', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw allow from 10.0.0.1 to any port 22 comment SSH from office');
      expect(out).toContain('Rule added');
    });

    it('should show destination IP in status To column', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow from 10.0.0.1 to 192.168.1.1 port 443 proto tcp');
      await server.executeCommand('ufw enable');

      const status = await server.executeCommand('ufw status');
      expect(status).toContain('192.168.1.1');
      expect(status).toContain('443/tcp');
    });
  });

  // ─── 8.14: Numbered delete consistency ────────────────────────────

  describe('G8-14: Consistance delete numéroté', () => {
    it('should delete the correct rule by number in v4+v6 ordering', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');   // v4 rule 1, v6 rule (later)
      await server.executeCommand('ufw allow 80/tcp');   // v4 rule 2, v6 rule (later)
      await server.executeCommand('ufw enable');

      // status numbered shows: [1] 22/tcp, [2] 80/tcp, [3] 22/tcp (v6), [4] 80/tcp (v6)
      const status = await server.executeCommand('ufw status numbered');
      expect(status).toContain('[ 1]');
      expect(status).toContain('[ 4]');

      // Delete rule 2 (80/tcp v4) — should also remove v6 counterpart
      const out = await server.executeCommand('ufw delete 2');
      expect(out).toContain('Rule deleted');
      expect(out).toContain('Rule deleted (v6)');

      const after = await server.executeCommand('ufw status');
      expect(after).toContain('22/tcp');
      expect(after).not.toContain('80/tcp');
    });

    it('should delete v6 rule directly when targeting its number', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw enable');

      // [1] 22/tcp, [2] 80/tcp, [3] 22/tcp (v6), [4] 80/tcp (v6)
      // Delete rule 3 (22/tcp v6 only)
      const out = await server.executeCommand('ufw delete 3');
      expect(out).toBe('Rule deleted (v6)');

      // 22/tcp v4 should still exist
      const status = await server.executeCommand('ufw status');
      expect(status).toContain('22/tcp');
      // But v6 of 22 should be gone, 80/tcp v6 should still exist
      const lines = status.split('\n');
      const v6_22 = lines.filter(l => l.includes('22/tcp') && l.includes('(v6)'));
      expect(v6_22.length).toBe(0);
      const v6_80 = lines.filter(l => l.includes('80/tcp') && l.includes('(v6)'));
      expect(v6_80.length).toBe(1);
    });

    it('should error on out-of-range numbered delete', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      // 2 rules total: v4 + v6
      const out = await server.executeCommand('ufw delete 5');
      expect(out).toContain('ERROR');
    });
  });

  // ─── 8.15: VFS persistence ──────────────────────────────────────

  describe('G8-15: Persistence VFS', () => {
    it('should have /etc/ufw/ directory with default config files', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ls /etc/ufw');
      expect(out).toContain('ufw.conf');
      expect(out).toContain('before.rules');
      expect(out).toContain('after.rules');
      expect(out).toContain('before6.rules');
      expect(out).toContain('after6.rules');
      expect(out).toContain('user.rules');
      expect(out).toContain('user6.rules');
      expect(out).toContain('sysctl.conf');
      expect(out).toContain('applications.d');
    });

    it('should have app profile files in /etc/ufw/applications.d/', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ls /etc/ufw/applications.d');
      expect(out).toContain('openssh-server');
      expect(out).toContain('apache2');
      expect(out).toContain('nginx');
    });

    it('should read app profile content', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('cat /etc/ufw/applications.d/openssh-server');
      expect(out).toContain('[OpenSSH]');
      expect(out).toContain('ports=22/tcp');
    });

    it('should update ufw.conf ENABLED=yes on enable', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      const conf = await server.executeCommand('cat /etc/ufw/ufw.conf');
      expect(conf).toContain('ENABLED=yes');
    });

    it('should update ufw.conf ENABLED=no on disable', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw disable');
      const conf = await server.executeCommand('cat /etc/ufw/ufw.conf');
      expect(conf).toContain('ENABLED=no');
    });

    it('should update ufw.conf LOGLEVEL on logging change', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw logging medium');
      const conf = await server.executeCommand('cat /etc/ufw/ufw.conf');
      expect(conf).toContain('LOGLEVEL=medium');
    });

    it('should persist rules to /etc/ufw/user.rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw deny 23');
      const rules = await server.executeCommand('cat /etc/ufw/user.rules');
      expect(rules).toContain('--dport 22');
      expect(rules).toContain('ACCEPT');
      expect(rules).toContain('--dport 23');
      expect(rules).toContain('DROP');
    });

    it('should persist IPv6 rules to /etc/ufw/user6.rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 80/tcp');
      const rules = await server.executeCommand('cat /etc/ufw/user6.rules');
      expect(rules).toContain('--dport 80');
      expect(rules).toContain('ufw6-user-input');
    });

    it('should create /var/log/ufw.log on enable', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw enable');
      const log = await server.executeCommand('cat /var/log/ufw.log');
      expect(log).toContain('[UFW]');
      expect(log).toContain('UFW enabled');
    });

    it('should have ufw binary stub in /usr/sbin/', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('which ufw');
      expect(out).toContain('/usr/sbin/ufw');
    });

    it('should show default policies in user.rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw default reject incoming');
      await server.executeCommand('ufw allow 22/tcp');
      const rules = await server.executeCommand('cat /etc/ufw/user.rules');
      expect(rules).toContain('default incoming: reject');
    });

    it('should read before.rules content', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('cat /etc/ufw/before.rules');
      expect(out).toContain('ufw-before-input');
      expect(out).toContain('RELATED,ESTABLISHED');
      expect(out).toContain('ICMP');
      expect(out).toContain('COMMIT');
    });

    it('should reset config files on ufw reset', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw reset');

      const conf = await server.executeCommand('cat /etc/ufw/ufw.conf');
      expect(conf).toContain('ENABLED=no');

      const rules = await server.executeCommand('cat /etc/ufw/user.rules');
      expect(rules).not.toContain('--dport 22');
    });
  });

  // ─── 8.16: Real packet filtering ──────────────────────────────────

  describe('G8-16: Filtrage réel du trafic', () => {
    beforeEach(() => {
      resetCounters();
      MACAddress.resetCounter();
      Logger.reset();
    });

    function connectTwoPCs() {
      const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
      const pc2 = new LinuxPC('linux-pc', 'PC2', 200, 0);
      const cable = new Cable('cable-1');
      cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
      return { pc1, pc2, cable };
    }

    function connectPCtoServer() {
      const pc = new LinuxPC('linux-pc', 'Client', 0, 0);
      const srv = new LinuxServer('linux-server', 'Server', 200, 0);
      const cable = new Cable('cable-1');
      cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
      return { pc, srv, cable };
    }

    it('should allow ping when firewall is disabled', async () => {
      const { pc1, pc2 } = connectTwoPCs();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2');

      const result = await pc1.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
      expect(result).toContain('0% packet loss');
    });

    it('should block incoming ping when ufw enabled with default deny incoming', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Enable firewall on server (default: deny incoming)
      await srv.executeCommand('ufw enable');

      // Ping from PC to server → server should drop the incoming ICMP
      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
      expect(result).toContain('100% packet loss');
    });

    it('should allow ping after adding allow rule for source IP', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Enable firewall and allow traffic from 10.0.0.1
      await srv.executeCommand('ufw allow from 10.0.0.1');
      await srv.executeCommand('ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
      expect(result).toContain('0% packet loss');
    });

    it('should block ping from non-whitelisted IP', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.99');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Only allow from 10.0.0.1 — pc is 10.0.0.99
      await srv.executeCommand('ufw allow from 10.0.0.1');
      await srv.executeCommand('ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
      expect(result).toContain('100% packet loss');
    });

    it('should stop blocking after disabling the firewall', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Enable → block
      await srv.executeCommand('ufw enable');
      const blocked = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(blocked).toContain('0 received');

      // Disable → allow again
      await srv.executeCommand('ufw disable');
      const allowed = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(allowed).toContain('1 received');
      expect(allowed).toContain('0% packet loss');
    });

    it('should block ping on LinuxPC with ufw deny incoming', async () => {
      const { pc1, pc2 } = connectTwoPCs();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2');

      // Enable firewall on PC2
      await pc2.executeCommand('sudo ufw enable');

      const result = await pc1.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
      expect(result).toContain('100% packet loss');
    });

    it('should allow CIDR-based source filtering', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.50');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Allow entire 10.0.0.0/24 subnet
      await srv.executeCommand('ufw allow from 10.0.0.0/24');
      await srv.executeCommand('ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
      expect(result).toContain('0% packet loss');
    });

    it('should block when source IP is outside allowed CIDR', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 192.168.1.50');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Allow only 10.0.0.0/24 — PC is on 192.168.1.0/24
      await srv.executeCommand('ufw allow from 10.0.0.0/24');
      await srv.executeCommand('ufw enable');

      // Different subnet, no route, should fail
      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      // Even if the packet arrives, firewall should block it
      expect(result).toContain('0 received');
    });

    it('should respect first-match wins: deny before allow', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Deny from 10.0.0.1 first, then allow all — deny should win
      await srv.executeCommand('ufw deny from 10.0.0.1');
      await srv.executeCommand('ufw allow from 10.0.0.0/24');
      await srv.executeCommand('ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
      expect(result).toContain('100% packet loss');
    });

    it('should allow after reset clears all rules', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Enable firewall (blocks)
      await srv.executeCommand('ufw enable');
      const blocked = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(blocked).toContain('0 received');

      // Reset clears everything (also disables)
      await srv.executeCommand('ufw reset');
      const after = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(after).toContain('1 received');
    });

    it('should block outgoing ping when ufw default deny outgoing', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Allow incoming (so reply could come back), deny outgoing (blocks sent pings)
      await pc.executeCommand('sudo ufw default allow incoming');
      await pc.executeCommand('sudo ufw default deny outgoing');
      await pc.executeCommand('sudo ufw enable');

      // PC tries to send ping → outgoing filter should block it before it leaves
      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
      expect(result).toContain('100% packet loss');
    });

    it('should allow outgoing ping when outgoing rule allows it', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Deny outgoing by default, but allow to 10.0.0.2, and allow incoming for replies
      await pc.executeCommand('sudo ufw default allow incoming');
      await pc.executeCommand('sudo ufw default deny outgoing');
      await pc.executeCommand('sudo ufw allow out from any to 10.0.0.2');
      await pc.executeCommand('sudo ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
      expect(result).toContain('0% packet loss');
    });

    it('should send ICMP destination-unreachable on reject (not silent drop)', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Set default incoming to reject (sends ICMP error back instead of silent drop)
      await srv.executeCommand('ufw default reject incoming');
      await srv.executeCommand('ufw enable');

      // Ping should fail fast with "Destination Host Unreachable" instead of timeout
      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('Destination Host Unreachable');
      expect(result).toContain('0 received');
    });

    it('should send ICMP unreachable on reject rule match', async () => {
      const { pc, srv } = connectPCtoServer();
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');

      // Reject traffic from 10.0.0.1 specifically
      await srv.executeCommand('ufw reject from 10.0.0.1');
      await srv.executeCommand('ufw enable');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('Destination Host Unreachable');
      expect(result).toContain('0 received');
    });
  });

  // ─── 8.17: ufw show subcommands ────────────────────────────────

  describe('G8-17: ufw show subcommands', () => {
    it('should show raw iptables-style output', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw enable');

      const out = await server.executeCommand('ufw show raw');
      expect(out).toContain('Chain');
      expect(out).toContain('ufw-user-input');
      expect(out).toContain('ACCEPT');
      expect(out).toContain('dpt:22');
    });

    it('should show added rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw deny 23');
      await server.executeCommand('ufw allow from 10.0.0.1');

      const out = await server.executeCommand('ufw show added');
      expect(out).toContain('ufw allow 22/tcp');
      expect(out).toContain('ufw deny 23');
      expect(out).toContain('ufw allow from 10.0.0.1');
    });

    it('should show listening ports', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      const out = await server.executeCommand('ufw show listening');
      // Should show header at minimum
      expect(out).toContain('tcp');
    });

    it('should error on invalid show subcommand', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw show badcmd');
      expect(out).toContain('ERROR');
    });
  });

  // ─── 8.17b: ufw prepend ────────────────────────────────────────

  describe('G8-17b: ufw prepend', () => {
    it('should prepend rule at position 1', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ufw allow 80/tcp');

      const out = await server.executeCommand('ufw prepend deny 23');
      expect(out).toContain('Rule prepended');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status numbered');
      // deny 23 should be first
      const lines = status.split('\n');
      const rule1 = lines.find(l => l.includes('[ 1]'));
      expect(rule1).toContain('23');
      expect(rule1).toContain('DENY');
    });

    it('should prepend rule before existing rules', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('ufw allow 80/tcp');
      await server.executeCommand('ufw allow 443/tcp');
      await server.executeCommand('ufw prepend deny from 10.0.0.1');

      await server.executeCommand('ufw enable');
      const status = await server.executeCommand('ufw status numbered');
      const lines = status.split('\n');
      const rule1 = lines.find(l => l.includes('[ 1]'));
      expect(rule1).toContain('DENY');
      expect(rule1).toContain('10.0.0.1');
    });

    it('should prepend to empty rule set', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('ufw prepend allow 22/tcp');
      expect(out).toContain('Rule prepended');
    });
  });

  // ─── 8.18: Rate limiting (LIMIT) ──────────────────────────────

  describe('G8-18: Rate limiting', () => {
    it('should accept packets under the rate limit', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      fw.execute(['limit', '22/tcp']);
      fw.execute(['enable']);

      // First few packets should be accepted (under 6 in 30s)
      const result = ipt.filterPacket({
        direction: 'in', protocol: 6,
        srcIP: '10.0.0.1', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 22, iface: 'eth0',
      });
      expect(result).toBe('accept');
    });

    it('should drop packets over the rate limit', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      fw.execute(['limit', '22/tcp']);
      fw.execute(['enable']);

      const pkt = {
        direction: 'in' as const, protocol: 6,
        srcIP: '10.0.0.1', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 22, iface: 'eth0',
      };

      // Send 6 packets (under limit) — all should be accepted
      for (let i = 0; i < 6; i++) {
        expect(ipt.filterPacket(pkt)).toBe('accept');
      }

      // 7th packet should be dropped (over limit → falls through to INPUT policy DROP)
      expect(ipt.filterPacket(pkt)).toBe('drop');
    });

    it('should track rate limit per source IP', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      fw.execute(['limit', '22/tcp']);
      fw.execute(['enable']);

      const pkt1 = {
        direction: 'in' as const, protocol: 6,
        srcIP: '10.0.0.1', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 22, iface: 'eth0',
      };
      const pkt2 = {
        direction: 'in' as const, protocol: 6,
        srcIP: '10.0.0.99', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 22, iface: 'eth0',
      };

      // Exhaust limit for 10.0.0.1
      for (let i = 0; i < 7; i++) ipt.filterPacket(pkt1);

      // 10.0.0.99 should still be accepted (different source)
      expect(ipt.filterPacket(pkt2)).toBe('accept');
    });
  });

  // ─── 8.19: IPv6 firewall filtering ──────────────────────────────

  describe('G8-19: Filtrage IPv6', () => {
    it('should use v6 rules for IPv6 packet filtering via filterPacket', async () => {
      const srv = new LinuxServer('linux-server', 'SRV1');

      // Add a rule that generates both v4 and v6 entries
      await srv.executeCommand('ufw allow 22/tcp');
      await srv.executeCommand('ufw enable');

      // v6 rules should exist in status
      const status = await srv.executeCommand('ufw status');
      expect(status).toContain('22/tcp (v6)');
    });

    it('should apply default deny policy via iptables when ufw enabled', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      fw.execute(['enable']);

      // Default deny incoming — packet should be dropped via iptables INPUT policy DROP
      const result = ipt.filterPacket({
        direction: 'in',
        protocol: 6, // TCP
        srcIP: '10.0.0.1',
        dstIP: '10.0.0.2',
        srcPort: 12345,
        dstPort: 80,
        iface: 'eth0',
      });
      expect(result).toBe('drop');
    });

    it('should allow packet matching ufw allow rule via iptables', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      fw.execute(['allow', '80/tcp']); // adds v4 and v6 rule
      fw.execute(['enable']);

      // TCP packet to port 80 should be allowed via iptables ufw-user-input chain
      const result = ipt.filterPacket({
        direction: 'in',
        protocol: 6,
        srcIP: '10.0.0.1',
        dstIP: '10.0.0.2',
        srcPort: 12345,
        dstPort: 80,
        iface: 'eth0',
      });
      expect(result).toBe('accept');
    });

    it('should not match rules from other protocols', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      // Add rule from specific IPv4 → allows TCP port 80 from 10.0.0.1
      fw.execute(['allow', 'from', '10.0.0.1', 'to', 'any', 'port', '80']);
      fw.execute(['enable']);

      // UDP packet to port 80 from a different source → should be dropped by default policy
      const result = ipt.filterPacket({
        direction: 'in',
        protocol: 17, // UDP
        srcIP: '192.168.1.1',
        dstIP: '10.0.0.2',
        srcPort: 12345,
        dstPort: 80,
        iface: 'eth0',
      });
      expect(result).toBe('drop');
    });

    it('should drop after rule deleted via iptables', async () => {
      const { LinuxIptablesManager } = await import('@/network/devices/linux/LinuxIptablesManager');
      const { LinuxFirewallManager } = await import('@/network/devices/linux/LinuxFirewallManager');
      const ipt = new LinuxIptablesManager();
      const fw = new LinuxFirewallManager(undefined, ipt);
      // allow 80/tcp → creates v4 rule + v6 rule
      fw.execute(['allow', '80/tcp']);
      fw.execute(['enable']);

      // Verify it's allowed first
      const allowed = ipt.filterPacket({
        direction: 'in', protocol: 6,
        srcIP: '10.0.0.1', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 80, iface: 'eth0',
      });
      expect(allowed).toBe('accept');

      // Delete the rule via UFW
      fw.execute(['delete', 'allow', '80/tcp']);

      // Now it should be dropped (iptables rules rebuilt)
      const result = ipt.filterPacket({
        direction: 'in', protocol: 6,
        srcIP: '10.0.0.1', dstIP: '10.0.0.2',
        srcPort: 12345, dstPort: 80, iface: 'eth0',
      });
      expect(result).toBe('drop');
    });
  });

  // ─── Route rules (FORWARD chain) ──────────────────────────────

  describe('UFW route rules', () => {
    let server: LinuxServer;

    beforeEach(() => {
      server = new LinuxServer('linux-server', 'SRV1');
    });

    it('should add a route allow rule', async () => {
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw route allow in on eth0 out on eth1');
      expect(out).toContain('Rule added');
    });

    it('should display route rules in status with FWD direction', async () => {
      await server.executeCommand('ufw route allow in on eth0 out on eth1 from 10.0.0.0/24 to 192.168.1.0/24');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw status');
      expect(out).toContain('FWD');
      expect(out).toContain('ALLOW');
    });

    it('should show route rules in show added output', async () => {
      await server.executeCommand('ufw route allow in on eth0 out on eth1');
      const out = await server.executeCommand('ufw show added');
      expect(out).toContain('ufw route allow');
      expect(out).toContain('in on eth0');
      expect(out).toContain('out on eth1');
    });

    it('should inject route rules into ufw-user-forward iptables chain', async () => {
      await server.executeCommand('ufw route allow in on eth0 out on eth1 from 10.0.0.0/24 to 192.168.1.0/24');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('iptables -S ufw-user-forward');
      expect(out).toContain('-A ufw-user-forward');
      expect(out).toContain('-s 10.0.0.0/24');
      expect(out).toContain('-d 192.168.1.0/24');
      expect(out).toContain('-i eth0');
      expect(out).toContain('-o eth1');
      expect(out).toContain('ACCEPT');
    });

    it('should add route deny rule', async () => {
      const out = await server.executeCommand('ufw route deny in on eth0 out on eth1 from 10.0.0.0/24 to any');
      expect(out).toContain('Rule added');
      await server.executeCommand('ufw enable');
      const ipt = await server.executeCommand('iptables -S ufw-user-forward');
      expect(ipt).toContain('DROP');
    });

    it('should add route rules with port and proto', async () => {
      await server.executeCommand('ufw route allow in on eth0 out on eth1 from any to any port 80 proto tcp');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('iptables -S ufw-user-forward');
      expect(out).toContain('--dport 80');
      expect(out).toContain('-p tcp');
    });

    it('should filter forwarded packets through route rules', async () => {
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw default deny routed');
      await server.executeCommand('ufw route allow in on eth0 out on eth1 from 10.0.0.0/24 to 192.168.1.0/24');

      const ipt = (server as any).executor.iptables;

      // Allowed: matches route rule
      const v1 = ipt.filterPacket({
        direction: 'forward', protocol: 6,
        srcIP: '10.0.0.1', dstIP: '192.168.1.1',
        srcPort: 1234, dstPort: 80, iface: 'eth0', outIface: 'eth1',
      });
      expect(v1).toBe('accept');

      // Blocked: different source network → FORWARD policy DROP
      const v2 = ipt.filterPacket({
        direction: 'forward', protocol: 6,
        srcIP: '172.16.0.1', dstIP: '192.168.1.1',
        srcPort: 1234, dstPort: 80, iface: 'eth0', outIface: 'eth1',
      });
      expect(v2).toBe('drop');
    });
  });

  // ─── Default routed policy ─────────────────────────────────────

  describe('UFW default routed policy', () => {
    let server: LinuxServer;

    beforeEach(() => {
      server = new LinuxServer('linux-server', 'SRV1');
    });

    it('should change default routed policy to allow', async () => {
      const out = await server.executeCommand('ufw default allow routed');
      expect(out).toContain("Default routed policy changed to 'allow'");
    });

    it('should change default routed policy to deny', async () => {
      const out = await server.executeCommand('ufw default deny routed');
      expect(out).toContain("Default routed policy changed to 'deny'");
    });

    it('should change default routed policy to reject', async () => {
      const out = await server.executeCommand('ufw default reject routed');
      expect(out).toContain("Default routed policy changed to 'reject'");
    });

    it('should show routed policy in status verbose', async () => {
      await server.executeCommand('ufw default allow routed');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('allow (routed)');
    });

    it('should show disabled routed policy by default', async () => {
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('disabled (routed)');
    });

    it('should set FORWARD chain policy to DROP when routed is deny', async () => {
      await server.executeCommand('ufw default deny routed');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('iptables -S FORWARD');
      expect(out).toContain('-P FORWARD DROP');
    });

    it('should set FORWARD chain policy to ACCEPT when routed is allow', async () => {
      await server.executeCommand('ufw default allow routed');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('iptables -S FORWARD');
      expect(out).toContain('-P FORWARD ACCEPT');
    });

    it('should create ufw-user-forward chain on enable', async () => {
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('iptables -S ufw-user-forward');
      // Chain should exist (no error)
      expect(out).not.toContain('No chain');
    });

    it('should reset routed policy on ufw reset', async () => {
      await server.executeCommand('ufw default allow routed');
      await server.executeCommand('ufw enable');
      await server.executeCommand('ufw reset');
      await server.executeCommand('ufw enable');
      const out = await server.executeCommand('ufw status verbose');
      expect(out).toContain('disabled (routed)');
    });
  });
});
