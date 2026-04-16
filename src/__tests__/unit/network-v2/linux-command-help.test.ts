/**
 * TDD tests for LinuxCommand enriched interface:
 *   Section 1: usage, help, error messages
 *   Section 2: tab completions
 *   Section 3: declarative options with auto-generated help
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';

// ═══════════════════════════════════════════════════════════════════
// Section 1: usage, help, and error messages
// ═══════════════════════════════════════════════════════════════════

describe('LinuxCommand — help & usage', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    pc = new LinuxPC('linux-pc', 'PC1');
  });

  // ── man command ────────────────────────────────────────────────

  describe('man command', () => {
    it('should show the help text for ping', async () => {
      const out = await pc.executeCommand('man ping');
      expect(out).toContain('PING(8)');
      expect(out).toContain('SYNOPSIS');
      expect(out).toContain('DESCRIPTION');
      expect(out).toContain('ping');
    });

    it('should show the help text for ifconfig', async () => {
      const out = await pc.executeCommand('man ifconfig');
      expect(out).toContain('IFCONFIG(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for traceroute', async () => {
      const out = await pc.executeCommand('man traceroute');
      expect(out).toContain('TRACEROUTE(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for dhclient', async () => {
      const out = await pc.executeCommand('man dhclient');
      expect(out).toContain('DHCLIENT(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for sysctl', async () => {
      const out = await pc.executeCommand('man sysctl');
      expect(out).toContain('SYSCTL(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for arp', async () => {
      const out = await pc.executeCommand('man arp');
      expect(out).toContain('ARP(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for dig', async () => {
      const out = await pc.executeCommand('man dig');
      expect(out).toContain('DIG(1)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show the help text for dnsmasq', async () => {
      const out = await pc.executeCommand('man dnsmasq');
      expect(out).toContain('DNSMASQ(8)');
      expect(out).toContain('SYNOPSIS');
    });

    it('should show an error for an unknown command', async () => {
      const out = await pc.executeCommand('man nonexistent');
      expect(out).toContain('No manual entry for nonexistent');
    });

    it('should show a usage error when no argument given', async () => {
      const out = await pc.executeCommand('man');
      expect(out).toContain('What manual page do you want?');
    });
  });

  // ── --help flag ────────────────────────────────────────────────

  describe('--help flag', () => {
    it('should show usage for ping --help', async () => {
      const out = await pc.executeCommand('ping --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('ping');
    });

    it('should show usage for ifconfig --help', async () => {
      const out = await pc.executeCommand('ifconfig --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('ifconfig');
    });

    it('should show usage for traceroute --help', async () => {
      const out = await pc.executeCommand('traceroute --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('traceroute');
    });

    it('should show usage for dhclient --help', async () => {
      const out = await pc.executeCommand('dhclient --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('dhclient');
    });

    it('should show usage for sysctl --help', async () => {
      const out = await pc.executeCommand('sysctl --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('sysctl');
    });

    it('should show usage for arp --help', async () => {
      const out = await pc.executeCommand('arp --help');
      expect(out).toContain('Usage:');
      expect(out).toContain('arp');
    });
  });

  // ── Error messages ─────────────────────────────────────────────

  describe('error messages', () => {
    it('ping without target should show usage', async () => {
      const out = await pc.executeCommand('ping');
      expect(out).toContain('Usage:');
      expect(out).toContain('ping');
    });

    it('ping with invalid IP should show clear error', async () => {
      const out = await pc.executeCommand('ping not-an-ip');
      expect(out).toContain('ping:');
      expect(out).toMatch(/Name or service not known|unknown host/i);
    });

    it('traceroute without target should show usage', async () => {
      const out = await pc.executeCommand('traceroute');
      expect(out).toContain('Usage:');
      expect(out).toContain('traceroute');
    });

    it('ifconfig on non-existent interface should show clear error', async () => {
      const out = await pc.executeCommand('ifconfig eth99');
      expect(out).toContain('ifconfig:');
      expect(out).toContain('eth99');
    });

    it('dhclient without interface should show usage', async () => {
      const out = await pc.executeCommand('dhclient');
      expect(out).toContain('Usage:');
      expect(out).toContain('dhclient');
    });

    it('dhclient on non-existent interface should show error', async () => {
      const out = await pc.executeCommand('dhclient eth99');
      expect(out).toContain('No such device');
      expect(out).toContain('eth99');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Section 1 also: man works on LinuxServer
// ═══════════════════════════════════════════════════════════════════

describe('LinuxCommand — man on LinuxServer', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('should show man page for ping on a server', async () => {
    const out = await server.executeCommand('man ping');
    expect(out).toContain('PING(8)');
    expect(out).toContain('SYNOPSIS');
  });

  it('should show --help for ping on a server', async () => {
    const out = await server.executeCommand('ping --help');
    expect(out).toContain('Usage:');
    expect(out).toContain('ping');
  });
});
