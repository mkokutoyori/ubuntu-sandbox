/**
 * TDD tests for netsh dhcpclient & netsh dnsclient
 *
 * Real Windows commands:
 *   netsh dhcpclient list               — list DHCP protocol interfaces
 *   netsh dhcpclient trace enable       — enable DHCP event tracing
 *   netsh dhcpclient trace disable      — disable DHCP event tracing
 *   netsh dhcpclient trace show status  — show trace status
 *   netsh dnsclient show state          — show DNS client configuration
 *   netsh dnsclient set global dnssuffix=<suffix> — set primary DNS suffix
 *   netsh dnsclient show encryption     — show DNS encryption (stub)
 *
 * All commands must have real impact on device state.
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '../../../network/devices/WindowsPC';

// ─── Group 1: netsh dhcpclient ──────────────────────────────────────

describe('Group 1: netsh dhcpclient', () => {

  describe('DC-01: dhcpclient help', () => {
    it('should display dhcpclient context help', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient ?');
      expect(result).toContain('list');
      expect(result).toContain('trace');
      expect(result).toContain('Displays a list of commands');
    });

    it('should display dhcpclient help with /? syntax', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient /?');
      expect(result).toContain('list');
      expect(result).toContain('trace');
    });
  });

  describe('DC-02: dhcpclient list', () => {
    it('should list all interfaces with DHCP state', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient list');
      // Should show a table with interface name, state, IP
      expect(result).toContain('Ethernet 0');
      expect(result).toContain('INIT');
    });

    it('should show INIT state for unconfigured interface', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient list');
      // All interfaces start in INIT state with no lease
      expect(result).toContain('INIT');
      expect(result).toContain('---'); // table separator
    });

    it('should show static IP when interface is statically configured', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 10.0.0.5 255.255.255.0'
      );
      const result = await pc.executeCommand('netsh dhcpclient list');
      // Static-configured interface should show "Static" or not DHCP
      expect(result).toContain('Ethernet 0');
      expect(result).toContain('10.0.0.5');
    });

    it('should reflect DHCP mode when address set to dhcp', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" dhcp'
      );
      const result = await pc.executeCommand('netsh dhcpclient list');
      expect(result).toContain('Ethernet 0');
      // Should show DHCP-enabled state
      expect(result).toMatch(/DHCP|INIT/i);
    });
  });

  describe('DC-03: dhcpclient trace', () => {
    it('should enable DHCP tracing', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient trace enable');
      expect(result).toContain('enabled');
    });

    it('should disable DHCP tracing', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dhcpclient trace enable');
      const result = await pc.executeCommand('netsh dhcpclient trace disable');
      expect(result).toContain('disabled');
    });

    it('should show trace status when enabled', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dhcpclient trace enable');
      const status = await pc.executeCommand('netsh dhcpclient trace show status');
      expect(status).toContain('enabled');
    });

    it('should show trace status when disabled', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const status = await pc.executeCommand('netsh dhcpclient trace show status');
      expect(status).toContain('disabled');
    });

    it('should log events when tracing is enabled', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dhcpclient trace enable');
      // Trigger a DHCP-related event
      await pc.executeCommand('netsh interface ip set address "Ethernet 0" dhcp');
      const log = await pc.executeCommand('wevtutil qe Microsoft-Windows-Dhcp-Client/Operational');
      // Should have logged events
      expect(log.length).toBeGreaterThan(0);
    });
  });

  describe('DC-04: dhcpclient trace help', () => {
    it('should display trace sub-context help', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dhcpclient trace ?');
      expect(result).toContain('enable');
      expect(result).toContain('disable');
      expect(result).toContain('show');
    });
  });
});

// ─── Group 2: netsh dnsclient ───────────────────────────────────────

describe('Group 2: netsh dnsclient', () => {

  describe('DN-01: dnsclient help', () => {
    it('should display dnsclient context help', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dnsclient ?');
      expect(result).toContain('show');
      expect(result).toContain('set');
      expect(result).toContain('Displays a list of commands');
    });
  });

  describe('DN-02: dnsclient show state', () => {
    it('should show DNS client state with no servers configured', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dnsclient show state');
      expect(result).toContain('DNS Client');
      expect(result).toContain('Suffix');
    });

    it('should show configured DNS servers after setting them', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set dns "Ethernet 0" static 8.8.8.8'
      );
      await pc.executeCommand(
        'netsh interface ip add dns "Ethernet 0" 1.1.1.1'
      );
      const result = await pc.executeCommand('netsh dnsclient show state');
      expect(result).toContain('8.8.8.8');
      expect(result).toContain('1.1.1.1');
      expect(result).toContain('Ethernet 0');
    });

    it('should show DNS suffix when configured', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dnsclient set global dnssuffix=corp.local');
      const result = await pc.executeCommand('netsh dnsclient show state');
      expect(result).toContain('corp.local');
    });
  });

  describe('DN-03: dnsclient set global', () => {
    it('should set primary DNS suffix', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand(
        'netsh dnsclient set global dnssuffix=example.com'
      );
      expect(result).toContain('Ok');
    });

    it('should persist DNS suffix and reflect in ipconfig /all', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dnsclient set global dnssuffix=corp.local');
      const ipconfig = await pc.executeCommand('ipconfig /all');
      expect(ipconfig).toContain('corp.local');
    });

    it('should clear DNS suffix when set to empty', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh dnsclient set global dnssuffix=corp.local');
      await pc.executeCommand('netsh dnsclient set global dnssuffix=');
      const state = await pc.executeCommand('netsh dnsclient show state');
      expect(state).not.toContain('corp.local');
    });

    it('should return error for invalid set global syntax', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dnsclient set global');
      expect(result).toContain('Usage');
    });
  });

  describe('DN-04: dnsclient show encryption', () => {
    it('should show DNS encryption status', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dnsclient show encryption');
      // Stub: no encryption configured
      expect(result).toContain('encryption');
    });
  });

  describe('DN-05: dnsclient show help', () => {
    it('should display show sub-context help', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand('netsh dnsclient show ?');
      expect(result).toContain('state');
      expect(result).toContain('encryption');
    });
  });
});

// ─── Group 3: Integration ───────────────────────────────────────────

describe('Group 3: dhcpclient + dnsclient integration', () => {

  it('should reflect DNS suffix in ipconfig basic output', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh dnsclient set global dnssuffix=lab.internal');
    const ipconfig = await pc.executeCommand('ipconfig');
    // Basic ipconfig shows "Connection-specific DNS Suffix" per adapter
    // Primary DNS suffix should appear somewhere
    expect(ipconfig).toContain('lab.internal');
  });

  it('should show full DHCP+DNS state after network configuration', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    // Configure network
    await pc.executeCommand(
      'netsh interface ip set address "Ethernet 0" static 192.168.1.100 255.255.255.0 192.168.1.1'
    );
    await pc.executeCommand(
      'netsh interface ip set dns "Ethernet 0" static 192.168.1.1'
    );
    await pc.executeCommand('netsh dnsclient set global dnssuffix=mynetwork.local');

    // Verify dhcpclient list shows the IP
    const dhcpList = await pc.executeCommand('netsh dhcpclient list');
    expect(dhcpList).toContain('192.168.1.100');

    // Verify dnsclient show state shows DNS + suffix
    const dnsState = await pc.executeCommand('netsh dnsclient show state');
    expect(dnsState).toContain('192.168.1.1');
    expect(dnsState).toContain('mynetwork.local');
  });

  it('should reset DNS suffix on stack reset', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh dnsclient set global dnssuffix=old.domain');
    await pc.executeCommand('netsh int ip reset');
    const state = await pc.executeCommand('netsh dnsclient show state');
    expect(state).not.toContain('old.domain');
  });
});
