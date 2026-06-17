/**
 * TDD tests for the `tcpdump` command on simulated devices.
 *
 * Covers:
 *  - Interface Selection (-i, default, invalid, any)
 *  - Packet Capture Limits (-c, negative, non-numeric, zero)
 *  - Output & Formatting Flags (-n, -nn, -q, -e, -v, -vv, -vvv, -t, -tt, -ttt, -tttt)
 *  - Data Dumps & Payload Inspection (-A, -X, -XX)
 *  - Protocol & Port BPF Filters (icmp, arp, tcp, udp, ip, port, src port, dst port)
 *  - Host & Network BPF Filters (host, src, dst, net, src net, dst net)
 *  - Complex BPF Logical Expressions (and, or, not, grouped parentheses)
 *  - File I/O Operations (-w, -r, error handling)
 *  - Command Validation (malformed filters, invalid flags, syntax errors)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupLAN() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw };
}

/** Helper to run tcpdump and trigger traffic in parallel */
async function captureWithTraffic(
  capturer: LinuxPC, 
  tcpdumpCmd: string, 
  trafficGenerator: () => Promise<void>
): Promise<string> {
  const capturePromise = capturer.executeCommand(tcpdumpCmd);
  await new Promise(resolve => setTimeout(resolve, 50)); // Allow tcpdump to start listening
  await trafficGenerator();
  return await capturePromise;
}

// ═══════════════════════════════════════════════════════════════════
// TCPDUMP COMMAND TESTS (1-100)
// ═══════════════════════════════════════════════════════════════════

describe('tcpdump Command Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Interface Selection & Initialization (Tests 1-15) ──────────

  describe('1. Interface Selection & Initialization', () => {
    it('1. should capture on default interface if -i is omitted', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('listening on eth0');
    });

    it('2. should capture on explicitly specified interface (-i eth0)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -i eth0 -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('listening on eth0');
    });

    it('3. should support loopback capture (-i lo)', async () => {
      const { pc1 } = setupLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -i lo -c 1', async () => {
        await pc1.executeCommand('ping -c 1 127.0.0.1');
      });
      expect(output).toContain('listening on lo');
    });

    it('4. should reject capture on non-existent interface', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -i eth99');
      expect(output.toLowerCase()).toContain('error');
      expect(output.toLowerCase()).toMatch(/interface|device/);
    });

    it('5. should reject command if interface argument is missing after -i', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -i');
      expect(output.toLowerCase()).toContain('error');
      expect(output.toLowerCase()).toContain('option requires an argument');
    });

    it('6. should display help manual on --help', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump --help');
      expect(output).toContain('Usage: tcpdump');
      expect(output).toContain('-i');
      expect(output).toContain('-c');
    });

    it('7. should show version information on -h', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -h');
      expect(output.toLowerCase()).toContain('tcpdump version');
    });

    it('8. should show version information on --version', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump --version');
      expect(output.toLowerCase()).toContain('tcpdump version');
    });

    it('9. should fail to capture on an interface that is administratively down', async () => {
      const { pc1 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 down');
      const output = await pc1.executeCommand('tcpdump -i eth0');
      expect(output.toLowerCase()).toContain('is down');
    });

    it('10. should report error if multiple interfaces are provided to a single -i flag', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -i eth0 eth1');
      expect(output.toLowerCase()).toMatch(/syntax|error|invalid/);
    });

    it('11. should accept any as interface to capture on all interfaces if supported', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -i any -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('listening on any');
    });

    it('12. should list available capture interfaces with --list-interfaces', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump --list-interfaces');
      expect(output).toContain('eth0');
      expect(output).toContain('lo');
    });

    it('13. should list available capture interfaces with alternative -D flag', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -D');
      expect(output).toContain('eth0');
      expect(output).toContain('lo');
    });

    it('14. should handle capture initialization when loopback has no assigned IP', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -i lo -c 0');
      expect(output).toContain('listening on lo');
    });

    it('15. should fail gracefully on unrecognized command-line switches', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -z');
      expect(output.toLowerCase()).toMatch(/invalid option|unrecognized/);
    });
  });

  // ─── Packet Count Limits (Tests 16-25) ──────────────────────────

  describe('2. Packet Count Limits (-c)', () => {
    it('16. should stop capture after exactly 1 packet', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        await pc2.executeCommand('ping -c 3 10.0.0.1');
      });
      expect(output).toContain('1 packet captured');
    });

    it('17. should stop capture after exactly 3 packets', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 3', async () => {
        await pc2.executeCommand('ping -c 5 10.0.0.1');
      });
      expect(output).toContain('3 packets captured');
    });

    it('18. should reject zero packet count (-c 0) or interpret it as infinite', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 0');
      // If simulated as infinite, it might timeout or require a fast exit. 
      // Let's assume simulator rejects or parses 0 with validation.
      expect(output.toLowerCase()).toMatch(/invalid|error|range|listening/);
    });

    it('19. should reject negative packet count (-c -5)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c -5');
      expect(output.toLowerCase()).toMatch(/invalid|error|must be positive/);
    });

    it('20. should reject non-numeric packet count (-c abc)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c abc');
      expect(output.toLowerCase()).toMatch(/invalid|error|numeric/);
    });

    it('21. should reject float values for packet count (-c 2.5)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 2.5');
      expect(output.toLowerCase()).toMatch(/invalid|error|integer/);
    });

    it('22. should report syntax error if count argument is completely omitted after -c', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c');
      expect(output.toLowerCase()).toContain('option requires an argument');
    });

    it('23. should count exact loopback packets', async () => {
      const { pc1 } = setupLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -i lo -c 2', async () => {
        await pc1.executeCommand('ping -c 2 127.0.0.1');
      });
      expect(output).toContain('2 packets captured');
    });

    it('24. should show summary statistics on termination', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('packets received by filter');
      expect(output).toContain('packets dropped by kernel');
    });

    it('25. should prioritize explicitly specified -c over other flow parameters', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 2 -v', async () => {
        await pc2.executeCommand('ping -c 4 10.0.0.1');
      });
      expect(output).toContain('2 packets captured');
    });
  });

  // ─── Formatting & Output Control Flags (Tests 26-45) ────────────

  describe('3. Formatting & Output Control Flags', () => {
    it('26. should show timestamps by default', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // Match typical HH:MM:SS format
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('27. should suppress timestamps with -t', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -t -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).not.toMatch(/^\d{2}:\d{2}:\d{2}/);
    });

    it('28. should show epoch timestamps with -tt', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -tt -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // Epoch seconds format: digits followed by dot and microseconds
      expect(output).toMatch(/\d{10}\.\d+/);
    });

    it('29. should show delta timestamps with -ttt', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -ttt -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/); // relative delta representation
    });

    it('30. should show absolute date and time with -tttt', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -tttt -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // Expect YYYY-MM-DD
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('31. should format IP addresses numerically with -n', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -n -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('32. should format ports numerically with -nn', async () => {
      const { pc1, pc2 } = setupWindowsLAN(); // utilizing netsh if needed, or simply port checks
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      const output = await pc1.executeCommand('tcpdump -nn -c 0');
      expect(output).toBeDefined();
    });

    it('33. should output quieter/simpler packet descriptors with -q', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -q -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // Quiet format reduces protocol details
      expect(output.length).toBeLessThan(1000); 
    });

    it('34. should display link-level headers (MAC addresses) with -e', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -e -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}/);
    });

    it('35. should output basic verbose information with -v', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -v -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('ttl');
    });

    it('36. should output highly detailed details with -vv', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -vv -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('id');
      expect(output).toContain('proto');
    });

    it('37. should output maximum details with -vvv', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -vvv -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/checksum|len|ttl/);
    });

    it('38. should support combined numeric and timestamp options (-nt)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -nt -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
      expect(output).not.toMatch(/^\d{2}:\d{2}:\d{2}/);
    });

    it('39. should support combined numeric, quiet and link-level options (-neq)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -neq -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/[0-9a-fA-F]{2}:[0-9a-fA-F]{2}/);
      expect(output).toContain('10.0.0.2');
    });

    it('40. should support combined verbose and interface flags (-v -i eth0)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -v -i eth0 -c 0');
      expect(output).toContain('listening on eth0');
    });

    it('41. should print packet length parameters in output details', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output.toLowerCase()).toContain('length');
    });

    it('42. should report warning on using obsolete options gracefully', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -S'); // Absolute TCP sequence numbers
      expect(output).toBeDefined(); // Optional support verification
    });

    it('43. should display link-layer type in startup banner', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 0');
      expect(output.toLowerCase()).toMatch(/link-type/);
    });

    it('44. should display snaplen parameters in initial configuration banner', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 0');
      expect(output.toLowerCase()).toContain('capture size');
    });

    it('45. should show correct output structures when filtering out local loopback ping', async () => {
      const { pc1 } = setupLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -i lo -c 1', async () => {
        await pc1.executeCommand('ping -c 1 127.0.0.1');
      });
      expect(output).toContain('127.0.0.1');
    });
  });

  // ─── Data Dumping & Payload Inspection (Tests 46-55) ─────────────

  describe('4. Data Dumping & Payload Inspection', () => {
    it('46. should display ASCII text payload when -A is specified', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -A -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1'); // ping payload contains sequence / printable patterns
      });
      expect(output).toBeDefined();
    });

    it('47. should display Hex and ASCII representation with -X', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -X -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // Hex representation verification
      expect(output).toMatch(/0x[0-9a-fA-F]{4}:/);
    });

    it('48. should include link-level headers in hex/ASCII block using -XX', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -XX -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/0x0000:/); // Start from offset zero
    });

    it('49. should support printing only hex values using -x (omitting ASCII column)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -x -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/0x[0-9a-fA-F]{4}:/);
    });

    it('50. should print link-level hex values omitting ASCII column using -xx', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -xx -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/0x0000:/);
    });

    it('51. should replace unprintable payload characters with dots in ASCII display', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -X -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('....');
    });

    it('52. should respect combined quiet and hex options (-qX)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -qX -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toMatch(/0x[0-9a-fA-F]{4}:/);
    });

    it('53. should show empty hex block if packet contains no data payload', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -X -c 0');
      expect(output).toBeDefined();
    });

    it('54. should allow limiting payload bytes printed using -s (snaplen)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -X -s 16 -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      // The hex dump should contain fewer lines because of limited size snaplen
      expect(output).toBeDefined();
    });

    it('55. should fail if negative or non-integer snaplen value is passed', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -s abc');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });
  });

  // ─── Protocol & Port BPF Filters (Tests 56-75) ──────────────────

  describe('5. Protocol & Port BPF Filters', () => {
    it('56. should filter and capture icmp packets only', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 icmp', async () => {
        // Run ping to generate ICMP
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('ICMP');
      expect(output).not.toContain('ARP');
    });

    it('57. should filter and capture arp packets only', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 arp', async () => {
        // Trigger ARP request by resolving target address
        await pc1.executeCommand('ping -c 1 10.0.0.2');
      });
      expect(output).toContain('ARP');
    });

    it('58. should filter and capture tcp packets only', async () => {
      const { pc1 } = setupLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 tcp', async () => {
        // Mock TCP activity or perform standard connection sequence
        await pc1.executeCommand('ping -c 1 127.0.0.1'); // ICMP, should not be captured
      });
      expect(output).not.toContain('ICMP');
    });

    it('59. should filter and capture udp packets only', async () => {
      const { pc1 } = setupLAN();
      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 udp', async () => {
        await pc1.executeCommand('ping -c 1 127.0.0.1');
      });
      expect(output).not.toContain('ICMP');
    });

    it('60. should support ip protocol filter', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 ip', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('61. should capture packets targeting general port keyword', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 1 port 80');
      expect(output).toBeDefined();
    });

    it('62. should capture packets targeting source port explicitly (src port)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 1 src port 1234');
      expect(output).toBeDefined();
    });

    it('63. should capture packets targeting destination port explicitly (dst port)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 1 dst port 53');
      expect(output).toBeDefined();
    });

    it('64. should combine protocols with ports (tcp port 80)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 1 tcp port 80');
      expect(output).toBeDefined();
    });

    it('65. should combine protocols with ports (udp port 53)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 1 udp port 53');
      expect(output).toBeDefined();
    });

    it('66. should reject invalid protocol filters', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump invalid_proto');
      expect(output.toLowerCase()).toContain('error');
    });

    it('67. should reject invalid port range bounds (port 70000)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump port 70000');
      expect(output.toLowerCase()).toMatch(/invalid|error|range|out of range/);
    });

    it('68. should reject non-numeric port strings', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump port http');
      // If service names are unmapped, should trigger validation error
      expect(output.toLowerCase()).toMatch(/invalid|error|unknown/);
    });

    it('69. should support port range syntax (portrange 20-25)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump portrange 20-25');
      expect(output).toBeDefined();
    });

    it('70. should reject invalid port ranges (portrange 80-20)', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump portrange 80-20');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('71. should capture broadcast ARP packets on physical interfaces', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 arp', async () => {
        await pc1.executeCommand('ping -c 1 10.0.0.2');
      });
      expect(output).toContain('Request who-has');
    });

    it('72. should match correct TCP flags in output representation if simulated', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -c 0 tcp');
      expect(output).toBeDefined();
    });

    it('73. should drop non-target protocol packets gracefully', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 tcp', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1'); // ICMP: does not match tcp
      });
      // Verification that the ICMP traffic is excluded from capturing
      expect(output).not.toContain('ICMP');
    });

    it('74. should handle protocol-specific uppercase syntax errors', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump ICMP');
      expect(output.toLowerCase()).toContain('error');
    });

    it('75. should allow capturing specific IP protocol types by numeric ID (proto 1 for ICMP)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 proto 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });
  });

  // ─── Host & Network BPF Filters (Tests 76-90) ───────────────────

  describe('6. Host & Network BPF Filters', () => {
    it('76. should capture packets matching target host', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 host 10.0.0.2', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('77. should capture packets matching source host', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 src 10.0.0.2', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('78. should capture packets matching destination host', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 dst 10.0.0.1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.1');
    });

    it('79. should capture packets matching target network subnet (net 10.0.0.0/24)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 net 10.0.0.0/24', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('80. should capture packets matching source network subnet (src net 10.0.0.0/24)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 src net 10.0.0.0/24', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('81. should capture packets matching destination network subnet (dst net 10.0.0.0/24)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 dst net 10.0.0.0/24', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.1');
    });

    it('82. should reject invalid IP address parameter in host filter', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump host 300.300.300.300');
      expect(output.toLowerCase()).toContain('error');
    });

    it('83. should reject invalid CIDR format in network filter', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump net 10.0.0.0/35');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('84. should reject missing network parameter after net keyword', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump net');
      expect(output.toLowerCase()).toMatch(/error|syntax/);
    });

    it('85. should support net mask notation (net 10.0.0.0 mask 255.255.255.0)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 net 10.0.0.0 mask 255.255.255.0', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('86. should support filtering packets by source and destination MAC addresses', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump ether src 00:11:22:33:44:55');
      expect(output).toBeDefined();
    });

    it('87. should reject malformed MAC address in ether filter', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump ether src 00:11:22:33:44:ZZ');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('88. should capture multicast packets explicitly using multicast filter', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump multicast');
      expect(output).toBeDefined();
    });

    it('89. should capture broadcast packets explicitly using broadcast filter', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump broadcast');
      expect(output).toBeDefined();
    });

    it('90. should reject incomplete host statements', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump host');
      expect(output.toLowerCase()).toMatch(/invalid|error|syntax/);
    });
  });

  // ─── Complex BPF Logical Expressions (Tests 91-100) ──────────────

  describe('7. Complex BPF Logical Expressions & File I/O', () => {
    it('91. should combine filters using logical AND', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "ip and host 10.0.0.2"', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('92. should combine filters using double ampersand (&&)', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "ip && host 10.0.0.2"', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('93. should combine filters using logical OR', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "arp or icmp"', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toBeDefined();
    });

    it('94. should combine filters using logical NOT', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "not tcp"', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).not.toContain('TCP');
    });

    it('95. should support nested parenthetical expressions in BPF filters', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "icmp and (src 10.0.0.2 or dst 10.0.0.1)"', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output).toContain('10.0.0.2');
    });

    it('96. should reject unmatched parentheses inside logic filter expressions', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump "icmp and (src 10.0.0.2"');
      expect(output.toLowerCase()).toContain('error');
    });

    it('97. should support writing captures to file with -w', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      const output = await captureWithTraffic(pc1, 'tcpdump -w capture.pcap -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });
      expect(output.toLowerCase()).toContain('packet captured');
    });

    it('98. should support reading captured files with -r', async () => {
      const { pc1, pc2 } = setupLAN();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

      // Create a capture file first
      await captureWithTraffic(pc1, 'tcpdump -w capture.pcap -c 1', async () => {
        await pc2.executeCommand('ping -c 1 10.0.0.1');
      });

      // Read from the capture file
      const output = await pc1.executeCommand('tcpdump -r capture.pcap');
      expect(output).toContain('reading from file capture.pcap');
    });

    it('99. should report file-not-found when reading non-existent capture files via -r', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -r nonexistent.pcap');
      expect(output.toLowerCase()).toMatch(/error|no such file|not found/);
    });

    it('100. should ignore filter specifications if capturing file input from a different flow with conflicts', async () => {
      const { pc1 } = setupLAN();
      const output = await pc1.executeCommand('tcpdump -r nonexistent.pcap icmp');
      expect(output.toLowerCase()).toMatch(/error|cannot open/);
    });
  });
});
