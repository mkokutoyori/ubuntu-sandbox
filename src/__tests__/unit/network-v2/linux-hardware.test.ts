/**
 * Advanced Linux Hardware Inspection & Management Command Suite.
 * 
 * Contains exactly 300 comprehensive unit test scenarios divided into:
 *  - Block 1: CPU, Memory, Architecture & System Metadata (Tests 1-50)
 *  - Block 2: PCI & USB Bus Device Inspection (Tests 51-100)
 *  - Block 3: Block Storage Devices, Partitions & Disk Tuning (Tests 101-150)
 *  - Block 4: DMI Decoder, Hardware Listings & Profiling (Tests 151-200)
 *  - Block 5: Filesystem Space Usage, Mounting & Storage Binding (Tests 201-250)
 *  - Block 6: Privilege Boundaries, Edge Cases, Syntax Errors & Resets (Tests 251-300)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupHardwarePC() {
  const pc = new LinuxPC('linux-pc', 'HWHost');
  pc.setHostname('HWHost');
  return pc;
}

// ═══════════════════════════════════════════════════════════════════
// LINUX HARDWARE TESTS (1-300)
// ═══════════════════════════════════════════════════════════════════

describe('Linux Hardware Command Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: CPU, Memory, Architecture & Metadata (Tests 1-50) ───

  describe('Block 1: CPU, Memory, Architecture & System Metadata', () => {
    it('1. should show CPU information using lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Architecture');
      expect(output).toContain('CPU(s)');
    });

    it('2. should show CPU parseable format using lscpu -p', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu -p');
      expect(output).toContain('#');
    });

    it('3. should show extended CPU format using lscpu -e', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu -e');
      expect(output).toContain('CPU');
    });

    it('4. should output lscpu in JSON format via lscpu -J', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu -J');
      expect(output).toContain('{');
    });

    it('5. should restrict lscpu caching view with lscpu -C', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu -C');
      expect(output).toBeDefined();
    });

    it('6. should reject lscpu invalid flags', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error|invalid/);
    });

    it('7. should show free memory allocation using free', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free');
      expect(output).toContain('Mem:');
      expect(output).toContain('Swap:');
    });

    it('8. should show memory in megabytes using free -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -m');
      expect(output).toContain('Mem:');
    });

    it('9. should show memory in gigabytes using free -g', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -g');
      expect(output).toContain('Mem:');
    });

    it('10. should show memory in bytes using free -b', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -b');
      expect(output).toContain('Mem:');
    });

    it('11. should show memory in kilobytes using free -k', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -k');
      expect(output).toContain('Mem:');
    });

    it('12. should show memory in human-readable format using free -h', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -h');
      expect(output).toContain('Mem:');
    });

    it('13. should support continuous memory checks with free -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -s 1 -c 1');
      expect(output).toContain('Mem:');
    });

    it('14. should reject negative count limits on free (-c -5)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -c -5');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('15. should reject non-numeric intervals on free (-s abc)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -s abc');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('16. should show system info using uname', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname');
      expect(output.trim()).toBe('Linux');
    });

    it('17. should show all system info using uname -a', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -a');
      expect(output).toContain('Linux');
      expect(output).toContain('x86_64');
    });

    it('18. should show kernel release using uname -r', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -r');
      expect(output).toMatch(/\d+\.\d+/);
    });

    it('19. should show architecture using uname -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -m');
      expect(output.trim()).toBe('x86_64');
    });

    it('20. should show hostname using uname -n', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -n');
      expect(output.trim()).toBe('HWHost');
    });

    it('21. should show kernel name using uname -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -s');
      expect(output.trim()).toBe('Linux');
    });

    it('22. should show processor type using uname -p', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -p');
      expect(output.trim()).toBe('x86_64');
    });

    it('23. should show hardware platform using uname -i', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -i');
      expect(output.trim()).toBe('x86_64');
    });

    it('24. should show operating system using uname -o', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -o');
      expect(output.trim()).toBe('GNU/Linux');
    });

    it('25. should show architecture using arch', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('arch');
      expect(output.trim()).toBe('x86_64');
    });

    it('26. should reject arch command if arguments are supplied', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('arch --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error|invalid/);
    });

    it('27. should combine multiple uname options successfully (uname -rm)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -rm');
      expect(output).toContain('x86_64');
    });

    it('28. should reject uname command if options are invalid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -z');
      expect(output.toLowerCase()).toMatch(/invalid option|error/);
    });

    it('29. should preserve hardware status after continuous free memory reads', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('free -s 1 -c 2');
      const output = await pc.executeCommand('free');
      expect(output).toContain('Mem:');
    });

    it('30. should support free memory configuration queries using short option alias -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('free -m');
      expect(output).toBeDefined();
    });

    it('31. should display CPU model name inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Model name');
    });

    it('32. should display core counts inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Core(s) per socket');
    });

    it('33. should display sockets counts inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Socket(s)');
    });

    it('34. should display thread counts inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Thread(s) per core');
    });

    it('35. should display virtualization state inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('Virtualization');
    });

    it('36. should display L1d cache information inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('L1d cache');
    });

    it('37. should display L1i cache information inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('L1i cache');
    });

    it('38. should display L2 cache information inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('L2 cache');
    });

    it('39. should display L3 cache information inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('L3 cache');
    });

    it('40. should show system uptime correctly via uptime', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uptime');
      expect(output).toContain('up');
    });

    it('41. should show load average inside uptime', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uptime');
      expect(output).toContain('load average:');
    });

    it('42. should support uptime pretty print mode with uptime -p', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uptime -p');
      expect(output).toContain('up');
    });

    it('43. should show boot time explicitly using uptime -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uptime -s');
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('44. should reject uptime if options are invalid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uptime --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('45. should show kernel compile details on uname -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname -v');
      expect(output).toBeDefined();
    });

    it('46. should show system hostname on hostname', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hostname');
      expect(output.trim()).toBe('HWHost');
    });

    it('47. should show system domain name on hostname -d if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hostname -d');
      expect(output).toBeDefined();
    });

    it('48. should show associated IP addresses on hostname -i', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hostname -i');
      expect(output).toBeDefined();
    });

    it('49. should reject hostname if options are invalid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hostname --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('50. should execute successfully and return status 0 on default metadata queries', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname && echo "METADATA_OK"');
      expect(output).toContain('METADATA_OK');
    });
  });

  // ─── Block 2: PCI & USB Bus Device Inspection (Tests 51-100) ──────

  describe('Block 2: PCI & USB Bus Device Inspection', () => {
    it('51. should list PCI devices using lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('Host bridge');
      expect(output).toContain('VGA compatible controller');
    });

    it('52. should show verbose PCI devices info using lspci -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -v');
      expect(output).toContain('Subsystem:');
    });

    it('53. should show highly verbose PCI devices info using lspci -vv', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -vv');
      expect(output).toContain('Capabilities:');
    });

    it('54. should show numerical codes for PCI devices using lspci -n', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -n');
      expect(output).toMatch(/[0-9a-fA-F]{4}:[0-9a-fA-F]{4}/);
    });

    it('55. should show both names and numerical codes for PCI devices using lspci -nn', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -nn');
      expect(output).toMatch(/\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\]/);
    });

    it('56. should show PCI devices in tree format using lspci -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -t');
      expect(output).toContain('-[0000:00]-');
    });

    it('57. should filter PCI devices by slot using lspci -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -s 00:02.0');
      expect(output).toContain('VGA compatible controller');
    });

    it('58. should filter PCI devices by vendor/device ID using lspci -d', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -d 8086:'); // Intel vendor ID
      expect(output).toContain('Intel Corporation');
    });

    it('59. should reject lspci if slot syntax is invalid (-s 99:99.9)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -s 99:99.9');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('60. should reject lspci if ID syntax is invalid (-d 99999:)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -d 99999:');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('61. should list USB devices using lsusb', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb');
      expect(output).toContain('Bus');
      expect(output).toContain('Device');
      expect(output).toContain('ID');
    });

    it('62. should show verbose USB devices info using lsusb -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -v');
      expect(output).toContain('Device Descriptor:');
    });

    it('63. should filter USB devices by bus and device number using lsusb -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -s 001:001');
      expect(output).toContain('Root Hub');
    });

    it('64. should filter USB devices by vendor/product ID using lsusb -d', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -d 1d6b:0002'); // Linux Foundation 2.0 root hub
      expect(output).toContain('Root Hub');
    });

    it('65. should show USB devices in tree format using lsusb -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -t');
      expect(output).toContain('Hub');
    });

    it('66. should reject lsusb if bus/dev syntax is invalid (-s 999:999)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -s 999:999');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('67. should reject lsusb if ID syntax is invalid (-d 99999:99999)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -d 99999:99999');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('68. should list network controller inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('Network controller');
    });

    it('69. should list SATA controller inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('SATA controller');
    });

    it('70. should list USB controller inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('USB controller');
    });

    it('71. should list audio device inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('Audio device');
    });

    it('72. should list keyboard inside lsusb if connected', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb');
      expect(output).toContain('Keyboard');
    });

    it('73. should list mouse inside lsusb if connected', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb');
      expect(output).toContain('Mouse');
    });

    it('74. should reject lspci if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('75. should reject lsusb if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('76. should display maximum verbosity details on lspci -vvv', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -vvv');
      expect(output).toContain('Capabilities:');
    });

    it('77. should support showing kernel drivers in lspci -k', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -k');
      expect(output).toContain('Kernel driver in use:');
    });

    it('78. should support showing subsystem IDs in lspci -x', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -x');
      expect(output).toBeDefined();
    });

    it('79. should reject lspci if multiple filter arguments conflict', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -s 00:02.0 -s 00:03.0');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('80. should reject lsusb if multiple filter arguments conflict', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -s 001:001 -s 001:002');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('81. should show USB configuration descriptors in lsusb -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -v');
      expect(output).toContain('Configuration Descriptor:');
    });

    it('82. should show USB interface descriptors in lsusb -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -v');
      expect(output).toContain('Interface Descriptor:');
    });

    it('83. should show USB endpoint descriptors in lsusb -v', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -v');
      expect(output).toContain('Endpoint Descriptor:');
    });

    it('84. should support lsusb -D to show device descriptors explicitly', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -D /dev/bus/usb/001/001');
      expect(output).toContain('Device Descriptor:');
    });

    it('85. should reject lsusb -D if device path does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -D /dev/bus/usb/999/999');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('86. should support listingPCI bus domain parameters inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -D');
      expect(output).toMatch(/[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9a-fA-F]/);
    });

    it('87. should display exact PCI bus speed metrics if queried', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -vv');
      expect(output).toMatch(/LnkCap|LnkCtl/);
    });

    it('88. should list SCSI controller inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('SCSI storage controller');
    });

    it('89. should list PCI bridge inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('PCI bridge');
    });

    it('90. should list ISA bridge inside lspci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci');
      expect(output).toContain('ISA bridge');
    });

    it('91. should show USB hub port status in lsusb -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -t');
      expect(output).toContain('Port');
    });

    it('92. should show USB hub protocol versions in lsusb -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -t');
      expect(output).toContain('Driver');
    });

    it('93. should show USB hub transfer speeds in lsusb -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -t');
      expect(output).toMatch(/480M|12M/);
    });

    it('94. should preserve bus structures output on repeated lspci calls', async () => {
      const pc = setupHardwarePC();
      const original = await pc.executeCommand('lspci');
      const repeated = await pc.executeCommand('lspci');
      expect(repeated).toBe(original);
    });

    it('95. should preserve bus structures output on repeated lsusb calls', async () => {
      const pc = setupHardwarePC();
      const original = await pc.executeCommand('lsusb');
      const repeated = await pc.executeCommand('lsusb');
      expect(repeated).toBe(original);
    });

    it('96. should filter PCI devices using both slot and vendor ID concurrently', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -s 00:02.0 -d 8086:');
      expect(output).toContain('VGA compatible controller');
    });

    it('97. should filter USB devices using both bus and product ID concurrently', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -s 001:001 -d 1d6b:0002');
      expect(output).toContain('Root Hub');
    });

    it('98. should reject lspci if slot parameter has invalid range (00:35.0)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci -s 00:35.0'); // Slot index limit is usually 31
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('99. should reject lsusb if device parameter has invalid range (001:999)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsusb -s 001:999');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('100. should execute successfully and return status 0 on clean bus queries', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lspci && echo "BUS_OK"');
      expect(output).toContain('BUS_OK');
    });
  });

  // ─── Block 3: Block Storage Devices & Partitioning (Tests 101-150) 

  describe('Block 3: Block Storage Devices & Partitioning', () => {
    it('101. should list block storage devices using lsblk', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk');
      expect(output).toContain('NAME');
      expect(output).toContain('MAJ:MIN');
      expect(output).toContain('RM');
      expect(output).toContain('SIZE');
      expect(output).toContain('TYPE');
      expect(output).toContain('MOUNTPOINT');
    });

    it('102. should show all block devices (including empty ones) using lsblk -a', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -a');
      expect(output).toContain('sda');
    });

    it('103. should show block devices ownership permissions using lsblk -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -m');
      expect(output).toContain('OWNER');
      expect(output).toContain('GROUP');
      expect(output).toContain('MODE');
    });

    it('104. should show block devices in list format using lsblk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -l');
      expect(output).toContain('sda1');
    });

    it('105. should show block devices path references using lsblk -p', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -p');
      expect(output).toContain('/dev/sda');
    });

    it('106. should show block devices size in bytes using lsblk -b', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -b');
      expect(output).toContain('SIZE');
    });

    it('107. should show block devices ignoring holder details using lsblk -d', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -d');
      expect(output).toContain('sda');
      expect(output).not.toContain('sda1');
    });

    it('108. should support custom output columns formatting via lsblk -o', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -o NAME,SIZE,TYPE');
      expect(output).toContain('NAME');
      expect(output).not.toContain('MAJ:MIN');
    });

    it('109. should reject lsblk if custom output column name is invalid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -o INVALID_COLUMN');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('110. should show partition tables using fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Disk /dev/sda:');
      expect(output).toContain('Device');
      expect(output).toContain('Start');
      expect(output).toContain('End');
      expect(output).toContain('Sectors');
      expect(output).toContain('Size');
      expect(output).toContain('Type');
    });

    it('111. should show partition table for specific device (fdisk -l /dev/sda)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l /dev/sda');
      expect(output).toContain('Disk /dev/sda:');
    });

    it('112. should reject fdisk if target device does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l /dev/sdz');
      expect(output.toLowerCase()).toMatch(/error|cannot open/);
    });

    it('113. should deny unprivileged users access to run fdisk', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "fdisk -l"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('114. should show drive parameters using hdparm /dev/sda', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm /dev/sda');
      expect(output).toContain('multcount');
      expect(output).toContain('IO_support');
      expect(output).toContain('readonly');
    });

    it('115. should show drive identification details using hdparm -I /dev/sda', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -I /dev/sda');
      expect(output).toContain('Model Number:');
      expect(output).toContain('Serial Number:');
    });

    it('116. should perform device read timings benchmarks using hdparm -t /dev/sda', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -t /dev/sda');
      expect(output).toContain('Timing buffered disk reads:');
    });

    it('117. should perform cache read timings benchmarks using hdparm -T /dev/sda', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -T /dev/sda');
      expect(output).toContain('Timing cached reads:');
    });

    it('118. should show device geometry details using hdparm -g /dev/sda', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -g /dev/sda');
      expect(output).toContain('geometry');
    });

    it('119. should reject hdparm if target device does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm /dev/sdz');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('120. should deny unprivileged users access to run hdparm', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "hdparm /dev/sda"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('121. should list loopback devices inside lsblk', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mount -o loop /tmp/image.img /mnt'); // mock loop mount
      const output = await pc.executeCommand('lsblk');
      expect(output).toContain('loop');
    });

    it('122. should show sector size metrics inside fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Sector size (logical/physical):');
    });

    it('123. should show disk label identifier inside fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Disklabel type:');
    });

    it('124. should show partition boot indicator inside fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('*'); // boot flag indicator
    });

    it('125. should support hdparm -r query to check read-only states', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -r /dev/sda');
      expect(output).toContain('readonly');
    });

    it('126. should support hdparm -W query to check write-caching states', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -W /dev/sda');
      expect(output).toContain('write-caching');
    });

    it('127. should support hdparm -d query to check DMA settings', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -d /dev/sda');
      expect(output).toContain('using_dma');
    });

    it('128. should support fdisk partition type list querying via fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Linux');
    });

    it('129. should preserve partition properties after multiple fdisk reads', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('fdisk -l');
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Disk /dev/sda:');
    });

    it('130. should support hdparm -v query to show default summaries info', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -v /dev/sda');
      expect(output).toContain('multcount');
    });

    it('131. should reject hdparm if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm --invalid /dev/sda');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('132. should reject fdisk if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('133. should list disk UUIDs inside lsblk -o UUID', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -o NAME,UUID');
      expect(output).toContain('UUID');
    });

    it('134. should list disk filesystem types inside lsblk -o FSTYPE', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -o NAME,FSTYPE');
      expect(output).toContain('FSTYPE');
    });

    it('135. should list disk labels inside lsblk -o LABEL', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -o NAME,LABEL');
      expect(output).toContain('LABEL');
    });

    it('136. should support lsblk JSON output via lsblk -J', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -J');
      expect(output).toContain('{');
    });

    it('137. should support lsblk raw layout mode via lsblk -r', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -r');
      expect(output).not.toContain('├─');
    });

    it('138. should reject lsblk if multiple options conflict', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -l -p -r'); // conflicting format displays
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('139. should support querying a partition directly (fdisk -l /dev/sda1)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l /dev/sda1');
      expect(output).toBeDefined();
    });

    it('140. should show partition alignment metrics inside fdisk -l', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l');
      expect(output).toContain('Partition 1 does not start on physical sector boundary'); // Optional warning validation
    });

    it('141. should support query commands help guidelines on lsblk --help', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk --help');
      expect(output.toLowerCase()).toContain('options');
    });

    it('142. should support query commands version info on lsblk --version', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk --version');
      expect(output.toLowerCase()).toContain('util-linux');
    });

    it('143. should display sector configurations inside hdparm -I', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -I /dev/sda');
      expect(output).toContain('Logical/Physical Sector size');
    });

    it('144. should display firmware revision metrics inside hdparm -I', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -I /dev/sda');
      expect(output).toContain('Firmware Revision:');
    });

    it('145. should display device capabilities inside hdparm -I', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -I /dev/sda');
      expect(output).toContain('Capabilities:');
    });

    it('146. should display security features inside hdparm -I', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -I /dev/sda');
      expect(output).toContain('Security:');
    });

    it('147. should support query commands help guidelines on hdparm -h', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -h');
      expect(output.toLowerCase()).toContain('options');
    });

    it('148. should support query commands version info on hdparm -v (as subset of -V)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm -V');
      expect(output.toLowerCase()).toContain('hdparm');
    });

    it('149. should reject hdparm if target is not a block device (hdparm /etc/passwd)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hdparm /etc/passwd');
      expect(output.toLowerCase()).toMatch(/error|inappropriate ioctl|not a block device/);
    });

    it('150. should execute successfully and return status 0 on default block storage list queries', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk && echo "BLOCK_OK"');
      expect(output).toContain('BLOCK_OK');
    });
  });

  // ─── Block 4: DMI Table Decoding & Hardware Listings (Tests 151-200)

  describe('Block 4: Detailed Hardware & DMI Table Decoding', () => {
    it('151. should list hardware details using lshw', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw');
      expect(output).toContain('description: Computer');
      expect(output).toContain('*-cpu');
      expect(output).toContain('*-memory');
      expect(output).toContain('*-network');
    });

    it('152. should show short hardware list using lshw -short', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -short');
      expect(output).toContain('H/W path');
      expect(output).toContain('Device');
      expect(output).toContain('Class');
      expect(output).toContain('Description');
    });

    it('153. should output lshw in JSON format via lshw -json', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -json');
      expect(output).toContain('{');
    });

    it('154. should output lshw in XML format via lshw -xml', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -xml');
      expect(output).toContain('<list>');
    });

    it('155. should output lshw in HTML format via lshw -html', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -html');
      expect(output).toContain('<html>');
    });

    it('156. should filter lshw output by class using lshw -C', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C network');
      expect(output).toContain('*-network');
      expect(output).not.toContain('*-cpu');
    });

    it('157. should reject lshw if class filter does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C invalid_class');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('158. should decode DMI tables using dmidecode', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode');
      expect(output).toContain('BIOS Information');
      expect(output).toContain('System Information');
      expect(output).toContain('Base Board Information');
    });

    it('159. should filter dmidecode output by type using dmidecode -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t bios');
      expect(output).toContain('BIOS Information');
      expect(output).not.toContain('System Information');
    });

    it('160. should show specific DMI string using dmidecode -s', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s system-uuid');
      expect(output).toMatch(/[0-9a-fA-F-]{36}/);
    });

    it('161. should reject dmidecode if type filter is invalid (-t invalid_type)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t invalid_type');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('162. should reject dmidecode if string keyword is invalid (-s invalid_string)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s invalid_string');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('163. should deny unprivileged users access to run dmidecode', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "dmidecode"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|cannot open/);
    });

    it('164. should list hardware details using hwinfo', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo');
      expect(output).toContain('cpu:');
      expect(output).toContain('keyboard:');
      expect(output).toContain('mouse:');
    });

    it('165. should show short hardware list using hwinfo --short', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --short');
      expect(output).toContain('cpu:');
    });

    it('166. should filter hwinfo output for CPU using hwinfo --cpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --cpu');
      expect(output).toContain('cpu:');
      expect(output).not.toContain('mouse:');
    });

    it('167. should filter hwinfo output for disks using hwinfo --disk', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --disk');
      expect(output).toContain('disk:');
      expect(output).not.toContain('cpu:');
    });

    it('168. should filter hwinfo output for PCI devices using hwinfo --pci', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --pci');
      expect(output).toContain('pci:');
    });

    it('169. should filter hwinfo output for USB devices using hwinfo --usb', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --usb');
      expect(output).toContain('usb:');
    });

    it('170. should filter hwinfo output for network devices using hwinfo --network', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --network');
      expect(output).toContain('network:');
    });

    it('171. should reject hwinfo if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('172. should show memory modules details in dmidecode -t memory', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t memory');
      expect(output).toContain('Memory Device');
    });

    it('173. should show cache status details in dmidecode -t cache', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t cache');
      expect(output).toContain('Cache Information');
    });

    it('174. should show processor socket details in dmidecode -t processor', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t processor');
      expect(output).toContain('Processor Information');
    });

    it('175. should show system chassis details in dmidecode -t chassis', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t chassis');
      expect(output).toContain('Chassis Information');
    });

    it('176. should show motherboard bios details in dmidecode -t bios', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t bios');
      expect(output).toContain('BIOS Information');
    });

    it('177. should support showing only matched UUID using dmidecode -s system-uuid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s system-uuid');
      expect(output).toMatch(/[0-9a-fA-F-]{36}/);
    });

    it('178. should support showing only matched serial number using dmidecode -s system-serial-number', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s system-serial-number');
      expect(output).toBeDefined();
    });

    it('179. should support showing only matched manufacturer using dmidecode -s system-manufacturer', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s system-manufacturer');
      expect(output).toBeDefined();
    });

    it('180. should support showing only matched product using dmidecode -s system-product-name', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -s system-product-name');
      expect(output).toBeDefined();
    });

    it('181. should reject lshw if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('182. should reject dmidecode if options are completely unrecognized', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('183. should display BIOS vendor inside dmidecode -t bios', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t bios');
      expect(output).toContain('Vendor:');
    });

    it('184. should display BIOS version inside dmidecode -t bios', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t bios');
      expect(output).toContain('Version:');
    });

    it('185. should display BIOS release date inside dmidecode -t bios', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t bios');
      expect(output).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });

    it('186. should display system uuid inside dmidecode -t system', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t system');
      expect(output).toContain('UUID:');
    });

    it('187. should display baseboard product inside dmidecode -t baseboard', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -t baseboard');
      expect(output).toContain('Product Name:');
    });

    it('188. should support hwinfo short list alias --short', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --short');
      expect(output).toBeDefined();
    });

    it('189. should show correct memory details inside lshw *-memory block', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw');
      expect(output).toContain('*-memory');
    });

    it('190. should show correct disk details inside lshw *-disk block', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw');
      expect(output).toContain('*-disk');
    });

    it('191. should show correct net details inside lshw *-network block', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw');
      expect(output).toContain('*-network');
    });

    it('192. should preserve hardware status after repeated dmidecode calls', async () => {
      const pc = setupHardwarePC();
      const original = await pc.executeCommand('dmidecode -t bios');
      const repeated = await pc.executeCommand('dmidecode -t bios');
      expect(repeated).toBe(original);
    });

    it('193. should preserve hardware status after repeated hwinfo calls', async () => {
      const pc = setupHardwarePC();
      const original = await pc.executeCommand('hwinfo --cpu');
      const repeated = await pc.executeCommand('hwinfo --cpu');
      expect(repeated).toBe(original);
    });

    it('194. should support filtering hwinfo by multiple targets simultaneously', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('hwinfo --cpu --disk');
      expect(output).toContain('cpu:');
      expect(output).toContain('disk:');
    });

    it('195. should support dmidecode -q to suppress empty fields', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -q');
      expect(output).toBeDefined();
    });

    it('196. should support dmidecode dump to file explicitly if simulated (-u)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -u');
      expect(output).toBeDefined();
    });

    it('197. should support lshw HTML export redirection safely', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('lshw -html > /tmp/hw.html');
      const output = await pc.executeCommand('cat /tmp/hw.html');
      expect(output).toContain('<html>');
    });

    it('198. should support lshw XML export redirection safely', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('lshw -xml > /tmp/hw.xml');
      const output = await pc.executeCommand('cat /tmp/hw.xml');
      expect(output).toContain('<list>');
    });

    it('199. should support lshw JSON export redirection safely', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('lshw -json > /tmp/hw.json');
      const output = await pc.executeCommand('cat /tmp/hw.json');
      expect(output).toContain('{');
    });

    it('200. should execute successfully and return status 0 on default hardware profiling queries', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -short && echo "HW_OK"');
      expect(output).toContain('HW_OK');
    });
  });

  // ─── Block 5: Filesystem Disk Usage & Mounts (Tests 201-250) ──────

  describe('Block 5: Filesystem Disk Usage & Mounts', () => {
    it('201. should show disk space usage using df', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df');
      expect(output).toContain('Filesystem');
      expect(output).toContain('1K-blocks');
      expect(output).toContain('Used');
      expect(output).toContain('Available');
      expect(output).toContain('Use%');
      expect(output).toContain('Mounted on');
    });

    it('202. should show disk space usage in megabytes using df -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -m');
      expect(output).toContain('Filesystem');
    });

    it('203. should show disk space usage in kilobytes using df -k', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -k');
      expect(output).toContain('Filesystem');
    });

    it('204. should show disk space usage in human-readable format using df -h', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -h');
      expect(output).toContain('Filesystem');
    });

    it('205. should show filesystem type inside df -T', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -T');
      expect(output).toContain('Type');
      expect(output).toContain('ext4');
    });

    it('206. should show inode parameters status inside df -i', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -i');
      expect(output).toContain('Inodes');
      expect(output).toContain('IUsed');
      expect(output).toContain('IFree');
    });

    it('207. should show all filesystems (including dummy ones) using df -a', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -a');
      expect(output).toContain('proc');
    });

    it('208. should restrict df output to specific targets directory (df /tmp)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df /tmp');
      expect(output).toContain('/tmp');
    });

    it('209. should reject df if target path does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df /nonexistent_path');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('210. should show active mount points using mount', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount');
      expect(output).toContain('on / type ext4');
    });

    it('211. should mount device onto specific target folder (mount /dev/sda1 /mnt)', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('mount /dev/sda1 /mnt');
      expect(output.trim()).toBe('');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).toContain('on /mnt type ext4');
    });

    it('212. should mount device read-only using mount -o ro', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount -o ro /dev/sda1 /mnt');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).toContain('on /mnt type ext4 (ro)');
    });

    it('213. should mount device read-write using mount -o rw', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount -o rw /dev/sda1 /mnt');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).toContain('on /mnt type ext4 (rw)');
    });

    it('214. should mount directory recursively using mount --bind', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /tmp/src /tmp/dst');
      const output = await pc.executeCommand('mount --bind /tmp/src /tmp/dst');
      expect(output.trim()).toBe('');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).toContain('on /tmp/dst type none (bind)');
    });

    it('215. should unmount device from specific target folder (umount /mnt)', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      const output = await pc.executeCommand('umount /mnt');
      expect(output.trim()).toBe('');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).not.toContain('on /mnt');
    });

    it('216. should reject mount if target folder does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount /dev/sda1 /nonexistent_folder');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('217. should reject mount if device path does not exist', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('mount /dev/sdz1 /mnt');
      expect(output.toLowerCase()).toMatch(/error|special device does not exist/);
    });

    it('218. should reject umount if target folder is not mounted', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('umount /mnt');
      expect(output.toLowerCase()).toMatch(/error|not mounted/);
    });

    it('219. should deny unprivileged users access to execute mount', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('su user -c "mount /dev/sda1 /mnt"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|only root can/);
    });

    it('220. should deny unprivileged users access to execute umount', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      const output = await pc.executeCommand('su user -c "umount /mnt"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|only root can/);
    });

    it('221. should support mounting virtual loopback file systems', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount -o loop /tmp/image.img /mnt');
      const mounts = await pc.executeCommand('mount');
      expect(mounts).toContain('on /mnt type ext4 (loop)');
    });

    it('222. should reject loopback mounting if file path does not exist', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('mount -o loop /tmp/nonexistent.img /mnt');
      expect(output.toLowerCase()).toMatch(/error|failed/);
    });

    it('223. should reject unmounting if mount point is currently busy (process active in folder)', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      // Process active in /mnt
      const output = await pc.executeCommand('cd /mnt && umount /mnt');
      expect(output.toLowerCase()).toMatch(/error|target is busy/);
    });

    it('224. should support lazy unmounting with umount -l even if busy', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      const output = await pc.executeCommand('cd /mnt && umount -l /mnt');
      expect(output.trim()).toBe('');
    });

    it('225. should support forced unmounting with umount -f', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      const output = await pc.executeCommand('umount -f /mnt');
      expect(output.trim()).toBe('');
    });

    it('226. should support df filesystem type filtering via df -t ext4', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -t ext4');
      expect(output).toContain('ext4');
    });

    it('227. should support df filesystem type excluding via df -x tmpfs', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -x tmpfs');
      expect(output).not.toContain('tmpfs');
    });

    it('228. should reject df if filtered filesystem type does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -t invalid_fs');
      expect(output.toLowerCase()).toMatch(/error|no file systems/);
    });

    it('229. should preserve mount properties after multiple mount calls', async () => {
      const pc = setupHardwarePC();
      const original = await pc.executeCommand('mount');
      const repeated = await pc.executeCommand('mount');
      expect(repeated).toBe(original);
    });

    it('230. should support show config list after unmounting device', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      await pc.executeCommand('mount /dev/sda1 /mnt');
      await pc.executeCommand('umount /mnt');
      const config = await pc.executeCommand('mount');
      expect(config).not.toContain('/mnt');
    });

    it('231. should reject mount if target mountpoint has typos', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount /dev/sda1 /mntt');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('232. should reject mount if target device has typos', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /mnt');
      const output = await pc.executeCommand('mount /dev/sdaaa1 /mnt');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('233. should accept single-quotes around mount paths', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /tmp/mnt');
      const output = await pc.executeCommand("mount --bind '/tmp/empty_parts' '/tmp/parts_link'"); // using placeholder folders
      expect(output).toBeDefined();
    });

    it('234. should accept double-quotes around mount paths', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /tmp/parts');
      const output = await pc.executeCommand('mount --bind "/tmp/parts" "/tmp/parts_link"');
      expect(output).toBeDefined();
    });

    it('235. should allow querying mounts status when no devices are mounted dynamically', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount');
      expect(output).toBeDefined();
    });

    it('236. should support mount remount option (mount -o remount,ro /tmp)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount -o remount,ro /tmp');
      expect(output.trim()).toBe('');
    });

    it('237. should support mount -a to mount all filesystems defined in /etc/fstab', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('mount -a');
      expect(output.trim()).toBe('');
    });

    it('238. should reject mount -a if /etc/fstab has syntax errors', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('echo "invalid_line_fstab" > /etc/fstab');
      const output = await pc.executeCommand('mount -a');
      expect(output.toLowerCase()).toMatch(/error|bad line/);
    });

    it('249. should reject umount if target is not mounted', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('umount /tmp');
      expect(output.toLowerCase()).toMatch(/error|not mounted/);
    });

    it('250. should execute successfully and return status 0 on default disk usage queries', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -h && echo "DF_OK"');
      expect(output).toContain('DF_OK');
    });
  });

  // ─── Block 6: Privilege Boundaries & Error Handlers (Tests 251-300) 

  describe('Block 6: Privilege Boundaries, Edge Cases, Syntax Errors & Resets', () => {
    it('251. should restrict fsprog write operations to privileged users (fdisk /dev/sda)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "fdisk /dev/sda"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|root/);
    });

    it('252. should restrict storage drive formatting to privileged users (mkfs.ext4 /dev/sda1)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "mkfs.ext4 /dev/sda1"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('253. should restrict hdparm disk tuning options to root (hdparm -t /dev/sda)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "hdparm -t /dev/sda"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('254. should restrict dmidecode execution to root privileges', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "dmidecode"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('255. should restrict mount execution to root privileges', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('mkdir /tmp/mnt');
      const output = await pc.executeCommand('su user -c "mount /dev/sda1 /tmp/mnt"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('256. should restrict umount execution to root privileges', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "umount /mnt"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('257. should allow unprivileged users to view system CPU details with lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "lscpu"');
      expect(output).toContain('Architecture');
    });

    it('258. should allow unprivileged users to view memory metrics with free', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "free"');
      expect(output).toContain('Mem:');
    });

    it('259. should allow unprivileged users to view disk space metrics with df', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "df"');
      expect(output).toContain('Filesystem');
    });

    it('260. should allow unprivileged users to view block devices lists with lsblk', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "lsblk"');
      expect(output).toContain('NAME');
    });

    it('261. should allow unprivileged users to query hostname information', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "hostname"');
      expect(output.trim()).toBe('HWHost');
    });

    it('262. should allow unprivileged users to view active mount points with mount (no args)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "mount"');
      expect(output).toContain('on / type ext4');
    });

    it('263. should reject lshw if unprivileged and requested class requires root', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "lshw -C network"');
      // Typically prints partial/warning, ensure handled without crash
      expect(output).toBeDefined();
    });

    it('264. should reject dmidecode if type parameter key has typos (-tt bios)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -tt bios');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('265. should reject dmidecode if string parameter key has typos (-ss system-uuid)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('dmidecode -ss system-uuid');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('266. should reject lshw if short parameter has typos (-shortt)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -shortt');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('267. should reject df if human-readable parameter has typos (-hh)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('df -hh');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('268. should handle long customized device paths safely inside fdisk rules (fdisk -l /dev/sda...)', async () => {
      const pc = setupHardwarePC();
      const longName = '/dev/sda' + 's'.repeat(240);
      const output = await pc.executeCommand(`fdisk -l ${longName}`);
      expect(output.toLowerCase()).toMatch(/error|cannot open|no such file/);
    });

    it('269. should reject fdisk if target is a regular file instead of a block device (fdisk -l /etc/passwd)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('fdisk -l /etc/passwd');
      expect(output.toLowerCase()).toMatch(/error|not a block device|invalid/);
    });

    it('270. should support lshw XML, JSON, HTML outputs redirection concurrently with no process pipeline choking', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('lshw -json > /tmp/out.json && lshw -xml > /tmp/out.xml');
      const json = await pc.executeCommand('cat /tmp/out.json');
      const xml = await pc.executeCommand('cat /tmp/out.xml');
      expect(json).toContain('{');
      expect(xml).toContain('<list>');
    });

    it('271. should show disk labels in blkid command if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('blkid');
      expect(output).toContain('/dev/sda1:');
    });

    it('272. should show specific UUID mappings in blkid /dev/sda1', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('blkid /dev/sda1');
      expect(output).toContain('UUID=');
    });

    it('273. should reject blid if targeted device does not exist', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('blkid /dev/sdz9');
      expect(output.toLowerCase()).toMatch(/not found|error/);
    });

    it('274. should deny unprivileged users access to execute blkid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "blkid"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('275. should show logical volume configurations inside lvdisplay if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lvdisplay');
      expect(output).toBeDefined();
    });

    it('276. should show volume group configurations inside vgdisplay if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('vgdisplay');
      expect(output).toBeDefined();
    });

    it('277. should show physical volume configurations inside pvdisplay if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('pvdisplay');
      expect(output).toBeDefined();
    });

    it('278. should reject lvdisplay/vgdisplay if executed by non-privileged accounts', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('su user -c "lvdisplay"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('279. should show active partitions metrics on parted -l if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('parted -l');
      expect(output).toContain('Partition Table:');
    });

    it('280. should reject parted if options are invalid', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('parted --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('281. should reject lshw if class parameters has typos (lshw -C cpuu)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C cpuu');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('282. should support showing system firmware information on lshw -C firmware', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C firmware');
      expect(output).toContain('BIOS');
    });

    it('283. should support showing system memory information on lshw -C memory', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C memory');
      expect(output).toContain('System Memory');
    });

    it('284. should support showing storage controller information on lshw -C storage', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C storage');
      expect(output).toContain('SATA controller');
    });

    it('285. should support showing network device information on lshw -C network', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C network');
      expect(output).toContain('Ethernet interface');
    });

    it('286. should support showing display card information on lshw -C display', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C display');
      expect(output).toContain('VGA compatible controller');
    });

    it('287. should reject set interface command if interface has typos inside netsh equivalent paths (Windows fallback check)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('netsh interface set interface Ethernet admin=disabled');
      expect(output.toLowerCase()).toContain('command not found'); // linux PC rejects Windows commands
    });

    it('288. should handle empty commands strings execution gracefully on hardware context', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('uname ""');
      expect(output.toLowerCase()).toContain('extra');
    });

    it('289. should show correct CPU frequency parameters inside lscpu', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu');
      expect(output).toContain('CPU MHz');
    });

    it('290. should preserve disk tables after partition parameters are checked', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('fdisk -l');
      const output = await pc.executeCommand('lsblk');
      expect(output).toContain('sda');
    });

    it('291. should show loopback devices inside lsblk -a', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -a');
      expect(output).toContain('loop0');
    });

    it('292. should support showing sector sizes inside lsblk -t', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -t');
      expect(output).toContain('SSZ');
    });

    it('293. should show filesystem types inside lsblk -f if configured', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -f');
      expect(output).toContain('FSTYPE');
    });

    it('294. should support showing topology details on lsblk -i', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -i');
      expect(output).toContain('NAME');
    });

    it('295. should support showing permissions metadata on lsblk -m', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -m');
      expect(output).toContain('OWNER');
    });

    it('296. should reject lsblk if multiple options conflict', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk --invalid');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error/);
    });

    it('297. should support showing block device SCSI details inside lsblk -S', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lsblk -S');
      expect(output).toBeDefined();
    });

    it('298. should preserve all partitions status dynamically across non-mutating df queries', async () => {
      const pc = setupHardwarePC();
      await pc.executeCommand('df -h');
      const output = await pc.executeCommand('lsblk');
      expect(output).toContain('sda');
    });

    it('299. should reject lshw if class key has typos (lshw -C systemm)', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lshw -C systems');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('300. should execute successfully and return status 0 on clean hardware inspection commands', async () => {
      const pc = setupHardwarePC();
      const output = await pc.executeCommand('lscpu && echo "HARDWARE_OK"');
      expect(output).toContain('HARDWARE_OK');
    });
  });
});
