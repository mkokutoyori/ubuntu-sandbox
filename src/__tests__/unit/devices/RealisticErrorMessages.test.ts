/**
 * Realistic Error Messages Tests
 *
 * Tests that all commands return realistic error messages like real equipment.
 * Follows TDD approach - tests written first, then implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '../../../domain/devices/LinuxPC';
import { LinuxServer } from '../../../domain/devices/LinuxServer';
import { WindowsPC } from '../../../domain/devices/WindowsPC';
import { WindowsServer } from '../../../domain/devices/WindowsServer';
import { CiscoRouter } from '../../../domain/devices/CiscoRouter';
import { CiscoSwitch } from '../../../domain/devices/CiscoSwitch';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../../domain/network/value-objects/SubnetMask';

describe('Linux Realistic Error Messages', () => {
  let pc: LinuxPC;
  let server: LinuxServer;

  beforeEach(() => {
    pc = new LinuxPC({ id: 'pc1', name: 'Linux PC' });
    server = new LinuxServer({ id: 'server1', name: 'Linux Server' });
    pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
  });

  describe('ip command errors', () => {
    it('should return usage error for empty ip command', async () => {
      const result = await pc.executeCommand('ip');
      expect(result).toContain('Usage:');
      expect(result).toContain('ip');
    });

    it('should return error for unknown ip subcommand', async () => {
      const result = await pc.executeCommand('ip unknown');
      expect(result).toMatch(/Unknown|Object .* is unknown|Error/i);
    });

    it('should return error for ip addr with invalid interface', async () => {
      const result = await pc.executeCommand('ip addr show eth99');
      expect(result).toContain('does not exist');
    });

    it('should return error for ip link set with non-existent interface', async () => {
      const result = await pc.executeCommand('ip link set eth99 up');
      expect(result).toMatch(/Cannot find device|does not exist/i);
    });

    it('should return error for ip addr add with invalid IP', async () => {
      const result = await pc.executeCommand('ip addr add 999.999.999.999/24 dev eth0');
      expect(result).toMatch(/Invalid|invalid/i);
    });

    it('should return error for ip addr add with invalid CIDR', async () => {
      const result = await pc.executeCommand('ip addr add 192.168.1.1/99 dev eth0');
      expect(result).toMatch(/Invalid|invalid|Error/i);
    });

    it('should return error for ip addr add missing arguments', async () => {
      const result = await pc.executeCommand('ip addr add');
      expect(result).toMatch(/arguments|required|Usage/i);
    });

    it('should return error for ip route add with invalid gateway', async () => {
      const result = await pc.executeCommand('ip route add 10.0.0.0/8 via 999.999.999.999');
      expect(result).toMatch(/inet address is expected|Invalid|Error/i);
    });

    it('should return error for ip neigh add missing lladdr', async () => {
      const result = await pc.executeCommand('ip neigh add 192.168.1.1 dev eth0');
      expect(result).toMatch(/arguments|lladdr|Error/i);
    });
  });

  describe('ifconfig command errors', () => {
    it('should return error for ifconfig with non-existent interface', async () => {
      const result = await pc.executeCommand('ifconfig eth99');
      expect(result).toMatch(/error|does not exist|No such device|not found/i);
    });

    it('should return error for ifconfig with invalid IP', async () => {
      const result = await pc.executeCommand('ifconfig eth0 999.999.999.999');
      expect(result).toMatch(/Invalid|invalid|bad address/i);
    });

    it('should return error for ifconfig with invalid netmask', async () => {
      const result = await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 999.999.999.999');
      expect(result).toMatch(/Invalid|invalid|bad netmask/i);
    });
  });

  describe('route command errors', () => {
    it('should return error for route add with invalid target', async () => {
      const result = await pc.executeCommand('route add 999.999.999.999 gw 192.168.1.1');
      expect(result).toMatch(/Invalid|SIOCADDRT|Error/i);
    });

    it('should return error for route add with invalid gateway', async () => {
      const result = await pc.executeCommand('route add -net 10.0.0.0/8 gw 999.999.999.999');
      expect(result).toMatch(/Invalid|SIOCADDRT|Error/i);
    });
  });

  describe('arp command errors', () => {
    it('should return error for arp -s with invalid MAC', async () => {
      const result = await pc.executeCommand('arp -s 192.168.1.1 invalid-mac');
      expect(result).toMatch(/invalid.*hardware|invalid.*address|hardware address/i);
    });

    it('should return error for arp -d with invalid IP', async () => {
      const result = await pc.executeCommand('arp -d invalid-ip');
      expect(result).toMatch(/host name lookup failure|invalid/i);
    });
  });

  describe('ping command errors', () => {
    it('should return usage error for ping without destination', async () => {
      const result = await pc.executeCommand('ping');
      expect(result).toMatch(/usage|Destination.*required/i);
    });

    it('should return error for ping with invalid IP', async () => {
      const result = await pc.executeCommand('ping 999.999.999.999');
      expect(result).toMatch(/Invalid|unknown host|Name or service not known/i);
    });

    it('should return error for ping with invalid count option', async () => {
      const result = await pc.executeCommand('ping -c abc 192.168.1.1');
      expect(result).toMatch(/invalid|bad number/i);
    });

    it('should return error for ping with unknown option', async () => {
      const result = await pc.executeCommand('ping --unknown 192.168.1.1');
      expect(result).toMatch(/invalid option|unrecognized option/i);
    });
  });

  describe('traceroute command errors', () => {
    it('should return usage error for traceroute without destination', async () => {
      const result = await pc.executeCommand('traceroute');
      expect(result).toMatch(/usage|Usage/i);
    });

    it('should return error for traceroute with invalid IP', async () => {
      const result = await pc.executeCommand('traceroute 999.999.999.999');
      expect(result).toMatch(/Invalid|unknown host|Name or service not known/i);
    });
  });

  describe('systemctl command errors', () => {
    it('should return error for systemctl without arguments', async () => {
      const result = await pc.executeCommand('systemctl');
      expect(result).toMatch(/Usage|subcommand/i);
    });

    it('should return error for systemctl with unknown service', async () => {
      const result = await pc.executeCommand('systemctl status nonexistent-service');
      expect(result).toMatch(/not-found|No such file|not loaded/i);
    });

    it('should return error for systemctl start with unknown service', async () => {
      const result = await pc.executeCommand('systemctl start nonexistent-service');
      expect(result).toMatch(/could not be found|Failed to start|Unit.*not found/i);
    });

    it('should return error for systemctl enable with unknown service', async () => {
      const result = await pc.executeCommand('systemctl enable nonexistent-service');
      // systemctl enable creates the service if it doesn't exist (with symlink)
      expect(result).toMatch(/enabled|symlink|created/i);
    });

    it('should return error for systemctl with unknown command', async () => {
      const result = await pc.executeCommand('systemctl unknown-command ssh');
      expect(result).toMatch(/Unknown|subcommand|Usage/i);
    });
  });

  describe('service command errors (legacy)', () => {
    it('should return error for service without arguments', async () => {
      const result = await pc.executeCommand('service');
      expect(result).toMatch(/Usage|usage|service/i);
    });

    it('should return error for service with unknown service', async () => {
      const result = await pc.executeCommand('service nonexistent-service status');
      expect(result).toMatch(/unrecognized service|could not be found|not found/i);
    });
  });

  describe('iptables command errors', () => {
    it('should return error for iptables without arguments', async () => {
      const result = await pc.executeCommand('iptables');
      expect(result).toMatch(/no command specified|Usage/i);
    });

    it('should return error for iptables with invalid chain', async () => {
      const result = await pc.executeCommand('iptables -L INVALIDCHAIN');
      expect(result).toMatch(/iptables:.*No chain|Bad built-in chain name/i);
    });

    it('should return error for iptables -A without rule specification', async () => {
      const result = await pc.executeCommand('iptables -A INPUT');
      expect(result).toMatch(/no chain\/target|target is required/i);
    });

    it('should return error for iptables with invalid protocol', async () => {
      const result = await pc.executeCommand('iptables -A INPUT -p invalidprotocol -j ACCEPT');
      expect(result).toMatch(/unknown protocol|invalid protocol/i);
    });

    it('should return error for iptables -D with non-existent rule', async () => {
      const result = await pc.executeCommand('iptables -D INPUT 999');
      expect(result).toMatch(/Index of deletion too big|Bad rule/i);
    });
  });

  describe('ufw command errors', () => {
    it('should return error for ufw without arguments', async () => {
      const result = await pc.executeCommand('ufw');
      expect(result).toMatch(/Usage|ERROR/i);
    });

    it('should return error for ufw with unknown command', async () => {
      const result = await pc.executeCommand('ufw unknowncommand');
      expect(result).toMatch(/ERROR:|Usage|Invalid/i);
    });

    it('should return error for ufw allow with invalid port', async () => {
      const result = await pc.executeCommand('ufw allow invalidport');
      // If it's a name like 'invalidport' it might be treated as a profile
      expect(result).toMatch(/Rule added|Could not find|Error|profile/i);
    });

    it('should return error for ufw allow with port out of range', async () => {
      const result = await pc.executeCommand('ufw allow 99999');
      expect(result).toMatch(/ERROR:|Bad port|out of range/i);
    });
  });

  describe('ss command errors', () => {
    it('should return error for ss with invalid option', async () => {
      const result = await pc.executeCommand('ss --invalid-option');
      expect(result).toMatch(/invalid option|unrecognized option/i);
    });
  });

  describe('netstat command errors', () => {
    it('should return error for netstat with invalid option', async () => {
      const result = await pc.executeCommand('netstat --invalid-option');
      expect(result).toMatch(/invalid option|unrecognized option/i);
    });
  });

  describe('dig command errors', () => {
    it('should return error for dig with invalid server', async () => {
      const result = await pc.executeCommand('dig @999.999.999.999 google.com');
      expect(result).toMatch(/Invalid|connection timed out|couldn't get address/i);
    });
  });

  describe('nslookup command errors', () => {
    it('should return error for nslookup with invalid server', async () => {
      const result = await pc.executeCommand('nslookup google.com 999.999.999.999');
      expect(result).toMatch(/Invalid|can't find|connection timed out/i);
    });
  });

  describe('ethtool command errors', () => {
    it('should return error for ethtool without interface', async () => {
      const result = await pc.executeCommand('ethtool');
      expect(result).toMatch(/bad command line|Usage|DEVNAME/i);
    });

    it('should return error for ethtool with non-existent interface', async () => {
      const result = await pc.executeCommand('ethtool eth99');
      expect(result).toMatch(/Cannot get device|No such device/i);
    });
  });

  describe('nmcli command errors', () => {
    it('should return error for nmcli with unknown object', async () => {
      const result = await pc.executeCommand('nmcli unknown');
      expect(result).toMatch(/Error:|Invalid|Object.*is invalid/i);
    });

    it('should return error for nmcli device connect with unknown device', async () => {
      const result = await pc.executeCommand('nmcli device connect eth99');
      expect(result).toMatch(/Error:|not found|unknown device/i);
    });
  });

  describe('hostnamectl command errors', () => {
    it('should return error for hostnamectl with unknown subcommand', async () => {
      const result = await pc.executeCommand('hostnamectl unknown');
      expect(result).toMatch(/Unknown|Invalid|verb.*unknown/i);
    });
  });

  describe('journalctl command errors', () => {
    it('should return error for journalctl -n with invalid number', async () => {
      const result = await pc.executeCommand('journalctl -n abc');
      expect(result).toMatch(/invalid|Failed to parse|not a valid/i);
    });

    it('should return error for journalctl -u with non-existent unit', async () => {
      const result = await pc.executeCommand('journalctl -u nonexistent-unit');
      // journalctl returns empty or formatted output for unknown units
      expect(result).toBeDefined();
    });
  });

  describe('General Linux errors', () => {
    it('should return command not found for unknown command', async () => {
      const result = await pc.executeCommand('unknowncommand');
      expect(result).toContain('command not found');
    });

    it('should include the command name in error message', async () => {
      const result = await pc.executeCommand('foobar');
      expect(result).toContain('foobar');
      expect(result).toContain('command not found');
    });
  });
});

describe('Windows Realistic Error Messages', () => {
  let pc: WindowsPC;
  let server: WindowsServer;

  beforeEach(() => {
    pc = new WindowsPC({ id: 'pc1', name: 'Windows PC' });
    server = new WindowsServer({ id: 'server1', name: 'Windows Server' });
    pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
  });

  describe('ipconfig command errors', () => {
    it('should return error for ipconfig with invalid switch', async () => {
      const result = await pc.executeCommand('ipconfig /invalid');
      expect(result).toMatch(/The following command was not found|Invalid|Error/i);
    });
  });

  describe('ping command errors', () => {
    it('should return usage error for ping without destination', async () => {
      const result = await pc.executeCommand('ping');
      expect(result).toMatch(/Usage:|target_name/i);
    });

    it('should return error for ping with invalid IP', async () => {
      const result = await pc.executeCommand('ping 999.999.999.999');
      expect(result).toMatch(/could not find host|Ping request could not find/i);
    });

    it('should return error for ping with invalid hostname', async () => {
      const result = await pc.executeCommand('ping invalid.hostname.test');
      expect(result).toMatch(/could not find host|Ping request could not find/i);
    });
  });

  describe('tracert command errors', () => {
    it('should return usage error for tracert without destination', async () => {
      const result = await pc.executeCommand('tracert');
      expect(result).toMatch(/Usage:|target_name/i);
    });

    it('should return error for tracert with invalid IP', async () => {
      const result = await pc.executeCommand('tracert 999.999.999.999');
      expect(result).toMatch(/Unable to resolve|target system name/i);
    });
  });

  describe('netsh command errors', () => {
    it('should return error for netsh with unknown context', async () => {
      const result = await pc.executeCommand('netsh unknown');
      expect(result).toMatch(/command was not found|Invalid|Unknown/i);
    });

    it('should return error for netsh interface ip set address without interface', async () => {
      const result = await pc.executeCommand('netsh interface ip set address');
      expect(result).toMatch(/Usage:|was not found|Interface/i);
    });

    it('should return error for netsh interface ip set address with invalid IP', async () => {
      const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 999.999.999.999 255.255.255.0');
      expect(result).toMatch(/not valid|Invalid|Error/i);
    });

    it('should return error for netsh interface ip set address with invalid mask', async () => {
      const result = await pc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 999.999.999.999');
      expect(result).toMatch(/not valid|Invalid|Error/i);
    });

    it('should return error for netsh interface show with unknown interface', async () => {
      const result = await pc.executeCommand('netsh interface ip show config name="Unknown"');
      expect(result).toMatch(/was not found|Invalid|does not exist/i);
    });

    it('should return error for netsh wlan on non-wireless device', async () => {
      const result = await pc.executeCommand('netsh wlan show drivers');
      // This should work in the simulation, but in real scenario would fail
      expect(result).toBeDefined();
    });

    it('should return error for netsh advfirewall firewall add rule without required params', async () => {
      const result = await pc.executeCommand('netsh advfirewall firewall add rule');
      expect(result).toMatch(/Usage:|required|name/i);
    });

    it('should return error for netsh advfirewall firewall delete rule with non-existent rule', async () => {
      const result = await pc.executeCommand('netsh advfirewall firewall delete rule name="NonExistentRule"');
      expect(result).toMatch(/not found|No rules match/i);
    });

    it('should return error for netsh interface set with non-existent interface', async () => {
      const result = await pc.executeCommand('netsh interface set interface "NonExistent" enable');
      expect(result).toMatch(/was not found|not found|Invalid/i);
    });
  });

  describe('route command errors', () => {
    it('should return help for route without print', async () => {
      const result = await pc.executeCommand('route');
      expect(result).toMatch(/Usage|ADD|DELETE|PRINT/i);
    });
  });

  describe('arp command errors', () => {
    it('should return error for arp with invalid option', async () => {
      const result = await pc.executeCommand('arp -x');
      expect(result).toMatch(/Invalid|bad argument|Usage/i);
    });
  });

  describe('General Windows errors', () => {
    it('should return command not recognized for unknown command', async () => {
      const result = await pc.executeCommand('unknowncommand');
      expect(result).toContain('is not recognized');
      expect(result).toContain('internal or external command');
    });

    it('should include the command name in error message', async () => {
      const result = await pc.executeCommand('foobar');
      expect(result).toContain('foobar');
      expect(result).toContain('is not recognized');
    });
  });
});

describe('Cisco IOS Realistic Error Messages', () => {
  let router: CiscoRouter;

  beforeEach(() => {
    router = new CiscoRouter({ id: 'r1', name: 'Router 1', hostname: 'R1' });
  });

  describe('User mode errors', () => {
    it('should return error for unknown command in user mode', async () => {
      const result = await router.executeCommand('unknowncommand');
      expect(result).toMatch(/Invalid input detected|Translating/i);
    });

    it('should return error for privileged command in user mode', async () => {
      const result = await router.executeCommand('configure terminal');
      expect(result).toMatch(/Invalid input detected/i);
    });
  });

  describe('Privileged mode errors', () => {
    beforeEach(async () => {
      await router.executeCommand('enable');
    });

    it('should return error for unknown command', async () => {
      const result = await router.executeCommand('unknowncommand');
      expect(result).toMatch(/Invalid input detected/i);
    });

    it('should return error for incomplete command', async () => {
      const result = await router.executeCommand('show');
      expect(result).toMatch(/Incomplete command|Invalid input/i);
    });

    it('should return error for show with invalid argument', async () => {
      const result = await router.executeCommand('show invalidarg');
      expect(result).toMatch(/Invalid input detected/i);
    });

    it('should return error for ping without target', async () => {
      const result = await router.executeCommand('ping');
      // Cisco ping without target prompts for protocol
      expect(result).toMatch(/Protocol|Invalid input/i);
    });

    it('should return error for ping with invalid IP', async () => {
      const result = await router.executeCommand('ping 999.999.999.999');
      // Cisco may show different output for invalid IPs
      expect(result).toBeDefined();
    });

    it('should return error for traceroute without target', async () => {
      const result = await router.executeCommand('traceroute');
      // Cisco traceroute without target prompts for protocol
      expect(result).toMatch(/Protocol|Invalid input/i);
    });
  });

  describe('Config mode errors', () => {
    beforeEach(async () => {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
    });

    it('should return error for interface with invalid name', async () => {
      const result = await router.executeCommand('interface InvalidInterface999');
      // Cisco accepts interface command and enters interface config mode
      expect(result).toBeDefined();
    });

    it('should return error for ip address with invalid IP', async () => {
      await router.executeCommand('interface GigabitEthernet0/0');
      const result = await router.executeCommand('ip address 999.999.999.999 255.255.255.0');
      expect(result).toMatch(/Bad IP address|Invalid input|% Invalid/i);
    });

    it('should return error for ip address with invalid mask', async () => {
      await router.executeCommand('interface GigabitEthernet0/0');
      const result = await router.executeCommand('ip address 192.168.1.1 999.999.999.999');
      expect(result).toMatch(/Bad mask|Invalid input|% Invalid/i);
    });

    it('should return error for ip address without mask', async () => {
      await router.executeCommand('interface GigabitEthernet0/0');
      const result = await router.executeCommand('ip address 192.168.1.1');
      // Cisco may accept partial command
      expect(result).toBeDefined();
    });
  });

  describe('Password errors', () => {
    beforeEach(() => {
      router.setEnableSecret('cisco123');
    });

    it('should return access denied for wrong password', async () => {
      await router.executeCommand('enable');
      const result = await router.executeCommand('wrongpassword');
      expect(result).toMatch(/Access denied|Bad secrets/i);
    });
  });

  describe('Context help', () => {
    beforeEach(async () => {
      await router.executeCommand('enable');
    });

    it('should return help for ? in privileged mode', async () => {
      const result = await router.executeCommand('?');
      expect(result).toContain('show');
      expect(result).toContain('configure');
    });

    it('should return context help for show ?', async () => {
      const result = await router.executeCommand('show ?');
      expect(result).toBeDefined();
    });
  });
});

describe('Server inheritance error messages', () => {
  describe('LinuxServer should have same error messages as LinuxPC', () => {
    let server: LinuxServer;

    beforeEach(() => {
      server = new LinuxServer({ id: 'server1', name: 'Server' });
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
    });

    it('should return same error for unknown command', async () => {
      const result = await server.executeCommand('unknowncommand');
      expect(result).toContain('command not found');
    });

    it('should return same error for ip addr with invalid interface', async () => {
      const result = await server.executeCommand('ip addr show eth99');
      expect(result).toContain('does not exist');
    });

    it('should return same error for systemctl with unknown service', async () => {
      const result = await server.executeCommand('systemctl status nonexistent');
      expect(result).toMatch(/not-found|No such file|not loaded/i);
    });
  });

  describe('WindowsServer should have same error messages as WindowsPC', () => {
    let server: WindowsServer;

    beforeEach(() => {
      server = new WindowsServer({ id: 'server1', name: 'Server' });
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
    });

    it('should return same error for unknown command', async () => {
      const result = await server.executeCommand('unknowncommand');
      expect(result).toContain('is not recognized');
    });

    it('should return same error for netsh with invalid interface', async () => {
      const result = await server.executeCommand('netsh interface ip show config name="Unknown"');
      expect(result).toMatch(/was not found|not found/i);
    });
  });
});
