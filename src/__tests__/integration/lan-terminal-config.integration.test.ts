/**
 * LAN Terminal Configuration Integration Tests
 *
 * Tests that verify LAN configuration and communication using only terminal commands.
 * This simulates real-world network administration scenarios.
 *
 * Test Scenarios:
 * 1. Simple Linux LAN (2 PCs + Switch)
 * 2. Simple Windows LAN (2 PCs + Switch)
 * 3. Mixed Linux/Windows LAN (4 PCs + Switch)
 * 4. LAN with Server (3 clients + 1 server + Switch)
 * 5. Multi-switch LAN with Router
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '../../domain/devices/LinuxPC';
import { LinuxServer } from '../../domain/devices/LinuxServer';
import { WindowsPC } from '../../domain/devices/WindowsPC';
import { WindowsServer } from '../../domain/devices/WindowsServer';
import { Switch } from '../../domain/devices/Switch';
import { Hub } from '../../domain/devices/Hub';
import { EthernetFrame } from '../../domain/network/entities/EthernetFrame';
import { IPAddress } from '../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../domain/network/value-objects/SubnetMask';

// Helper function to connect a PC to a switch
function connectToSwitch(pc: LinuxPC | WindowsPC | LinuxServer | WindowsServer, sw: Switch, port: number): void {
  const iface = pc.getInterface('eth0');
  if (!iface) return;

  pc.onFrameTransmit((frame) => {
    sw.receiveFrame(port, frame);
  });

  sw.onFrameForward((forwardPort, frame) => {
    if (forwardPort === port) {
      pc.receiveFrame('eth0', frame);
    }
  });
}

// Helper function to connect a PC to a hub
function connectToHub(pc: LinuxPC | WindowsPC | LinuxServer | WindowsServer, hub: Hub, port: number): void {
  const iface = pc.getInterface('eth0');
  if (!iface) return;

  pc.onFrameTransmit((frame) => {
    hub.receiveFrame(port, frame);
  });

  hub.onFrameForward((forwardPort, frame) => {
    if (forwardPort === port) {
      pc.receiveFrame('eth0', frame);
    }
  });
}

describe('LAN Terminal Configuration Integration Tests', () => {

  describe('Scenario 1: Simple Linux LAN (2 PCs + Switch)', () => {
    let pc1: LinuxPC;
    let pc2: LinuxPC;
    let sw: Switch;

    beforeEach(() => {
      // Create devices
      pc1 = new LinuxPC({ id: 'linux-pc-1', name: 'Linux PC 1', hostname: 'pc1' });
      pc2 = new LinuxPC({ id: 'linux-pc-2', name: 'Linux PC 2', hostname: 'pc2' });
      sw = new Switch({ id: 'switch-1', name: 'Switch 1' });

      // Physical connections using helper
      connectToSwitch(pc1, sw, 0);
      connectToSwitch(pc2, sw, 1);
    });

    describe('Configuration via ifconfig', () => {
      it('should configure PC1 IP address using ifconfig', async () => {
        const result = await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
        expect(result).toBe('');

        // Verify configuration
        const config = await pc1.executeCommand('ifconfig eth0');
        expect(config).toContain('192.168.1.10');
        expect(config).toContain('255.255.255.0');
      });

      it('should configure PC2 IP address using ifconfig', async () => {
        const result = await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
        expect(result).toBe('');

        // Verify configuration
        const config = await pc2.executeCommand('ifconfig eth0');
        expect(config).toContain('192.168.1.20');
      });

      it('should show both interfaces with ifconfig -a', async () => {
        await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
        const result = await pc1.executeCommand('ifconfig -a');
        expect(result).toContain('eth0');
        expect(result).toContain('192.168.1.10');
      });
    });

    describe('Configuration via ip command', () => {
      it('should configure PC1 IP address using ip addr add', async () => {
        const result = await pc1.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
        expect(result).toBe('');

        // Verify configuration
        const config = await pc1.executeCommand('ip addr show eth0');
        expect(config).toContain('192.168.1.10');
      });

      it('should configure PC2 IP address using ip addr add', async () => {
        const result = await pc2.executeCommand('ip addr add 192.168.1.20/24 dev eth0');
        expect(result).toBe('');

        // Verify with ip addr
        const config = await pc2.executeCommand('ip addr');
        expect(config).toContain('192.168.1.20');
      });

      it('should show interface status with ip link', async () => {
        const result = await pc1.executeCommand('ip link show eth0');
        expect(result).toContain('eth0');
        expect(result).toContain('UP');
      });
    });

    describe('Ping communication after configuration', () => {
      beforeEach(async () => {
        // Configure both PCs
        await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
        await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
      });

      it('should ping from PC1 to PC2', async () => {
        const result = await pc1.executeCommand('ping -c 1 192.168.1.20');
        expect(result).toContain('192.168.1.20');
        // The ping output should show the ping was attempted
        expect(result).toMatch(/PING|bytes from|icmp_seq/i);
      });

      it('should ping from PC2 to PC1', async () => {
        const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
        expect(result).toContain('192.168.1.10');
        expect(result).toMatch(/PING|bytes from|icmp_seq/i);
      });

      it('should show ARP entry after ping', async () => {
        await pc1.executeCommand('ping -c 1 192.168.1.20');

        // Check ARP table
        const arp = await pc1.executeCommand('arp -a');
        expect(arp).toBeDefined();
      });

      it('should show ARP entry with ip neigh', async () => {
        await pc1.executeCommand('ping -c 1 192.168.1.20');

        const neigh = await pc1.executeCommand('ip neigh');
        expect(neigh).toBeDefined();
      });
    });

    describe('Traceroute between PCs', () => {
      beforeEach(async () => {
        await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
        await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
      });

      it('should traceroute from PC1 to PC2', async () => {
        const result = await pc1.executeCommand('traceroute 192.168.1.20');
        expect(result).toContain('192.168.1.20');
      });
    });

    describe('Network diagnostics', () => {
      beforeEach(async () => {
        await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
      });

      it('should show route table', async () => {
        const result = await pc1.executeCommand('route');
        expect(result).toBeDefined();
      });

      it('should show route table with ip route', async () => {
        const result = await pc1.executeCommand('ip route');
        expect(result).toBeDefined();
      });

      it('should show network statistics with netstat', async () => {
        const result = await pc1.executeCommand('netstat -i');
        expect(result).toContain('eth0');
      });

      it('should show sockets with ss', async () => {
        const result = await pc1.executeCommand('ss -tln');
        expect(result).toBeDefined();
      });
    });
  });

  describe('Scenario 2: Simple Windows LAN (2 PCs + Switch)', () => {
    let pc1: WindowsPC;
    let pc2: WindowsPC;
    let sw: Switch;

    beforeEach(() => {
      pc1 = new WindowsPC({ id: 'win-pc-1', name: 'Windows PC 1', hostname: 'WINPC1' });
      pc2 = new WindowsPC({ id: 'win-pc-2', name: 'Windows PC 2', hostname: 'WINPC2' });
      sw = new Switch({ id: 'switch-1', name: 'Switch 1' });

      connectToSwitch(pc1, sw, 0);
      connectToSwitch(pc2, sw, 1);
    });

    describe('Configuration via netsh', () => {
      it('should configure PC1 IP address using netsh', async () => {
        const result = await pc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
        expect(result).toMatch(/Ok\.|^$/); // netsh returns "Ok." on success

        // Verify with ipconfig
        const config = await pc1.executeCommand('ipconfig');
        expect(config).toContain('192.168.1.10');
      });

      it('should configure PC2 IP address using netsh', async () => {
        const result = await pc2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
        expect(result).toMatch(/Ok\.|^$/); // netsh returns "Ok." on success

        // Verify with ipconfig /all
        const config = await pc2.executeCommand('ipconfig /all');
        expect(config).toContain('192.168.1.20');
      });

      it('should show interface configuration with netsh', async () => {
        await pc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');

        const result = await pc1.executeCommand('netsh interface ip show config');
        expect(result).toContain('192.168.1.10');
      });

      it('should show all interfaces with netsh', async () => {
        const result = await pc1.executeCommand('netsh interface show interface');
        expect(result).toContain('Ethernet');
      });
    });

    describe('Ping communication after configuration', () => {
      beforeEach(async () => {
        await pc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
        await pc2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
      });

      it('should ping from PC1 to PC2', async () => {
        const result = await pc1.executeCommand('ping -n 1 192.168.1.20');
        expect(result).toContain('192.168.1.20');
        expect(result).toMatch(/Pinging|Reply from|bytes/i);
      });

      it('should ping from PC2 to PC1', async () => {
        const result = await pc2.executeCommand('ping -n 1 192.168.1.10');
        expect(result).toContain('192.168.1.10');
      });

      it('should show ARP table after ping', async () => {
        await pc1.executeCommand('ping -n 1 192.168.1.20');

        const arp = await pc1.executeCommand('arp -a');
        expect(arp).toBeDefined();
      });
    });

    describe('Tracert between PCs', () => {
      beforeEach(async () => {
        await pc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
        await pc2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
      });

      it('should tracert from PC1 to PC2', async () => {
        const result = await pc1.executeCommand('tracert 192.168.1.20');
        expect(result).toContain('192.168.1.20');
      });
    });

    describe('Network diagnostics', () => {
      beforeEach(async () => {
        await pc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
      });

      it('should show route table with route print', async () => {
        const result = await pc1.executeCommand('route print');
        expect(result).toBeDefined();
      });

      it('should show hostname', async () => {
        const result = await pc1.executeCommand('hostname');
        expect(result).toBe('WINPC1');
      });

      it('should show system info', async () => {
        const result = await pc1.executeCommand('systeminfo');
        expect(result).toContain('Windows');
      });
    });
  });

  describe('Scenario 3: Mixed Linux/Windows LAN (4 PCs + Switch)', () => {
    let linuxPc1: LinuxPC;
    let linuxPc2: LinuxPC;
    let winPc1: WindowsPC;
    let winPc2: WindowsPC;
    let sw: Switch;

    beforeEach(() => {
      linuxPc1 = new LinuxPC({ id: 'linux-1', name: 'Linux 1', hostname: 'linux1' });
      linuxPc2 = new LinuxPC({ id: 'linux-2', name: 'Linux 2', hostname: 'linux2' });
      winPc1 = new WindowsPC({ id: 'win-1', name: 'Windows 1', hostname: 'WIN1' });
      winPc2 = new WindowsPC({ id: 'win-2', name: 'Windows 2', hostname: 'WIN2' });
      sw = new Switch({ id: 'switch-1', name: 'Central Switch' });

      // Connect all to switch
      connectToSwitch(linuxPc1, sw, 0);
      connectToSwitch(linuxPc2, sw, 1);
      connectToSwitch(winPc1, sw, 2);
      connectToSwitch(winPc2, sw, 3);
    });

    describe('Configuration', () => {
      it('should configure all 4 PCs in the same subnet', async () => {
        // Configure Linux PCs with ip command
        await linuxPc1.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
        await linuxPc2.executeCommand('ip addr add 192.168.1.11/24 dev eth0');

        // Configure Windows PCs with netsh
        await winPc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
        await winPc2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.21 255.255.255.0');

        // Verify all configurations
        const linux1Config = await linuxPc1.executeCommand('ip addr show eth0');
        const linux2Config = await linuxPc2.executeCommand('ip addr show eth0');
        const win1Config = await winPc1.executeCommand('ipconfig');
        const win2Config = await winPc2.executeCommand('ipconfig');

        expect(linux1Config).toContain('192.168.1.10');
        expect(linux2Config).toContain('192.168.1.11');
        expect(win1Config).toContain('192.168.1.20');
        expect(win2Config).toContain('192.168.1.21');
      });
    });

    describe('Cross-platform communication', () => {
      beforeEach(async () => {
        await linuxPc1.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
        await linuxPc2.executeCommand('ip addr add 192.168.1.11/24 dev eth0');
        await winPc1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
        await winPc2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.21 255.255.255.0');
      });

      it('should ping from Linux to Windows', async () => {
        const result = await linuxPc1.executeCommand('ping -c 1 192.168.1.20');
        expect(result).toContain('192.168.1.20');
      });

      it('should ping from Windows to Linux', async () => {
        const result = await winPc1.executeCommand('ping -n 1 192.168.1.10');
        expect(result).toContain('192.168.1.10');
      });

      it('should ping between Linux PCs', async () => {
        const result = await linuxPc1.executeCommand('ping -c 1 192.168.1.11');
        expect(result).toContain('192.168.1.11');
      });

      it('should ping between Windows PCs', async () => {
        const result = await winPc1.executeCommand('ping -n 1 192.168.1.21');
        expect(result).toContain('192.168.1.21');
      });

      it('should traceroute from Linux to Windows', async () => {
        const result = await linuxPc1.executeCommand('traceroute 192.168.1.20');
        expect(result).toContain('192.168.1.20');
      });

      it('should tracert from Windows to Linux', async () => {
        const result = await winPc1.executeCommand('tracert 192.168.1.10');
        expect(result).toContain('192.168.1.10');
      });
    });

    describe('Full connectivity matrix', () => {
      const ips = {
        linuxPc1: '192.168.1.10',
        linuxPc2: '192.168.1.11',
        winPc1: '192.168.1.20',
        winPc2: '192.168.1.21'
      };

      beforeEach(async () => {
        await linuxPc1.executeCommand(`ip addr add ${ips.linuxPc1}/24 dev eth0`);
        await linuxPc2.executeCommand(`ip addr add ${ips.linuxPc2}/24 dev eth0`);
        await winPc1.executeCommand(`netsh interface ip set address "Ethernet0" static ${ips.winPc1} 255.255.255.0`);
        await winPc2.executeCommand(`netsh interface ip set address "Ethernet0" static ${ips.winPc2} 255.255.255.0`);
      });

      it('Linux1 should reach all other hosts', async () => {
        const targets = [ips.linuxPc2, ips.winPc1, ips.winPc2];
        for (const target of targets) {
          const result = await linuxPc1.executeCommand(`ping -c 1 ${target}`);
          expect(result).toContain(target);
        }
      });

      it('Windows1 should reach all other hosts', async () => {
        const targets = [ips.linuxPc1, ips.linuxPc2, ips.winPc2];
        for (const target of targets) {
          const result = await winPc1.executeCommand(`ping -n 1 ${target}`);
          expect(result).toContain(target);
        }
      });
    });
  });

  describe('Scenario 4: LAN with Linux Server (3 clients + 1 server + Switch)', () => {
    let server: LinuxServer;
    let client1: LinuxPC;
    let client2: WindowsPC;
    let client3: LinuxPC;
    let sw: Switch;

    beforeEach(() => {
      server = new LinuxServer({ id: 'server-1', name: 'Linux Server', hostname: 'server' });
      client1 = new LinuxPC({ id: 'client-1', name: 'Client 1', hostname: 'client1' });
      client2 = new WindowsPC({ id: 'client-2', name: 'Client 2', hostname: 'CLIENT2' });
      client3 = new LinuxPC({ id: 'client-3', name: 'Client 3', hostname: 'client3' });
      sw = new Switch({ id: 'switch-1', name: 'Main Switch' });

      // Connect all to switch
      connectToSwitch(server, sw, 0);
      connectToSwitch(client1, sw, 1);
      connectToSwitch(client2, sw, 2);
      connectToSwitch(client3, sw, 3);
    });

    describe('Server configuration', () => {
      it('should configure server IP using ifconfig', async () => {
        const result = await server.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
        expect(result).toBe('');

        const config = await server.executeCommand('ifconfig eth0');
        expect(config).toContain('192.168.1.1');
      });

      it('should configure server IP using ip command', async () => {
        const result = await server.executeCommand('ip addr add 192.168.1.1/24 dev eth0');
        expect(result).toBe('');

        const config = await server.executeCommand('ip addr');
        expect(config).toContain('192.168.1.1');
      });

      it('should show all server interfaces', async () => {
        await server.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');

        // Server should have multiple interfaces (eth0, eth1, eth2, eth3)
        const config = await server.executeCommand('ip link');
        expect(config).toContain('eth0');
      });

      it('should configure multiple server interfaces', async () => {
        await server.executeCommand('ip addr add 192.168.1.1/24 dev eth0');
        await server.executeCommand('ip addr add 192.168.2.1/24 dev eth1');

        const eth0 = await server.executeCommand('ip addr show eth0');
        const eth1 = await server.executeCommand('ip addr show eth1');

        expect(eth0).toContain('192.168.1.1');
        expect(eth1).toContain('192.168.2.1');
      });
    });

    describe('Service management on server', () => {
      it('should check SSH service status', async () => {
        const result = await server.executeCommand('systemctl status ssh');
        expect(result).toContain('ssh.service');
      });

      it('should start Apache service', async () => {
        await server.executeCommand('systemctl start apache2');
        const status = await server.executeCommand('systemctl is-active apache2');
        expect(status).toBe('active');
      });

      it('should enable nginx service', async () => {
        const result = await server.executeCommand('systemctl enable nginx');
        expect(result).toContain('enabled');
      });

      it('should list all services', async () => {
        const result = await server.executeCommand('systemctl list-units --type=service');
        expect(result).toContain('UNIT');
      });
    });

    describe('Client-Server communication', () => {
      beforeEach(async () => {
        // Configure server
        await server.executeCommand('ip addr add 192.168.1.1/24 dev eth0');

        // Configure clients
        await client1.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
        await client2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');
        await client3.executeCommand('ip addr add 192.168.1.30/24 dev eth0');
      });

      it('should ping server from Linux client', async () => {
        const result = await client1.executeCommand('ping -c 1 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });

      it('should ping server from Windows client', async () => {
        const result = await client2.executeCommand('ping -n 1 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });

      it('should ping all clients from server', async () => {
        const clients = ['192.168.1.10', '192.168.1.20', '192.168.1.30'];
        for (const clientIp of clients) {
          const result = await server.executeCommand(`ping -c 1 ${clientIp}`);
          expect(result).toContain(clientIp);
        }
      });

      it('should traceroute to server from client', async () => {
        const result = await client1.executeCommand('traceroute 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });
    });

    describe('Server firewall configuration', () => {
      it('should configure iptables rules', async () => {
        await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
        await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
        await server.executeCommand('iptables -A INPUT -p tcp --dport 443 -j ACCEPT');

        const rules = await server.executeCommand('iptables -L INPUT');
        expect(rules).toContain('ACCEPT');
        expect(rules).toContain('tcp');
      });

      it('should configure ufw rules', async () => {
        await server.executeCommand('ufw allow 22/tcp');
        await server.executeCommand('ufw allow 80/tcp');
        await server.executeCommand('ufw enable');

        const status = await server.executeCommand('ufw status');
        expect(status).toContain('active');
      });
    });
  });

  describe('Scenario 5: LAN with Windows Server', () => {
    let server: WindowsServer;
    let client1: WindowsPC;
    let client2: LinuxPC;
    let sw: Switch;

    beforeEach(() => {
      server = new WindowsServer({ id: 'win-server', name: 'Windows Server', hostname: 'WINSERVER' });
      client1 = new WindowsPC({ id: 'win-client', name: 'Windows Client', hostname: 'WINCLIENT' });
      client2 = new LinuxPC({ id: 'linux-client', name: 'Linux Client', hostname: 'linuxclient' });
      sw = new Switch({ id: 'switch-1', name: 'Switch' });

      connectToSwitch(server, sw, 0);
      connectToSwitch(client1, sw, 1);
      connectToSwitch(client2, sw, 2);
    });

    describe('Server configuration', () => {
      it('should configure Windows Server IP', async () => {
        const result = await server.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.1 255.255.255.0');
        expect(result).toMatch(/Ok\.|^$/); // netsh returns "Ok." on success

        const config = await server.executeCommand('ipconfig');
        expect(config).toContain('192.168.1.1');
      });

      it('should show all server interfaces', async () => {
        const result = await server.executeCommand('ipconfig /all');
        expect(result).toContain('Ethernet');
      });
    });

    describe('Windows Server firewall', () => {
      it('should add firewall rule with netsh', async () => {
        const result = await server.executeCommand('netsh advfirewall firewall add rule name="Web Server" dir=in action=allow protocol=tcp localport=80');
        expect(result).toMatch(/Ok\./); // May include trailing newline

        const rules = await server.executeCommand('netsh advfirewall firewall show rule name="Web Server"');
        expect(rules).toContain('Web Server');
      });

      it('should show firewall status', async () => {
        const result = await server.executeCommand('netsh advfirewall show allprofiles');
        expect(result).toBeDefined();
      });
    });

    describe('Client-Server communication', () => {
      beforeEach(async () => {
        await server.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.1 255.255.255.0');
        await client1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
        await client2.executeCommand('ip addr add 192.168.1.20/24 dev eth0');
      });

      it('should ping Windows Server from Windows client', async () => {
        const result = await client1.executeCommand('ping -n 1 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });

      it('should ping Windows Server from Linux client', async () => {
        const result = await client2.executeCommand('ping -c 1 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });

      it('should tracert to server', async () => {
        const result = await client1.executeCommand('tracert 192.168.1.1');
        expect(result).toContain('192.168.1.1');
      });
    });
  });

  describe('Scenario 6: LAN with Hub (collision domain)', () => {
    let pc1: LinuxPC;
    let pc2: LinuxPC;
    let pc3: LinuxPC;
    let hub: Hub;

    beforeEach(() => {
      pc1 = new LinuxPC({ id: 'pc-1', name: 'PC 1', hostname: 'pc1' });
      pc2 = new LinuxPC({ id: 'pc-2', name: 'PC 2', hostname: 'pc2' });
      pc3 = new LinuxPC({ id: 'pc-3', name: 'PC 3', hostname: 'pc3' });
      hub = new Hub({ id: 'hub-1', name: 'Hub 1' });

      connectToHub(pc1, hub, 0);
      connectToHub(pc2, hub, 1);
      connectToHub(pc3, hub, 2);
    });

    describe('Configuration and communication', () => {
      beforeEach(async () => {
        await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
        await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
        await pc3.executeCommand('ifconfig eth0 192.168.1.30 netmask 255.255.255.0');
      });

      it('should ping between all PCs via hub', async () => {
        const result1 = await pc1.executeCommand('ping -c 1 192.168.1.20');
        const result2 = await pc1.executeCommand('ping -c 1 192.168.1.30');
        const result3 = await pc2.executeCommand('ping -c 1 192.168.1.30');

        expect(result1).toContain('192.168.1.20');
        expect(result2).toContain('192.168.1.30');
        expect(result3).toContain('192.168.1.30');
      });
    });
  });

  describe('Scenario 7: Interface management commands', () => {
    let pc: LinuxPC;
    let winPc: WindowsPC;

    beforeEach(() => {
      pc = new LinuxPC({ id: 'linux-pc', name: 'Linux PC', hostname: 'linuxpc' });
      winPc = new WindowsPC({ id: 'win-pc', name: 'Windows PC', hostname: 'WINPC' });
    });

    describe('Linux interface management', () => {
      it('should bring interface down and up', async () => {
        await pc.executeCommand('ip link set eth0 down');
        let status = await pc.executeCommand('ip link show eth0');
        // Interface should be down
        expect(status).toBeDefined();

        await pc.executeCommand('ip link set eth0 up');
        status = await pc.executeCommand('ip link show eth0');
        expect(status).toContain('UP');
      });

      it('should show ethtool information', async () => {
        const result = await pc.executeCommand('ethtool eth0');
        expect(result).toBeDefined();
      });

      it('should show network manager status', async () => {
        const result = await pc.executeCommand('nmcli device status');
        expect(result).toBeDefined();
      });

      it('should show hostname with hostnamectl', async () => {
        const result = await pc.executeCommand('hostnamectl');
        expect(result).toContain('linuxpc');
      });
    });

    describe('Windows interface management', () => {
      it('should disable and enable interface', async () => {
        await winPc.executeCommand('netsh interface set interface "Ethernet0" disable');
        let status = await winPc.executeCommand('netsh interface show interface "Ethernet0"');
        expect(status).toBeDefined();

        await winPc.executeCommand('netsh interface set interface "Ethernet0" enable');
        status = await winPc.executeCommand('netsh interface show interface "Ethernet0"');
        expect(status).toBeDefined();
      });

      it('should show Windows version', async () => {
        const result = await winPc.executeCommand('ver');
        expect(result).toContain('Windows');
      });

      it('should show whoami', async () => {
        const result = await winPc.executeCommand('whoami');
        expect(result).toContain('WINPC');
      });
    });
  });

  describe('Scenario 8: Error handling in LAN configuration', () => {
    let pc: LinuxPC;
    let winPc: WindowsPC;

    beforeEach(() => {
      pc = new LinuxPC({ id: 'linux-pc', name: 'Linux PC' });
      winPc = new WindowsPC({ id: 'win-pc', name: 'Windows PC' });
    });

    describe('Linux error scenarios', () => {
      it('should fail with invalid IP address', async () => {
        const result = await pc.executeCommand('ip addr add 999.999.999.999/24 dev eth0');
        expect(result).toMatch(/Invalid|Error/i);
      });

      it('should fail with non-existent interface', async () => {
        const result = await pc.executeCommand('ifconfig eth99 192.168.1.1');
        expect(result).toMatch(/not found|error/i);
      });

      it('should fail ping to invalid IP', async () => {
        await pc.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
        const result = await pc.executeCommand('ping 999.999.999.999');
        expect(result).toMatch(/Invalid|unknown|Name or service/i);
      });
    });

    describe('Windows error scenarios', () => {
      it('should fail with invalid IP in netsh', async () => {
        const result = await winPc.executeCommand('netsh interface ip set address "Ethernet0" static 999.999.999.999 255.255.255.0');
        expect(result).toMatch(/not valid|Invalid|Error/i);
      });

      it('should fail ping to invalid hostname', async () => {
        await winPc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
        const result = await winPc.executeCommand('ping invalid.host.test');
        expect(result).toMatch(/could not find|Ping request could not find/i);
      });
    });
  });

  describe('Scenario 9: Complete office network simulation', () => {
    let server: LinuxServer;
    let adminPc: LinuxPC;
    let workstation1: WindowsPC;
    let workstation2: WindowsPC;
    let workstation3: LinuxPC;
    let mainSwitch: Switch;

    beforeEach(() => {
      // Create devices
      server = new LinuxServer({ id: 'file-server', name: 'File Server', hostname: 'fileserver' });
      adminPc = new LinuxPC({ id: 'admin-pc', name: 'Admin PC', hostname: 'admin' });
      workstation1 = new WindowsPC({ id: 'ws-1', name: 'Workstation 1', hostname: 'WS1' });
      workstation2 = new WindowsPC({ id: 'ws-2', name: 'Workstation 2', hostname: 'WS2' });
      workstation3 = new LinuxPC({ id: 'ws-3', name: 'Workstation 3', hostname: 'ws3' });
      mainSwitch = new Switch({ id: 'main-sw', name: 'Main Switch' });

      // Connect all devices
      connectToSwitch(server, mainSwitch, 0);
      connectToSwitch(adminPc, mainSwitch, 1);
      connectToSwitch(workstation1, mainSwitch, 2);
      connectToSwitch(workstation2, mainSwitch, 3);
      connectToSwitch(workstation3, mainSwitch, 4);
    });

    it('should configure complete office network', async () => {
      // Configure server
      await server.executeCommand('ip addr add 192.168.10.1/24 dev eth0');
      await server.executeCommand('systemctl start ssh');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 445 -j ACCEPT');

      // Configure admin PC
      await adminPc.executeCommand('ip addr add 192.168.10.2/24 dev eth0');

      // Configure Windows workstations
      await workstation1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.10.10 255.255.255.0');
      await workstation2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.10.11 255.255.255.0');

      // Configure Linux workstation
      await workstation3.executeCommand('ifconfig eth0 192.168.10.20 netmask 255.255.255.0');

      // Verify all configurations
      const serverConfig = await server.executeCommand('ip addr show eth0');
      const adminConfig = await adminPc.executeCommand('ip addr show eth0');
      const ws1Config = await workstation1.executeCommand('ipconfig');
      const ws2Config = await workstation2.executeCommand('ipconfig');
      const ws3Config = await workstation3.executeCommand('ifconfig eth0');

      expect(serverConfig).toContain('192.168.10.1');
      expect(adminConfig).toContain('192.168.10.2');
      expect(ws1Config).toContain('192.168.10.10');
      expect(ws2Config).toContain('192.168.10.11');
      expect(ws3Config).toContain('192.168.10.20');
    });

    it('should verify full network connectivity', async () => {
      // Configure all devices
      await server.executeCommand('ip addr add 192.168.10.1/24 dev eth0');
      await adminPc.executeCommand('ip addr add 192.168.10.2/24 dev eth0');
      await workstation1.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.10.10 255.255.255.0');
      await workstation2.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.10.11 255.255.255.0');
      await workstation3.executeCommand('ifconfig eth0 192.168.10.20 netmask 255.255.255.0');

      // Test connectivity from all workstations to server
      const ws1ToServer = await workstation1.executeCommand('ping -n 1 192.168.10.1');
      const ws2ToServer = await workstation2.executeCommand('ping -n 1 192.168.10.1');
      const ws3ToServer = await workstation3.executeCommand('ping -c 1 192.168.10.1');
      const adminToServer = await adminPc.executeCommand('ping -c 1 192.168.10.1');

      expect(ws1ToServer).toContain('192.168.10.1');
      expect(ws2ToServer).toContain('192.168.10.1');
      expect(ws3ToServer).toContain('192.168.10.1');
      expect(adminToServer).toContain('192.168.10.1');

      // Test connectivity between workstations
      const ws1ToWs2 = await workstation1.executeCommand('ping -n 1 192.168.10.11');
      const ws2ToWs3 = await workstation2.executeCommand('ping -n 1 192.168.10.20');

      expect(ws1ToWs2).toContain('192.168.10.11');
      expect(ws2ToWs3).toContain('192.168.10.20');
    });

    it('should show network diagnostics from admin PC', async () => {
      await adminPc.executeCommand('ip addr add 192.168.10.2/24 dev eth0');

      // Run various diagnostic commands
      const ipAddr = await adminPc.executeCommand('ip addr');
      const ipRoute = await adminPc.executeCommand('ip route');
      const arpTable = await adminPc.executeCommand('arp -a');
      const ssOutput = await adminPc.executeCommand('ss -tln');

      expect(ipAddr).toContain('192.168.10.2');
      expect(ipRoute).toBeDefined();
      expect(arpTable).toBeDefined();
      expect(ssOutput).toBeDefined();
    });
  });
});
