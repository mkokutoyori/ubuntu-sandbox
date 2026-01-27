/**
 * TDD Tests for Linux networking commands
 *
 * Comprehensive tests for Linux network utilities:
 * - ip (addr, link, route, neigh, rule)
 * - nmcli (connection, device, general)
 * - ss (socket statistics)
 * - iptables (firewall)
 * - ufw (uncomplicated firewall)
 * - systemctl (service management)
 * - hostnamectl
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('Linux Networking Commands', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    pc = new LinuxPC({ id: 'pc1', name: 'ubuntu-pc', hostname: 'ubuntu-pc' });
    pc.powerOn();
  });

  describe('ip command', () => {
    describe('ip addr / ip address', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      });

      it('should show addresses with ip addr', async () => {
        const result = await pc.executeCommand('ip addr');
        expect(result).toContain('eth0');
        expect(result).toContain('192.168.1.10');
      });

      it('should show addresses with ip address', async () => {
        const result = await pc.executeCommand('ip address');
        expect(result).toContain('eth0');
        expect(result).toContain('inet');
      });

      it('should show addresses with ip a', async () => {
        const result = await pc.executeCommand('ip a');
        expect(result).toContain('eth0');
      });

      it('should show loopback interface', async () => {
        const result = await pc.executeCommand('ip addr');
        expect(result).toContain('lo');
        expect(result).toContain('127.0.0.1');
      });

      it('should show MAC address', async () => {
        const result = await pc.executeCommand('ip addr');
        expect(result.toLowerCase()).toContain('link/ether');
      });

      it('should show interface state (UP/DOWN)', async () => {
        const result = await pc.executeCommand('ip addr');
        expect(result).toMatch(/UP|DOWN/);
      });

      it('should show specific interface with ip addr show eth0', async () => {
        const result = await pc.executeCommand('ip addr show eth0');
        expect(result).toContain('eth0');
        expect(result).toContain('192.168.1.10');
      });

      it('should show specific interface with ip addr show dev eth0', async () => {
        const result = await pc.executeCommand('ip addr show dev eth0');
        expect(result).toContain('eth0');
      });
    });

    describe('ip addr add/del', () => {
      it('should add IP address', async () => {
        const result = await pc.executeCommand('ip addr add 10.0.0.5/24 dev eth0');
        expect(result).toBe('');

        const check = await pc.executeCommand('ip addr show eth0');
        expect(check).toContain('10.0.0.5');
      });

      it('should delete IP address', async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        const result = await pc.executeCommand('ip addr del 192.168.1.10/24 dev eth0');
        expect(result).toBe('');
      });

      it('should show error for invalid IP', async () => {
        const result = await pc.executeCommand('ip addr add invalid/24 dev eth0');
        expect(result.toLowerCase()).toContain('error');
      });
    });

    describe('ip link', () => {
      it('should show all interfaces with ip link', async () => {
        const result = await pc.executeCommand('ip link');
        expect(result).toContain('eth0');
        expect(result).toContain('lo');
      });

      it('should show interface with ip link show eth0', async () => {
        const result = await pc.executeCommand('ip link show eth0');
        expect(result).toContain('eth0');
      });

      it('should set interface up', async () => {
        await pc.executeCommand('ip link set eth0 down');
        const result = await pc.executeCommand('ip link set eth0 up');
        expect(result).toBe('');

        const iface = pc.getInterface('eth0');
        expect(iface?.isUp()).toBe(true);
      });

      it('should set interface down', async () => {
        const result = await pc.executeCommand('ip link set eth0 down');
        expect(result).toBe('');

        const iface = pc.getInterface('eth0');
        expect(iface?.isUp()).toBe(false);
      });

      it('should show statistics with ip -s link', async () => {
        const result = await pc.executeCommand('ip -s link');
        expect(result).toContain('RX');
        expect(result).toContain('TX');
      });
    });

    describe('ip route', () => {
      beforeEach(async () => {
        pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
        pc.setGateway(new IPAddress('192.168.1.1'));
      });

      it('should show routing table with ip route', async () => {
        const result = await pc.executeCommand('ip route');
        expect(result).toContain('default');
        expect(result).toContain('192.168.1.1');
      });

      it('should show routing table with ip r', async () => {
        const result = await pc.executeCommand('ip r');
        expect(result).toContain('default');
      });

      it('should show routing table with ip route show', async () => {
        const result = await pc.executeCommand('ip route show');
        expect(result).toContain('via');
      });

      it('should show network route', async () => {
        const result = await pc.executeCommand('ip route');
        expect(result).toContain('192.168.1.0/24');
      });

      it('should add route', async () => {
        const result = await pc.executeCommand('ip route add 10.0.0.0/8 via 192.168.1.1');
        expect(result).toBe('');
      });

      it('should delete route', async () => {
        const result = await pc.executeCommand('ip route del default');
        expect(result).toBe('');
      });

      it('should get route to destination', async () => {
        const result = await pc.executeCommand('ip route get 8.8.8.8');
        expect(result).toContain('via');
      });
    });

    describe('ip neigh / ip neighbor', () => {
      it('should show ARP table with ip neigh', async () => {
        const result = await pc.executeCommand('ip neigh');
        expect(result.toLowerCase()).toContain('lladdr');
      });

      it('should show ARP table with ip neighbor', async () => {
        const result = await pc.executeCommand('ip neighbor');
        expect(result.toLowerCase()).toMatch(/lladdr|reachable|stale/);
      });

      it('should show ARP table with ip n', async () => {
        const result = await pc.executeCommand('ip n');
        expect(result).toBeDefined();
      });

      it('should add neighbor entry', async () => {
        const result = await pc.executeCommand('ip neigh add 192.168.1.100 lladdr 00:11:22:33:44:55 dev eth0');
        expect(result).toBe('');
      });

      it('should delete neighbor entry', async () => {
        const result = await pc.executeCommand('ip neigh del 192.168.1.100 dev eth0');
        expect(result).toBe('');
      });

      it('should flush neighbor cache', async () => {
        const result = await pc.executeCommand('ip neigh flush all');
        expect(result).toBe('');
      });
    });

    describe('ip rule', () => {
      it('should show routing rules', async () => {
        const result = await pc.executeCommand('ip rule');
        expect(result).toContain('lookup');
      });

      it('should show rules with ip rule show', async () => {
        const result = await pc.executeCommand('ip rule show');
        expect(result).toContain('main');
      });
    });
  });

  describe('nmcli command', () => {
    describe('nmcli general', () => {
      it('should show general status', async () => {
        const result = await pc.executeCommand('nmcli general');
        expect(result.toLowerCase()).toContain('state');
      });

      it('should show general status with nmcli g', async () => {
        const result = await pc.executeCommand('nmcli g');
        expect(result.toLowerCase()).toContain('connected');
      });

      it('should show hostname', async () => {
        const result = await pc.executeCommand('nmcli general hostname');
        expect(result).toContain('ubuntu-pc');
      });
    });

    describe('nmcli device', () => {
      it('should list devices', async () => {
        const result = await pc.executeCommand('nmcli device');
        expect(result).toContain('eth0');
        expect(result.toLowerCase()).toContain('ethernet');
      });

      it('should list devices with nmcli d', async () => {
        const result = await pc.executeCommand('nmcli d');
        expect(result).toContain('eth0');
      });

      it('should show device status', async () => {
        const result = await pc.executeCommand('nmcli device status');
        expect(result).toContain('TYPE');
        expect(result).toContain('STATE');
      });

      it('should show specific device', async () => {
        const result = await pc.executeCommand('nmcli device show eth0');
        expect(result).toContain('eth0');
        expect(result).toContain('GENERAL.DEVICE');
      });

      it('should connect device', async () => {
        const result = await pc.executeCommand('nmcli device connect eth0');
        expect(result.toLowerCase()).toContain('success');
      });

      it('should disconnect device', async () => {
        const result = await pc.executeCommand('nmcli device disconnect eth0');
        expect(result.toLowerCase()).toContain('success');
      });

      it('should show wifi list', async () => {
        const result = await pc.executeCommand('nmcli device wifi list');
        expect(result.toLowerCase()).toContain('ssid');
      });
    });

    describe('nmcli connection', () => {
      it('should list connections', async () => {
        const result = await pc.executeCommand('nmcli connection');
        expect(result).toContain('NAME');
        expect(result).toContain('TYPE');
      });

      it('should list connections with nmcli c', async () => {
        const result = await pc.executeCommand('nmcli c');
        expect(result).toContain('NAME');
      });

      it('should show connection details', async () => {
        const result = await pc.executeCommand('nmcli connection show "Wired connection 1"');
        expect(result.toLowerCase()).toContain('connection');
      });

      it('should modify connection IP', async () => {
        const result = await pc.executeCommand('nmcli connection modify "Wired connection 1" ipv4.addresses 192.168.1.100/24');
        expect(result).toBe('');
      });

      it('should set connection to manual', async () => {
        const result = await pc.executeCommand('nmcli connection modify "Wired connection 1" ipv4.method manual');
        expect(result).toBe('');
      });

      it('should add DNS to connection', async () => {
        const result = await pc.executeCommand('nmcli connection modify "Wired connection 1" ipv4.dns 8.8.8.8');
        expect(result).toBe('');
      });

      it('should up connection', async () => {
        const result = await pc.executeCommand('nmcli connection up "Wired connection 1"');
        expect(result.toLowerCase()).toContain('success');
      });

      it('should down connection', async () => {
        const result = await pc.executeCommand('nmcli connection down "Wired connection 1"');
        expect(result.toLowerCase()).toContain('success');
      });
    });
  });

  describe('ss command', () => {
    it('should show all sockets with ss', async () => {
      const result = await pc.executeCommand('ss');
      expect(result).toContain('State');
    });

    it('should show listening sockets with ss -l', async () => {
      const result = await pc.executeCommand('ss -l');
      expect(result).toContain('LISTEN');
    });

    it('should show TCP sockets with ss -t', async () => {
      const result = await pc.executeCommand('ss -t');
      expect(result.toLowerCase()).toContain('tcp');
    });

    it('should show UDP sockets with ss -u', async () => {
      const result = await pc.executeCommand('ss -u');
      expect(result.toLowerCase()).toContain('udp');
    });

    it('should show listening TCP with ss -tl', async () => {
      const result = await pc.executeCommand('ss -tl');
      expect(result).toContain('LISTEN');
    });

    it('should show all with numeric ports ss -an', async () => {
      const result = await pc.executeCommand('ss -an');
      expect(result).toMatch(/:\d+/);
    });

    it('should show TCP listening with numeric ss -tlnp', async () => {
      const result = await pc.executeCommand('ss -tlnp');
      expect(result).toContain('LISTEN');
    });

    it('should show summary with ss -s', async () => {
      const result = await pc.executeCommand('ss -s');
      expect(result).toContain('Total');
      expect(result).toContain('TCP');
    });
  });

  describe('iptables command', () => {
    describe('iptables list', () => {
      it('should list rules with iptables -L', async () => {
        const result = await pc.executeCommand('iptables -L');
        expect(result).toContain('Chain INPUT');
        expect(result).toContain('Chain FORWARD');
        expect(result).toContain('Chain OUTPUT');
      });

      it('should list rules with line numbers iptables -L -n --line-numbers', async () => {
        const result = await pc.executeCommand('iptables -L -n --line-numbers');
        expect(result).toContain('num');
      });

      it('should list specific chain iptables -L INPUT', async () => {
        const result = await pc.executeCommand('iptables -L INPUT');
        expect(result).toContain('Chain INPUT');
      });

      it('should list with verbose iptables -L -v', async () => {
        const result = await pc.executeCommand('iptables -L -v');
        expect(result).toContain('pkts');
        expect(result).toContain('bytes');
      });

      it('should list nat table iptables -t nat -L', async () => {
        const result = await pc.executeCommand('iptables -t nat -L');
        expect(result).toContain('PREROUTING');
        expect(result).toContain('POSTROUTING');
      });
    });

    describe('iptables add/delete', () => {
      it('should add accept rule', async () => {
        const result = await pc.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
        expect(result).toBe('');
      });

      it('should add drop rule', async () => {
        const result = await pc.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP');
        expect(result).toBe('');
      });

      it('should insert rule at position', async () => {
        const result = await pc.executeCommand('iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT');
        expect(result).toBe('');
      });

      it('should delete rule by spec', async () => {
        const result = await pc.executeCommand('iptables -D INPUT -p tcp --dport 22 -j ACCEPT');
        expect(result).toBe('');
      });

      it('should delete rule by number', async () => {
        const result = await pc.executeCommand('iptables -D INPUT 1');
        expect(result).toBe('');
      });

      it('should flush chain', async () => {
        const result = await pc.executeCommand('iptables -F INPUT');
        expect(result).toBe('');
      });

      it('should flush all chains', async () => {
        const result = await pc.executeCommand('iptables -F');
        expect(result).toBe('');
      });

      it('should set default policy', async () => {
        const result = await pc.executeCommand('iptables -P INPUT DROP');
        expect(result).toBe('');
      });
    });

    describe('iptables source/destination', () => {
      it('should add rule with source', async () => {
        const result = await pc.executeCommand('iptables -A INPUT -s 192.168.1.0/24 -j ACCEPT');
        expect(result).toBe('');
      });

      it('should add rule with destination', async () => {
        const result = await pc.executeCommand('iptables -A OUTPUT -d 10.0.0.0/8 -j DROP');
        expect(result).toBe('');
      });
    });
  });

  describe('ufw command', () => {
    describe('ufw status', () => {
      it('should show status', async () => {
        const result = await pc.executeCommand('ufw status');
        expect(result.toLowerCase()).toMatch(/active|inactive/);
      });

      it('should show verbose status', async () => {
        const result = await pc.executeCommand('ufw status verbose');
        expect(result.toLowerCase()).toContain('default');
      });

      it('should show numbered status', async () => {
        const result = await pc.executeCommand('ufw status numbered');
        expect(result).toContain('[');
      });
    });

    describe('ufw enable/disable', () => {
      it('should enable firewall', async () => {
        const result = await pc.executeCommand('ufw enable');
        expect(result.toLowerCase()).toContain('enabled');
      });

      it('should disable firewall', async () => {
        const result = await pc.executeCommand('ufw disable');
        expect(result.toLowerCase()).toContain('disabled');
      });
    });

    describe('ufw rules', () => {
      it('should allow port', async () => {
        const result = await pc.executeCommand('ufw allow 22');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should allow port with protocol', async () => {
        const result = await pc.executeCommand('ufw allow 80/tcp');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should allow service by name', async () => {
        const result = await pc.executeCommand('ufw allow ssh');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should deny port', async () => {
        const result = await pc.executeCommand('ufw deny 23');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should allow from IP', async () => {
        const result = await pc.executeCommand('ufw allow from 192.168.1.0/24');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should allow from IP to port', async () => {
        const result = await pc.executeCommand('ufw allow from 192.168.1.100 to any port 22');
        expect(result.toLowerCase()).toContain('added');
      });

      it('should delete rule by number', async () => {
        const result = await pc.executeCommand('ufw delete 1');
        expect(result.toLowerCase()).toMatch(/deleted|not found/);
      });

      it('should delete rule by spec', async () => {
        const result = await pc.executeCommand('ufw delete allow 22');
        expect(result.toLowerCase()).toMatch(/deleted|not found/);
      });

      it('should reset firewall', async () => {
        const result = await pc.executeCommand('ufw reset');
        expect(result.toLowerCase()).toContain('reset');
      });
    });

    describe('ufw default', () => {
      it('should set default incoming', async () => {
        const result = await pc.executeCommand('ufw default deny incoming');
        expect(result.toLowerCase()).toContain('default');
      });

      it('should set default outgoing', async () => {
        const result = await pc.executeCommand('ufw default allow outgoing');
        expect(result.toLowerCase()).toContain('default');
      });
    });
  });

  describe('systemctl command', () => {
    describe('systemctl status', () => {
      it('should show service status', async () => {
        const result = await pc.executeCommand('systemctl status NetworkManager');
        expect(result.toLowerCase()).toContain('networkmanager');
      });

      it('should show active state', async () => {
        const result = await pc.executeCommand('systemctl status ssh');
        expect(result.toLowerCase()).toMatch(/active|inactive/);
      });
    });

    describe('systemctl control', () => {
      it('should start service', async () => {
        const result = await pc.executeCommand('systemctl start ssh');
        expect(result).toBe('');
      });

      it('should stop service', async () => {
        const result = await pc.executeCommand('systemctl stop ssh');
        expect(result).toBe('');
      });

      it('should restart service', async () => {
        const result = await pc.executeCommand('systemctl restart NetworkManager');
        expect(result).toBe('');
      });

      it('should enable service', async () => {
        const result = await pc.executeCommand('systemctl enable ssh');
        expect(result.toLowerCase()).toContain('enabled');
      });

      it('should disable service', async () => {
        const result = await pc.executeCommand('systemctl disable ssh');
        expect(result.toLowerCase()).toContain('disabled');
      });
    });

    describe('systemctl list', () => {
      it('should list units', async () => {
        const result = await pc.executeCommand('systemctl list-units');
        expect(result).toContain('UNIT');
        expect(result).toContain('LOAD');
      });

      it('should list unit files', async () => {
        const result = await pc.executeCommand('systemctl list-unit-files');
        expect(result).toContain('UNIT FILE');
        expect(result).toContain('STATE');
      });
    });

    describe('systemctl is-active/is-enabled', () => {
      it('should check if active', async () => {
        const result = await pc.executeCommand('systemctl is-active NetworkManager');
        expect(result.toLowerCase()).toMatch(/active|inactive/);
      });

      it('should check if enabled', async () => {
        const result = await pc.executeCommand('systemctl is-enabled ssh');
        expect(result.toLowerCase()).toMatch(/enabled|disabled/);
      });
    });
  });

  describe('hostnamectl command', () => {
    it('should show hostname info', async () => {
      const result = await pc.executeCommand('hostnamectl');
      expect(result).toContain('Static hostname');
      expect(result).toContain('ubuntu-pc');
    });

    it('should show hostname with hostnamectl status', async () => {
      const result = await pc.executeCommand('hostnamectl status');
      expect(result).toContain('hostname');
    });

    it('should set hostname', async () => {
      const result = await pc.executeCommand('hostnamectl set-hostname new-hostname');
      expect(result).toBe('');

      const check = await pc.executeCommand('hostname');
      expect(check).toBe('new-hostname');
    });
  });

  describe('netstat command (legacy)', () => {
    it('should show all connections with netstat -a', async () => {
      const result = await pc.executeCommand('netstat -a');
      expect(result).toContain('Proto');
    });

    it('should show listening with netstat -l', async () => {
      const result = await pc.executeCommand('netstat -l');
      expect(result).toContain('LISTEN');
    });

    it('should show TCP with netstat -t', async () => {
      const result = await pc.executeCommand('netstat -t');
      expect(result.toLowerCase()).toContain('tcp');
    });

    it('should show statistics with netstat -s', async () => {
      const result = await pc.executeCommand('netstat -s');
      expect(result.toLowerCase()).toContain('tcp');
    });

    it('should show routing with netstat -r', async () => {
      const result = await pc.executeCommand('netstat -r');
      expect(result).toContain('Destination');
      expect(result).toContain('Gateway');
    });

    it('should show interfaces with netstat -i', async () => {
      const result = await pc.executeCommand('netstat -i');
      expect(result).toContain('Iface');
      expect(result).toContain('eth0');
    });
  });

  describe('resolvectl / systemd-resolve command', () => {
    it('should show DNS status', async () => {
      const result = await pc.executeCommand('resolvectl status');
      expect(result.toLowerCase()).toContain('dns');
    });

    it('should query DNS', async () => {
      const result = await pc.executeCommand('resolvectl query google.com');
      expect(result.toLowerCase()).toContain('google');
    });

    it('should show DNS with systemd-resolve --status', async () => {
      const result = await pc.executeCommand('systemd-resolve --status');
      expect(result.toLowerCase()).toContain('dns');
    });
  });

  describe('dig/nslookup command', () => {
    it('should query with dig', async () => {
      const result = await pc.executeCommand('dig google.com');
      expect(result).toContain('QUERY');
      expect(result).toContain('ANSWER');
    });

    it('should query with nslookup', async () => {
      const result = await pc.executeCommand('nslookup google.com');
      expect(result).toContain('Server');
      expect(result).toContain('Address');
    });
  });

  describe('ethtool command', () => {
    it('should show interface info', async () => {
      const result = await pc.executeCommand('ethtool eth0');
      expect(result).toContain('Speed');
      expect(result).toContain('Link detected');
    });

    it('should show driver info with ethtool -i', async () => {
      const result = await pc.executeCommand('ethtool -i eth0');
      expect(result).toContain('driver');
    });

    it('should show statistics with ethtool -S', async () => {
      const result = await pc.executeCommand('ethtool -S eth0');
      expect(result.toLowerCase()).toContain('statistics');
    });
  });

  describe('Error handling', () => {
    it('should handle unknown ip subcommand', async () => {
      const result = await pc.executeCommand('ip invalid');
      expect(result.toLowerCase()).toMatch(/error|unknown|usage/);
    });

    it('should handle unknown interface', async () => {
      const result = await pc.executeCommand('ip addr show eth99');
      expect(result.toLowerCase()).toContain('not');
    });

    it('should be case-insensitive for commands', async () => {
      const result = await pc.executeCommand('IP ADDR');
      expect(result).toContain('eth0');
    });
  });
});
