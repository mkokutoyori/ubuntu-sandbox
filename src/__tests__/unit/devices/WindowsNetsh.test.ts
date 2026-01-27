/**
 * TDD Tests for Windows netsh command
 *
 * Comprehensive tests for netsh utility including:
 * - netsh interface (show, set, config)
 * - netsh interface ip (address, dns, gateway)
 * - netsh wlan (profiles, networks)
 * - netsh advfirewall (rules, state)
 * - netsh diagnostics
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('Windows netsh Command', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    pc = new WindowsPC({ id: 'pc1', name: 'WIN-PC01', hostname: 'WIN-PC01' });
    pc.powerOn();
  });

  describe('netsh help', () => {
    it('should show help with netsh /?', async () => {
      const result = await pc.executeCommand('netsh /?');
      expect(result).toContain('netsh');
      expect(result.toLowerCase()).toContain('interface');
    });

    it('should show help with netsh help', async () => {
      const result = await pc.executeCommand('netsh help');
      expect(result.toLowerCase()).toContain('interface');
    });

    it('should show help with netsh -?', async () => {
      const result = await pc.executeCommand('netsh -?');
      expect(result).toContain('netsh');
    });
  });

  describe('netsh interface', () => {
    describe('netsh interface show interface', () => {
      it('should list all interfaces', async () => {
        const result = await pc.executeCommand('netsh interface show interface');
        expect(result).toContain('Admin State');
        expect(result).toContain('State');
        expect(result).toContain('Type');
        expect(result).toContain('Interface Name');
        expect(result).toContain('Ethernet0');
      });

      it('should show interface status (Enabled/Disabled)', async () => {
        const result = await pc.executeCommand('netsh interface show interface');
        expect(result).toMatch(/Enabled|Disabled/);
      });

      it('should show connection status (Connected/Disconnected)', async () => {
        const result = await pc.executeCommand('netsh interface show interface');
        expect(result).toMatch(/Connected|Disconnected/);
      });
    });

    describe('netsh interface set interface', () => {
      it('should enable an interface', async () => {
        const result = await pc.executeCommand('netsh interface set interface "Ethernet0" enable');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.isUp()).toBe(true);
      });

      it('should disable an interface', async () => {
        const result = await pc.executeCommand('netsh interface set interface "Ethernet0" disable');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.isUp()).toBe(false);
      });

      it('should show error for unknown interface', async () => {
        const result = await pc.executeCommand('netsh interface set interface "Unknown" enable');
        expect(result.toLowerCase()).toContain('not found');
      });

      it('should support admin=enabled syntax', async () => {
        const result = await pc.executeCommand('netsh interface set interface "Ethernet0" admin=enabled');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should support admin=disabled syntax', async () => {
        const result = await pc.executeCommand('netsh interface set interface "Ethernet0" admin=disabled');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.isUp()).toBe(false);
      });
    });
  });

  describe('netsh interface ip', () => {
    describe('netsh interface ip show config', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        pc.setGateway(new IPAddress('192.168.1.1'));
      });

      it('should show IP configuration for all interfaces', async () => {
        const result = await pc.executeCommand('netsh interface ip show config');
        expect(result).toContain('Configuration for interface');
        expect(result).toContain('Ethernet0');
        expect(result).toContain('192.168.1.10');
      });

      it('should show gateway in config', async () => {
        const result = await pc.executeCommand('netsh interface ip show config');
        expect(result).toContain('Default Gateway');
        expect(result).toContain('192.168.1.1');
      });

      it('should show subnet mask', async () => {
        const result = await pc.executeCommand('netsh interface ip show config');
        expect(result).toContain('Subnet');
        expect(result).toContain('255.255.255.0');
      });
    });

    describe('netsh interface ip show config name=', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('10.0.0.5'), new SubnetMask('/8'));
      });

      it('should show config for specific interface', async () => {
        const result = await pc.executeCommand('netsh interface ip show config name="Ethernet0"');
        expect(result).toContain('Ethernet0');
        expect(result).toContain('10.0.0.5');
      });

      it('should show error for unknown interface', async () => {
        const result = await pc.executeCommand('netsh interface ip show config name="NonExistent"');
        expect(result.toLowerCase()).toContain('not found');
      });
    });

    describe('netsh interface ip show addresses', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('172.16.0.100'), new SubnetMask('/16'));
      });

      it('should show IP addresses', async () => {
        const result = await pc.executeCommand('netsh interface ip show addresses');
        expect(result).toContain('IP Address');
        expect(result).toContain('172.16.0.100');
      });

      it('should show subnet prefix length', async () => {
        const result = await pc.executeCommand('netsh interface ip show addresses');
        expect(result).toMatch(/Subnet|Prefix/i);
      });
    });

    describe('netsh interface ip set address', () => {
      it('should set static IP address', async () => {
        const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.50.1 255.255.255.0');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.getIPAddress()?.toString()).toBe('192.168.50.1');
        expect(iface?.getSubnetMask()?.toString()).toBe('255.255.255.0');
      });

      it('should set IP with gateway', async () => {
        const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.50.1 255.255.255.0 192.168.50.254');
        expect(result.toLowerCase()).toContain('ok');

        expect(pc.getGateway()?.toString()).toBe('192.168.50.254');
      });

      it('should reject invalid IP', async () => {
        const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 999.999.999.999 255.255.255.0');
        expect(result.toLowerCase()).toContain('not valid');
      });

      it('should reject invalid subnet mask', async () => {
        const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.1 999.999.999.999');
        expect(result.toLowerCase()).toContain('not valid');
      });

      it('should configure DHCP mode', async () => {
        const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" dhcp');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should use source=static syntax', async () => {
        const result = await pc.executeCommand('netsh interface ip set address name="Ethernet0" source=static addr=10.0.0.1 mask=255.0.0.0');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.getIPAddress()?.toString()).toBe('10.0.0.1');
      });
    });

    describe('netsh interface ip set dns', () => {
      it('should set primary DNS server', async () => {
        const result = await pc.executeCommand('netsh interface ip set dns "Ethernet0" static 8.8.8.8');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should set DNS with validation', async () => {
        const result = await pc.executeCommand('netsh interface ip set dns "Ethernet0" static 8.8.8.8 validate=no');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should configure DHCP for DNS', async () => {
        const result = await pc.executeCommand('netsh interface ip set dns "Ethernet0" dhcp');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should reject invalid DNS IP', async () => {
        const result = await pc.executeCommand('netsh interface ip set dns "Ethernet0" static invalid.dns');
        expect(result.toLowerCase()).toContain('not valid');
      });
    });

    describe('netsh interface ip add dns', () => {
      it('should add secondary DNS server', async () => {
        await pc.executeCommand('netsh interface ip set dns "Ethernet0" static 8.8.8.8');
        const result = await pc.executeCommand('netsh interface ip add dns "Ethernet0" 8.8.4.4');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should add DNS with index', async () => {
        const result = await pc.executeCommand('netsh interface ip add dns "Ethernet0" 1.1.1.1 index=2');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh interface ip delete dns', () => {
      it('should delete specific DNS server', async () => {
        await pc.executeCommand('netsh interface ip set dns "Ethernet0" static 8.8.8.8');
        const result = await pc.executeCommand('netsh interface ip delete dns "Ethernet0" 8.8.8.8');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should delete all DNS servers', async () => {
        const result = await pc.executeCommand('netsh interface ip delete dns "Ethernet0" all');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh interface ip set dnsservers', () => {
      it('should set DNS servers with dnsservers syntax', async () => {
        const result = await pc.executeCommand('netsh interface ip set dnsservers "Ethernet0" static 8.8.8.8 primary');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh interface ip show dns', () => {
      it('should show DNS configuration', async () => {
        await pc.executeCommand('netsh interface ip set dns "Ethernet0" static 8.8.8.8');
        const result = await pc.executeCommand('netsh interface ip show dns');
        expect(result).toContain('DNS');
        expect(result).toContain('8.8.8.8');
      });
    });

    describe('netsh interface ip add address', () => {
      it('should add secondary IP address', async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        const result = await pc.executeCommand('netsh interface ip add address "Ethernet0" 192.168.1.20 255.255.255.0');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh interface ip delete address', () => {
      it('should delete IP address', async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        const result = await pc.executeCommand('netsh interface ip delete address "Ethernet0" 192.168.1.10');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh interface ip show route', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        pc.setGateway(new IPAddress('192.168.1.1'));
      });

      it('should show routing table', async () => {
        const result = await pc.executeCommand('netsh interface ip show route');
        expect(result).toContain('Publish');
        expect(result).toContain('Prefix');
        expect(result.toLowerCase()).toContain('interface');
      });
    });
  });

  describe('netsh wlan', () => {
    describe('netsh wlan show profiles', () => {
      it('should show saved WiFi profiles', async () => {
        const result = await pc.executeCommand('netsh wlan show profiles');
        expect(result).toContain('Profiles on interface');
        expect(result.toLowerCase()).toContain('wi-fi');
      });
    });

    describe('netsh wlan show profile name=', () => {
      it('should show specific profile details', async () => {
        const result = await pc.executeCommand('netsh wlan show profile name="HomeNetwork"');
        expect(result.toLowerCase()).toContain('profile');
      });

      it('should show profile with key=clear', async () => {
        const result = await pc.executeCommand('netsh wlan show profile name="HomeNetwork" key=clear');
        expect(result.toLowerCase()).toContain('security');
      });
    });

    describe('netsh wlan show interfaces', () => {
      it('should show wireless interface status', async () => {
        const result = await pc.executeCommand('netsh wlan show interfaces');
        expect(result.toLowerCase()).toContain('interface');
        expect(result.toLowerCase()).toContain('state');
      });
    });

    describe('netsh wlan show networks', () => {
      it('should show available networks', async () => {
        const result = await pc.executeCommand('netsh wlan show networks');
        expect(result.toLowerCase()).toContain('ssid');
      });

      it('should show networks with mode=bssid', async () => {
        const result = await pc.executeCommand('netsh wlan show networks mode=bssid');
        expect(result.toLowerCase()).toContain('bssid');
      });
    });

    describe('netsh wlan connect', () => {
      it('should attempt to connect to network', async () => {
        const result = await pc.executeCommand('netsh wlan connect name="TestNetwork"');
        expect(result.toLowerCase()).toMatch(/connect|request/);
      });

      it('should connect with interface specified', async () => {
        const result = await pc.executeCommand('netsh wlan connect name="TestNetwork" interface="Wi-Fi"');
        expect(result.toLowerCase()).toMatch(/connect|request/);
      });
    });

    describe('netsh wlan disconnect', () => {
      it('should disconnect from current network', async () => {
        const result = await pc.executeCommand('netsh wlan disconnect');
        expect(result.toLowerCase()).toMatch(/disconnect|success/);
      });
    });

    describe('netsh wlan show drivers', () => {
      it('should show wireless driver information', async () => {
        const result = await pc.executeCommand('netsh wlan show drivers');
        expect(result.toLowerCase()).toContain('driver');
      });
    });
  });

  describe('netsh advfirewall', () => {
    describe('netsh advfirewall show currentprofile', () => {
      it('should show current firewall profile', async () => {
        const result = await pc.executeCommand('netsh advfirewall show currentprofile');
        expect(result.toLowerCase()).toContain('profile');
        expect(result.toLowerCase()).toContain('state');
      });

      it('should show firewall state (ON/OFF)', async () => {
        const result = await pc.executeCommand('netsh advfirewall show currentprofile');
        expect(result).toMatch(/ON|OFF/i);
      });
    });

    describe('netsh advfirewall show allprofiles', () => {
      it('should show all firewall profiles', async () => {
        const result = await pc.executeCommand('netsh advfirewall show allprofiles');
        expect(result.toLowerCase()).toContain('domain');
        expect(result.toLowerCase()).toContain('private');
        expect(result.toLowerCase()).toContain('public');
      });
    });

    describe('netsh advfirewall set currentprofile', () => {
      it('should enable firewall', async () => {
        const result = await pc.executeCommand('netsh advfirewall set currentprofile state on');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should disable firewall', async () => {
        const result = await pc.executeCommand('netsh advfirewall set currentprofile state off');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh advfirewall set allprofiles', () => {
      it('should set state for all profiles', async () => {
        const result = await pc.executeCommand('netsh advfirewall set allprofiles state on');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh advfirewall firewall show rule', () => {
      it('should show all firewall rules', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall show rule name=all');
        expect(result.toLowerCase()).toContain('rule');
      });

      it('should show specific rule', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall show rule name="Remote Desktop"');
        expect(result.toLowerCase()).toContain('rule');
      });

      it('should filter inbound rules', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall show rule name=all dir=in');
        expect(result.toLowerCase()).toContain('rule');
      });

      it('should filter outbound rules', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall show rule name=all dir=out');
        expect(result.toLowerCase()).toContain('rule');
      });
    });

    describe('netsh advfirewall firewall add rule', () => {
      it('should add inbound allow rule', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall add rule name="My Rule" dir=in action=allow protocol=tcp localport=8080');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should add outbound block rule', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall add rule name="Block App" dir=out action=block program="C:\\app.exe"');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh advfirewall firewall delete rule', () => {
      it('should delete firewall rule by name', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall delete rule name="My Rule"');
        expect(result.toLowerCase()).toMatch(/ok|deleted|not found/);
      });
    });

    describe('netsh advfirewall firewall set rule', () => {
      it('should modify existing rule', async () => {
        const result = await pc.executeCommand('netsh advfirewall firewall set rule name="My Rule" new enable=yes');
        expect(result.toLowerCase()).toMatch(/ok|updated|not found/);
      });
    });

    describe('netsh advfirewall reset', () => {
      it('should reset firewall to defaults', async () => {
        const result = await pc.executeCommand('netsh advfirewall reset');
        expect(result.toLowerCase()).toContain('ok');
      });
    });
  });

  describe('netsh winhttp', () => {
    describe('netsh winhttp show proxy', () => {
      it('should show proxy settings', async () => {
        const result = await pc.executeCommand('netsh winhttp show proxy');
        expect(result.toLowerCase()).toContain('proxy');
      });
    });

    describe('netsh winhttp set proxy', () => {
      it('should set proxy server', async () => {
        const result = await pc.executeCommand('netsh winhttp set proxy proxy-server="proxy.example.com:8080"');
        expect(result.toLowerCase()).toContain('ok');
      });

      it('should set proxy with bypass list', async () => {
        const result = await pc.executeCommand('netsh winhttp set proxy proxy-server="proxy.example.com:8080" bypass-list="*.local"');
        expect(result.toLowerCase()).toContain('ok');
      });
    });

    describe('netsh winhttp reset proxy', () => {
      it('should reset proxy to direct', async () => {
        const result = await pc.executeCommand('netsh winhttp reset proxy');
        expect(result.toLowerCase()).toContain('ok');
      });
    });
  });

  describe('netsh dump', () => {
    it('should dump configuration script', async () => {
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      const result = await pc.executeCommand('netsh dump');
      expect(result).toContain('netsh');
      expect(result.toLowerCase()).toContain('interface');
    });

    it('should produce replayable script format', async () => {
      pc.setIPAddress('eth0', new IPAddress('10.0.0.5'), new SubnetMask('/8'));
      const result = await pc.executeCommand('netsh dump');
      expect(result).toContain('#');
    });
  });

  describe('netsh interface ipv4', () => {
    describe('netsh interface ipv4 show config', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.50'), new SubnetMask('/24'));
      });

      it('should show IPv4 configuration', async () => {
        const result = await pc.executeCommand('netsh interface ipv4 show config');
        expect(result).toContain('192.168.1.50');
        expect(result.toLowerCase()).toContain('interface');
      });
    });

    describe('netsh interface ipv4 set address', () => {
      it('should set IPv4 address (same as ip set address)', async () => {
        const result = await pc.executeCommand('netsh interface ipv4 set address "Ethernet0" static 10.10.10.10 255.255.255.0');
        expect(result.toLowerCase()).toContain('ok');

        const iface = pc.getInterface('eth0');
        expect(iface?.getIPAddress()?.toString()).toBe('10.10.10.10');
      });
    });
  });

  describe('Error handling', () => {
    it('should handle invalid netsh subcommand', async () => {
      const result = await pc.executeCommand('netsh invalidsubcommand');
      expect(result.toLowerCase()).toMatch(/not found|invalid|unknown/);
    });

    it('should handle missing arguments', async () => {
      const result = await pc.executeCommand('netsh interface ip set address');
      expect(result.toLowerCase()).toMatch(/error|usage|missing/);
    });

    it('should be case-insensitive', async () => {
      const result1 = await pc.executeCommand('NETSH INTERFACE SHOW INTERFACE');
      const result2 = await pc.executeCommand('netsh interface show interface');
      expect(result1).toContain('Ethernet0');
      expect(result2).toContain('Ethernet0');
    });
  });
});
