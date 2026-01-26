/**
 * Cisco Terminal Tests
 *
 * TDD tests for realistic Cisco IOS terminal behavior:
 * - Boot sequence
 * - Banners (MOTD, Login, Exec)
 * - Configuration modes
 * - Common IOS commands
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/domain/devices/CiscoRouter';
import { CiscoSwitch } from '@/domain/devices/CiscoSwitch';

describe('Cisco Router Terminal', () => {
  let router: CiscoRouter;

  beforeEach(() => {
    router = new CiscoRouter({ id: 'r1', name: 'Router1', hostname: 'R1' });
  });

  describe('Boot Sequence', () => {
    it('should provide boot sequence output', () => {
      const bootOutput = router.getBootSequence();

      expect(bootOutput).toContain('Cisco IOS');
      expect(bootOutput).toContain('System Bootstrap');
      expect(bootOutput).toContain('BOOTLDR');
    });

    it('should include hardware info in boot sequence', () => {
      const bootOutput = router.getBootSequence();

      expect(bootOutput).toContain('Cisco');
      expect(bootOutput).toContain('processor');
      expect(bootOutput).toContain('memory');
    });
  });

  describe('Banner MOTD', () => {
    it('should display MOTD banner when configured', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('banner motd # Authorized Access Only! #');

      const banner = router.getBanner('motd');
      expect(banner).toContain('Authorized Access Only!');
    });

    it('should display login banner', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('banner login # Please login #');

      const banner = router.getBanner('login');
      expect(banner).toContain('Please login');
    });
  });

  describe('Prompts by Mode', () => {
    it('should show user mode prompt (hostname>)', () => {
      expect(router.getPrompt()).toBe('R1>');
    });

    it('should show privileged mode prompt (hostname#)', async () => {
      await router.executeCommand('enable');
      expect(router.getPrompt()).toBe('R1#');
    });

    it('should show config mode prompt (hostname(config)#)', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      expect(router.getPrompt()).toBe('R1(config)#');
    });

    it('should show interface config prompt', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/0');
      expect(router.getPrompt()).toBe('R1(config-if)#');
    });

    it('should show line config prompt', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('line console 0');
      expect(router.getPrompt()).toBe('R1(config-line)#');
    });

    it('should show router config prompt', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('router rip');
      expect(router.getPrompt()).toBe('R1(config-router)#');
    });
  });

  describe('Enable Password', () => {
    it('should require password when enable secret is set', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('enable secret class');
      await router.executeCommand('end');
      await router.executeCommand('disable');

      const result = await router.executeCommand('enable');
      expect(result).toContain('Password:');
    });

    it('should accept correct enable password', async () => {
      router.setEnableSecret('class');

      const result = await router.executeCommand('enable');
      expect(result).toContain('Password:');

      await router.executeCommand('class');
      expect(router.getPrompt()).toBe('R1#');
    });

    it('should reject incorrect enable password', async () => {
      router.setEnableSecret('class');

      await router.executeCommand('enable');
      const result = await router.executeCommand('wrongpassword');

      expect(result).toContain('Access denied');
    });
  });

  describe('Ping Command', () => {
    it('should execute ping command in privileged mode', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('ping 192.168.1.1');

      expect(result).toContain('Sending');
      expect(result).toContain('ICMP');
    });

    it('should show ping success/failure indicators', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('ping 8.8.8.8');

      // Should contain . for timeout or ! for success
      expect(result).toMatch(/[\.!]+/);
    });

    it('should not allow ping in user mode', async () => {
      const result = await router.executeCommand('ping 192.168.1.1');
      expect(result).toContain('Invalid input');
    });
  });

  describe('Interface Configuration', () => {
    it('should configure interface IP address', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/0');
      const result = await router.executeCommand('ip address 192.168.1.1 255.255.255.0');

      expect(result).toBe('');

      // Verify IP was set
      await router.executeCommand('end');
      const showResult = await router.executeCommand('show ip interface brief');
      expect(showResult).toContain('192.168.1.1');
    });

    it('should enable interface with no shutdown', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/0');
      await router.executeCommand('no shutdown');

      await router.executeCommand('end');
      const result = await router.executeCommand('show ip interface brief');
      expect(result).toContain('up');
    });

    it('should disable interface with shutdown', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/0');
      await router.executeCommand('shutdown');

      await router.executeCommand('end');
      const result = await router.executeCommand('show ip interface brief');
      expect(result).toContain('down');
    });
  });

  describe('Write/Copy Commands', () => {
    it('should save config with write memory', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('write memory');

      expect(result).toContain('Building configuration');
      expect(result).toContain('OK');
    });

    it('should save config with copy run start', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('copy running-config startup-config');

      expect(result).toContain('Building configuration');
    });
  });

  describe('Clock Commands', () => {
    it('should show current time', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('show clock');

      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/); // Time format HH:MM:SS
    });

    it('should set clock', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('clock set 12:30:00 Jan 26 2026');

      expect(result).toBe('');
    });
  });

  describe('Reload Command', () => {
    it('should confirm before reload', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('reload');

      expect(result).toContain('Proceed with reload');
    });
  });

  describe('Traceroute Command', () => {
    it('should execute traceroute in privileged mode', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('traceroute 8.8.8.8');

      expect(result).toContain('Tracing');
    });
  });

  describe('No and Do Commands', () => {
    it('should negate commands with no prefix', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('hostname TestRouter');
      expect(router.getHostname()).toBe('TestRouter');

      await router.executeCommand('no hostname');
      expect(router.getHostname()).toBe('Router');
    });

    it('should execute EXEC commands in config mode with do', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      const result = await router.executeCommand('do show version');

      expect(result).toContain('Cisco IOS');
    });
  });

  describe('Help System', () => {
    it('should show context-sensitive help with ?', async () => {
      const result = await router.executeCommand('?');
      expect(result).toContain('enable');
    });

    it('should show command-specific help', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('show ?');

      expect(result).toContain('version');
      expect(result).toContain('ip');
      expect(result).toContain('running-config');
    });
  });

  describe('Show Commands', () => {
    it('should show protocols', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('show protocols');

      expect(result).toContain('Global values');
    });

    it('should show flash', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('show flash');

      expect(result).toContain('bytes');
    });

    it('should show history', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('show version');
      const result = await router.executeCommand('show history');

      expect(result).toContain('show version');
    });
  });

  describe('Hostname Configuration', () => {
    it('should update prompt when hostname changes', async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('hostname CoreRouter');

      expect(router.getPrompt()).toBe('CoreRouter(config)#');
    });
  });
});

describe('Cisco Switch Terminal', () => {
  let sw: CiscoSwitch;

  beforeEach(() => {
    sw = new CiscoSwitch({ id: 's1', name: 'Switch1', hostname: 'SW1' });
  });

  describe('Switch-Specific Commands', () => {
    it('should show mac address-table', async () => {
      await sw.executeCommand('enable');
      const result = await sw.executeCommand('show mac address-table');

      expect(result).toContain('Mac Address Table');
      expect(result).toContain('Vlan');
    });

    it('should show vlan brief', async () => {
      await sw.executeCommand('enable');
      const result = await sw.executeCommand('show vlan brief');

      expect(result).toContain('VLAN');
      expect(result).toContain('default');
    });

    it('should configure switchport mode', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      const result = await sw.executeCommand('switchport mode access');

      expect(result).toBe('');
    });

    it('should configure switchport access vlan', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode access');
      const result = await sw.executeCommand('switchport access vlan 10');

      expect(result).toBe('');
    });

    it('should configure trunk port', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface GigabitEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      const result = await sw.executeCommand('switchport trunk allowed vlan 10,20,30');

      expect(result).toBe('');
    });
  });

  describe('VLAN Configuration', () => {
    it('should create new VLAN', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('name SALES');
      await sw.executeCommand('end');

      const result = await sw.executeCommand('show vlan brief');
      expect(result).toContain('SALES');
    });

    it('should delete VLAN', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('vlan 20');
      await sw.executeCommand('name TEST');
      await sw.executeCommand('exit');
      await sw.executeCommand('no vlan 20');
      await sw.executeCommand('end');

      const result = await sw.executeCommand('show vlan brief');
      expect(result).not.toContain('TEST');
    });
  });

  describe('Spanning Tree', () => {
    it('should show spanning-tree', async () => {
      await sw.executeCommand('enable');
      const result = await sw.executeCommand('show spanning-tree');

      expect(result).toContain('VLAN');
    });

    it('should configure spanning-tree mode', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      const result = await sw.executeCommand('spanning-tree mode rapid-pvst');

      expect(result).toBe('');
    });
  });

  describe('Port Security', () => {
    it('should configure port-security', async () => {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode access');
      await sw.executeCommand('switchport port-security');
      const result = await sw.executeCommand('switchport port-security maximum 2');

      expect(result).toBe('');
    });
  });
});
