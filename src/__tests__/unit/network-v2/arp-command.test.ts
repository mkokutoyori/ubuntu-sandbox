/**
 * TDD tests for the `arp` command on Linux and Windows devices.
 *
 * Covers:
 *  - Linux: arp, arp -a, arp -n, arp -e, arp -a <ip>, arp -d <ip>, arp -s <ip> <mac>,
 *           arp -i <iface>, arp --help, arp -V, combined flags
 *  - Windows: arp -a, arp -g, arp -a <ip>, arp -d <ip>, arp -d *, arp -s <ip> <mac>,
 *             arp -a -N <iface_ip>, arp -v, arp /?
 *  - EndHost: addStaticARP(), deleteARP(), static vs dynamic entries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupLinuxLAN() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw };
}

function setupWindowsLAN() {
  const pc1 = new WindowsPC('WPC1', 0, 0);
  const pc2 = new WindowsPC('WPC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw };
}

/** Populate ARP table by pinging so there's real data. */
async function populateArp(src: LinuxPC | WindowsPC, dstIP: string) {
  // ping generates ARP exchange which populates the table
  if (src instanceof LinuxPC) {
    await src.executeCommand(`ping -c 1 ${dstIP}`);
  } else {
    await src.executeCommand(`ping -n 1 ${dstIP}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// LINUX ARP COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('Linux arp command', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── arp (no args) / arp -a ─────────────────────────────────────

  describe('arp / arp -a — display table', () => {
    it('should show empty output when ARP table is empty', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      const result = await pc1.executeCommand('arp');
      // Empty table: no entries, no header
      expect(result.trim()).toBe('');
    });

    it('should display ARP entries after a ping', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('ether');
      expect(result).toContain('eth0');
    });

    it('should display the same output for arp and arp -a', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const r1 = await pc1.executeCommand('arp');
      const r2 = await pc1.executeCommand('arp -a');
      expect(r1).toBe(r2);
    });
  });

  // ─── arp -n — no name resolution ────────────────────────────────

  describe('arp -n — numeric output', () => {
    it('should display IP addresses without hostname resolution', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -n');
      expect(result).toContain('10.0.0.2');
      // -n uses tabular format with header
      expect(result).toContain('Address');
      expect(result).toContain('HWtype');
      expect(result).toContain('HWaddress');
    });
  });

  // ─── arp -e — Linux default tabular format ──────────────────────

  describe('arp -e — tabular format', () => {
    it('should display entries in tabular format with header', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -e');
      expect(result).toContain('Address');
      expect(result).toContain('HWtype');
      expect(result).toContain('HWaddress');
      expect(result).toContain('Flags');
      expect(result).toContain('Mask');
      expect(result).toContain('Iface');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('C');  // C flag = complete/dynamic entry
    });
  });

  // ─── arp -a <ip> — filter by IP ─────────────────────────────────

  describe('arp -a <ip> — filter by IP', () => {
    it('should show only the matching entry', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -a 10.0.0.2');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('ether');
    });

    it('should return empty/no entry for unknown IP', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const result = await pc1.executeCommand('arp -a 10.0.0.99');
      // No entry found — nothing or a specific message
      expect(result).not.toContain('ether');
    });
  });

  // ─── arp -i <iface> — filter by interface ───────────────────────

  describe('arp -i <iface> — filter by interface', () => {
    it('should only show entries learned on the specified interface', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -i eth0');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('eth0');
    });

    it('should show nothing for an interface with no ARP entries', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -i eth1');
      expect(result.trim()).toBe('');
    });
  });

  // ─── arp -s <ip> <mac> — add static entry ──────────────────────

  describe('arp -s — add static entry', () => {
    it('should add a static ARP entry', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const result = await pc1.executeCommand('arp -s 10.0.0.50 aa:bb:cc:dd:ee:ff');
      // Static add should succeed silently
      expect(result.trim()).toBe('');

      const table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.50');
      expect(table).toContain('aa:bb:cc:dd:ee:ff');
    });

    it('should show static entries with CM flags in tabular format', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc1.executeCommand('arp -s 10.0.0.50 aa:bb:cc:dd:ee:ff');

      const result = await pc1.executeCommand('arp -e');
      expect(result).toContain('10.0.0.50');
      expect(result).toContain('CM'); // CM = complete + manual/static
    });

    it('should overwrite an existing entry when adding static', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      await pc1.executeCommand('arp -s 10.0.0.2 11:22:33:44:55:66');
      const result = await pc1.executeCommand('arp -a');
      expect(result).toContain('11:22:33:44:55:66');
    });

    it('should reject arp -s with missing arguments', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const r1 = await pc1.executeCommand('arp -s');
      expect(r1.toLowerCase()).toContain('usage');

      const r2 = await pc1.executeCommand('arp -s 10.0.0.50');
      expect(r2.toLowerCase()).toContain('usage');
    });

    it('should reject arp -s with invalid MAC address', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const result = await pc1.executeCommand('arp -s 10.0.0.50 invalid-mac');
      expect(result.toLowerCase()).toMatch(/invalid|error/);
    });
  });

  // ─── arp -d <ip> — delete entry ────────────────────────────────

  describe('arp -d — delete entry', () => {
    it('should delete a specific ARP entry', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      // Verify entry exists
      let table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.2');

      // Delete it
      const result = await pc1.executeCommand('arp -d 10.0.0.2');
      expect(result.trim()).toBe('');

      // Verify it's gone
      table = await pc1.executeCommand('arp -a');
      expect(table).not.toContain('10.0.0.2');
    });

    it('should handle deleting a non-existent entry gracefully', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const result = await pc1.executeCommand('arp -d 10.0.0.99');
      // Linux outputs "No ARP entry for ..." or similar
      expect(result.toLowerCase()).toContain('no arp entry');
    });

    it('should reject arp -d with no IP argument', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

      const result = await pc1.executeCommand('arp -d');
      expect(result.toLowerCase()).toContain('usage');
    });

    it('should delete a static entry', async () => {
      const { pc1 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc1.executeCommand('arp -s 10.0.0.50 aa:bb:cc:dd:ee:ff');

      let table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.50');

      await pc1.executeCommand('arp -d 10.0.0.50');
      table = await pc1.executeCommand('arp -a');
      expect(table).not.toContain('10.0.0.50');
    });
  });

  // ─── arp --help / arp -V ────────────────────────────────────────

  describe('arp --help / arp -V', () => {
    it('should display usage info for --help', async () => {
      const { pc1 } = setupLinuxLAN();

      const result = await pc1.executeCommand('arp --help');
      expect(result).toContain('Usage');
      expect(result).toContain('-a');
      expect(result).toContain('-d');
      expect(result).toContain('-s');
    });

    it('should display version for -V', async () => {
      const { pc1 } = setupLinuxLAN();

      const result = await pc1.executeCommand('arp -V');
      expect(result).toContain('net-tools');
    });
  });

  // ─── Combined flags ─────────────────────────────────────────────

  describe('combined flags', () => {
    it('arp -an should show numeric tabular output', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -an');
      expect(result).toContain('10.0.0.2');
      // -n produces tabular format with header
      expect(result).toContain('Address');
    });

    it('arp -en should show tabular format with no resolution', async () => {
      const { pc1, pc2 } = setupLinuxLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -en');
      expect(result).toContain('Address');
      expect(result).toContain('HWtype');
      expect(result).toContain('10.0.0.2');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// WINDOWS ARP COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('Windows arp command', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── arp -a / arp -g — display table ────────────────────────────

  describe('arp -a / arp -g — display table', () => {
    it('should show "No ARP Entries Found." when table is empty', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      const result = await pc1.executeCommand('arp -a');
      expect(result).toContain('No ARP Entries Found');
    });

    it('should display entries grouped by interface after ping', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -a');
      expect(result).toContain('Interface:');
      expect(result).toContain('Internet Address');
      expect(result).toContain('Physical Address');
      expect(result).toContain('Type');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('dynamic');
    });

    it('arp -g should produce the same output as arp -a', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const r1 = await pc1.executeCommand('arp -a');
      const r2 = await pc1.executeCommand('arp -g');
      expect(r1).toBe(r2);
    });
  });

  // ─── arp -a <ip> — filter by IP ─────────────────────────────────

  describe('arp -a <ip> — filter by IP', () => {
    it('should show only the matching entry', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -a 10.0.0.2');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('dynamic');
    });

    it('should show "No ARP Entries Found." for unknown IP', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      const result = await pc1.executeCommand('arp -a 10.0.0.99');
      expect(result).toContain('No ARP Entries Found');
    });
  });

  // ─── arp -a -N <iface_ip> — filter by interface IP ──────────────

  describe('arp -a -N <iface_ip> — filter by interface', () => {
    it('should filter entries by interface IP', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -a -N 10.0.0.1');
      expect(result).toContain('Interface: 10.0.0.1');
      expect(result).toContain('10.0.0.2');
    });

    it('should show nothing for an interface with no entries', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      const result = await pc1.executeCommand('arp -a -N 10.0.0.1');
      expect(result).toContain('No ARP Entries Found');
    });
  });

  // ─── arp -s <ip> <mac> — add static entry ──────────────────────

  describe('arp -s — add static entry', () => {
    it('should add a static ARP entry', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      const result = await pc1.executeCommand('arp -s 10.0.0.50 aa-bb-cc-dd-ee-ff');
      expect(result.trim()).toBe('');

      const table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.50');
      expect(table).toContain('aa-bb-cc-dd-ee-ff');
      expect(table).toContain('static');
    });

    it('should accept MAC with colons and convert to hyphens', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      await pc1.executeCommand('arp -s 10.0.0.50 aa:bb:cc:dd:ee:ff');

      const table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.50');
      // Windows displays with hyphens
      expect(table).toContain('aa-bb-cc-dd-ee-ff');
      expect(table).toContain('static');
    });

    it('should reject arp -s with missing arguments', async () => {
      const { pc1 } = setupWindowsLAN();

      const r1 = await pc1.executeCommand('arp -s');
      // Shows help/usage
      expect(r1).toContain('ARP');

      const r2 = await pc1.executeCommand('arp -s 10.0.0.50');
      expect(r2).toContain('ARP');
    });
  });

  // ─── arp -d <ip> — delete entry ────────────────────────────────

  describe('arp -d — delete entry', () => {
    it('should delete a specific entry', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      let table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.2');

      await pc1.executeCommand('arp -d 10.0.0.2');

      table = await pc1.executeCommand('arp -a');
      expect(table).not.toContain('10.0.0.2');
    });

    it('should delete all entries with arp -d *', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      // Add a static entry too
      await pc1.executeCommand('arp -s 10.0.0.50 aa-bb-cc-dd-ee-ff');

      let table = await pc1.executeCommand('arp -a');
      expect(table).toContain('10.0.0.2');
      expect(table).toContain('10.0.0.50');

      await pc1.executeCommand('arp -d *');

      table = await pc1.executeCommand('arp -a');
      expect(table).toContain('No ARP Entries Found');
    });

    it('should silently accept deleting a non-existent entry', async () => {
      const { pc1 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');

      // Windows accepts this silently
      const result = await pc1.executeCommand('arp -d 10.0.0.99');
      expect(result.trim()).toBe('');
    });
  });

  // ─── arp /? — help ──────────────────────────────────────────────

  describe('arp /? — help', () => {
    it('should display full usage help', async () => {
      const { pc1 } = setupWindowsLAN();

      const result = await pc1.executeCommand('arp /?');
      expect(result).toContain('ARP');
      expect(result).toContain('-a');
      expect(result).toContain('-d');
      expect(result).toContain('-s');
      expect(result).toContain('inet_addr');
    });
  });

  // ─── arp -v — verbose mode ──────────────────────────────────────

  describe('arp -v — verbose mode', () => {
    it('should display entries in verbose mode', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');

      const result = await pc1.executeCommand('arp -a -v');
      expect(result).toContain('10.0.0.2');
      expect(result).toContain('Interface:');
    });
  });

  // ─── Static vs dynamic display ──────────────────────────────────

  describe('static vs dynamic display', () => {
    it('should show "dynamic" for learned entries and "static" for manual entries', async () => {
      const { pc1, pc2 } = setupWindowsLAN();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      await pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.2 255.255.255.0');
      await populateArp(pc1, '10.0.0.2');
      await pc1.executeCommand('arp -s 10.0.0.50 aa-bb-cc-dd-ee-ff');

      const result = await pc1.executeCommand('arp -a');
      const lines = result.split('\n');

      const dynamicLine = lines.find(l => l.includes('10.0.0.2'));
      expect(dynamicLine).toContain('dynamic');

      const staticLine = lines.find(l => l.includes('10.0.0.50'));
      expect(staticLine).toContain('static');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENDHOST — addStaticARP / deleteARP methods
// ═══════════════════════════════════════════════════════════════════

describe('EndHost ARP table management', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  it('addStaticARP should add an entry accessible via getARPTable()', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const mac = new MACAddress('aa:bb:cc:dd:ee:ff');
    pc.addStaticARP('10.0.0.50', mac, 'eth0');

    const table = pc.getARPTable();
    expect(table.has('10.0.0.50')).toBe(true);
    expect(table.get('10.0.0.50')!.toString()).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('deleteARP should remove an existing entry', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const mac = new MACAddress('aa:bb:cc:dd:ee:ff');
    pc.addStaticARP('10.0.0.50', mac, 'eth0');

    const deleted = pc.deleteARP('10.0.0.50');
    expect(deleted).toBe(true);

    const table = pc.getARPTable();
    expect(table.has('10.0.0.50')).toBe(false);
  });

  it('deleteARP should return false for non-existent entry', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const deleted = pc.deleteARP('10.0.0.99');
    expect(deleted).toBe(false);
  });

  it('clearARPTable should remove all entries', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    pc.addStaticARP('10.0.0.1', new MACAddress('aa:bb:cc:dd:ee:01'), 'eth0');
    pc.addStaticARP('10.0.0.2', new MACAddress('aa:bb:cc:dd:ee:02'), 'eth0');

    pc.clearARPTable();
    expect(pc.getARPTable().size).toBe(0);
  });

  it('static entries should be distinguishable from dynamic ones', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 100, 0);
    const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);
    const cable1 = new Cable('c1');
    cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    const cable2 = new Cable('c2');
    cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    // Dynamic entry via ping
    await pc1.executeCommand('ping -c 1 10.0.0.2');

    // Static entry
    pc1.addStaticARP('10.0.0.50', new MACAddress('aa:bb:cc:dd:ee:ff'), 'eth0');

    const table = pc1.getARPTableFull();
    const dynamicEntry = table.get('10.0.0.2');
    const staticEntry = table.get('10.0.0.50');

    expect(dynamicEntry).toBeDefined();
    expect(dynamicEntry!.type).toBe('dynamic');
    expect(staticEntry).toBeDefined();
    expect(staticEntry!.type).toBe('static');
  });
});
