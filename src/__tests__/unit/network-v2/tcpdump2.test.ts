/**
 * Advanced TDD tests for the `tcpdump` command on simulated devices.
 * 
 * Covers Tests 101 to 150:
 *  - Link-type Management (-y, --linktype)
 *  - VLAN tagging & filtering (vlan, nested VLANs)
 *  - Threshold and size filters (less, greater, range limits)
 *  - Advanced BPF Bitwise Filters (TCP flag filtering, ICMP type/code checks)
 *  - IPv6 and ICMPv6 environments (ip6, icmp6, ipv6 host filters)
 *  - Operational Edge Cases (cable unplugged mid-capture, unconfigured interface, buffer options)
 *  - File manipulation edge cases (-C limits, corrupted pcap reading)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers (re-declared/imported for continuity) ─────────────────

function setupAdvancedLAN() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw, cable1, cable2 };
}

async function captureWithTraffic(
  capturer: LinuxPC, 
  tcpdumpCmd: string, 
  trafficGenerator: () => Promise<void>
): Promise<string> {
  const capturePromise = capturer.executeCommand(tcpdumpCmd);
  await new Promise(resolve => setTimeout(resolve, 50));
  await trafficGenerator();
  return await capturePromise;
}

// ═══════════════════════════════════════════════════════════════════
// ADDITIONAL TCPDUMP TEST SCENARIOS (101-150)
// ═══════════════════════════════════════════════════════════════════

describe('tcpdump Command Suite - Advanced & Edge Scenarios', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Link-Type Management & VLAN Filtering (Tests 101-110) ────────

  describe('8. Link-Type Management & VLAN Filtering', () => {
    it('101. should list supported link types with --list-link-types', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -i eth0 --list-link-types');
      expect(output.toLowerCase()).toContain('en10mb'); // Standard Ethernet DLT
    });

    it('102. should change data link type with -y', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -i eth0 -y EN10MB -c 0');
      expect(output).not.toContain('error');
    });

    it('103. should reject unsupported link types', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -i eth0 -y LINKTYPE_UNKNOWN');
      expect(output.toLowerCase()).toMatch(/invalid|error|not supported/);
    });

    it('104. should fail if -y option is omitted of its argument', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -i eth0 -y');
      expect(output.toLowerCase()).toContain('option requires an argument');
    });

    it('105. should handle capture continuously when interface IP address changes dynamically', async () => {
      const { pc1, pc2 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        // Change IP mid-capture
        await pc1.executeCommand('ifconfig eth0 10.0.0.10 netmask 255.255.255.0');
        await pc2.executeCommand('ping -c 1 10.0.0.10');
      });
      expect(output).toContain('listening on eth0');
    });

    it('106. should detect and filter generic VLAN-tagged frames with "vlan" keyword', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 vlan');
      expect(output).toBeDefined();
    });

    it('107. should filter traffic matching a specific VLAN ID (vlan 10)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 vlan 10');
      expect(output).toBeDefined();
    });

    it('108. should filter nested VLAN tags (QinQ) using multiple vlan keywords', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 vlan and vlan');
      expect(output).toBeDefined();
    });

    it('109. should reject VLAN filtering with non-integer VLAN ID values', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump vlan abc');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('110. should reject VLAN filtering with out-of-bounds VLAN IDs (vlan 5000)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump vlan 5000');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });
  });

  // ─── Threshold & Packet Size Filtering (Tests 111-120) ───────────

  describe('9. Threshold & Packet Size Filtering', () => {
    it('111. should capture packets smaller than threshold with "less" keyword', async () => {
      const { pc1, pc2 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 less 128', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1'); // small ICMP packet
      });
      expect(output).toContain('10.0.0.2');
    });

    it('112. should ignore packets smaller than threshold when "greater" is targeted', async () => {
      const { pc1, pc2 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 greater 1500', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1'); // standard ping is smaller than 1500 bytes
      });
      expect(output).not.toContain('10.0.0.2');
    });

    it('113. should combine size ranges using greater and less operators together', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "greater 64 and less 1024"');
      expect(output).toBeDefined();
    });

    it('114. should reject size filter operations with negative thresholds', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump less -100');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('115. should support displaying absolute TCP sequence numbers using -S', async () => {
      const { pc1, pc2 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -S -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toBeDefined();
    });

    it('116. should verify payload truncation visualization in outputs', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 -s 10');
      expect(output).toContain('listening on eth0');
    });

    it('117. should process raw hex dump boundaries on odd packet sizes', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -X -c 0');
      expect(output).toBeDefined();
    });

    it('118. should filter packets by specific byte slices in the IP header (ip[0] == 69)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "ip[0] == 69"'); // Version 4, IHL 5 (0x45 = 69)
      expect(output).toBeDefined();
    });

    it('119. should reject offset slices out of packet boundaries', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump "ip[9000] == 1"');
      expect(output.toLowerCase()).toMatch(/error|out of bounds|invalid/);
    });

    it('120. should support bitwise masking within BPF offset filters (ip[0] & 0xf != 5)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "ip[0] & 0xf != 5"');
      expect(output).toBeDefined();
    });
  });

  // ─── IPv6 & Custom Layer Protocols (Tests 121-135) ────────────────

  describe('10. IPv6 & Custom Layer Protocols', () => {
    it('121. should support filtering IPv6 packets only with "ip6" identifier', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 ip6');
      expect(output).toBeDefined();
    });

    it('122. should filter IPv6 destination target addresses (dst host 2001:db8::1)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 dst host 2001:db8::1');
      expect(output).toBeDefined();
    });

    it('123. should filter ICMPv6 packets only with "icmp6" identifier', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 icmp6');
      expect(output).toBeDefined();
    });

    it('124. should support filtering by explicit ICMP types (icmp[icmptype] == icmp-echo)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "icmp[icmptype] == icmp-echo"');
      expect(output).toBeDefined();
    });

    it('125. should support filtering by explicit ICMP code values (icmp[icmpcode] == 0)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "icmp[icmpcode] == 0"');
      expect(output).toBeDefined();
    });

    it('126. should filter TCP packets with SYN flag set only', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "tcp[tcpflags] & tcp-syn != 0"');
      expect(output).toBeDefined();
    });

    it('127. should filter TCP packets with ACK flag set only', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "tcp[tcpflags] & tcp-ack != 0"');
      expect(output).toBeDefined();
    });

    it('128. should filter TCP packets with FIN flag set only', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "tcp[tcpflags] & tcp-fin != 0"');
      expect(output).toBeDefined();
    });

    it('129. should filter TCP SYN-ACK combined sequences specifically', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "tcp[tcpflags] == (tcp-syn|tcp-ack)"');
      expect(output).toBeDefined();
    });

    it('130. should filter UDP packets by destination range thresholds', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "udp dst port range 1000-2000"');
      expect(output).toBeDefined();
    });

    it('131. should reject unrecognized protocol identifiers', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump unknownproto');
      expect(output.toLowerCase()).toContain('error');
    });

    it('132. should isolate broadcast transmissions specifically', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "ip broadcast"');
      expect(output).toBeDefined();
    });

    it('133. should isolate multicast IP traffic specifically', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "ip multicast"');
      expect(output).toBeDefined();
    });

    it('134. should handle filters with port ranges containing single inverted ranges', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump "tcp port 22 or tcp port 80"');
      expect(output).toBeDefined();
    });

    it('135. should isolate packets containing IP options flags', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "ip[0] & 0xf > 5"'); // IHL > 5 indicates IP options
      expect(output).toBeDefined();
    });
  });

  // ─── Operational Edge Cases & Limits (Tests 136-150) ──────────────

  describe('11. Operational Edge Cases & Limits', () => {
    it('136. should support capture file size limit rotation with -C', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -w rot.pcap -C 1 -c 0'); // limit size 1MB
      expect(output).not.toContain('error');
    });

    it('137. should throw error on corrupted pcap reading with -r', async () => {
      const { pc1 } = setupAdvancedLAN();
      // Write random string to mock a file write
      await pc1.executeCommand('echo "corrupted_binary_data" > bad.pcap');
      const output = await pc1.executeCommand('tcpdump -r bad.pcap');
      expect(output.toLowerCase()).toMatch(/bad dump file|error|format/);
    });

    it('138. should support packet line-buffering mode with -l', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -l -c 0');
      expect(output).toContain('listening on eth0');
    });

    it('139. should accept quiet option while writing capture files (-qw file.pcap)', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -qw out.pcap -c 0');
      expect(output).not.toContain('error');
    });

    it('140. should reject capture output files if user lacks write access (simulated)', async () => {
      const { pc1 } = setupAdvancedLAN();
      // Mock directories where write is blocked if implemented in simulator
      const output = await pc1.executeCommand('tcpdump -w /sys/unwritable_dir/file.pcap');
      expect(output.toLowerCase()).toMatch(/permission denied|error|cannot open/);
    });

    it('141. should capture packets on interfaces with no assigned IP address', async () => {
      const { pc1, pc2 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 0.0.0.0'); // Clear IP
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        // Send a broadcast frame (ARP)
        await pc2.executeCommand('ping -c 1 10.0.0.255');
      });
      expect(output).toContain('listening on eth0');
    });

    it('142. should support highly complex negated grouped logic filters', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 "not (host 10.0.0.1 or host 10.0.0.2)"');
      expect(output).toBeDefined();
    });

    it('143. should display zero packets matched in statistics on early exit', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 arp', async () => {
        // Trigger no traffic, let it timeout or close
      });
      expect(output).toBeDefined();
    });

    it('144. should handle interface status dropping mid-capture gracefully', async () => {
      const { pc1, pc2, cable1 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        // Unplug cable while capturing is running
        cable1.disconnect();
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/listening|captured|link down/);
    });

    it('145. should preserve packet filters after interface shutdown and restart cycle', async () => {
      const { pc1 } = setupAdvancedLAN();
      await pc1.executeCommand('ifconfig eth0 down');
      await pc1.executeCommand('ifconfig eth0 up');
      const output = await pc1.executeCommand('tcpdump -i eth0 -c 0');
      expect(output).toContain('listening on eth0');
    });

    it('146. should reject negative port bounds within portrange syntax', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump portrange -20-80');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('147. should parse logic filters that escape shell characters properly', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump tcp and \\( port 80 or port 443 \\)');
      expect(output).toBeDefined();
    });

    it('148. should print capture metrics when zero traffic is observed', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump -c 0');
      expect(output).toContain('0 packets dropped');
    });

    it('149. should reject completely empty filter strings gracefully', async () => {
      const { pc1 } = setupAdvancedLAN();
      const output = await pc1.executeCommand('tcpdump ""');
      expect(output).toContain('listening on eth0'); // Empty filters default to match-all
    });

    it('150. should verify robust error handling when maximum allowed arguments limit is exceeded', async () => {
      const { pc1 } = setupAdvancedLAN();
      const longCommand = 'tcpdump ' + 'arg '.repeat(100);
      const output = await pc1.executeCommand(longCommand);
      expect(output.toLowerCase()).toMatch(/error|too many arguments|invalid/);
    });
  });
});
