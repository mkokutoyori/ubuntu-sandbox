/**
 * DeviceState Unit Tests
 * Tests isolated device state for Linux, Windows, and Cisco devices
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxDeviceState, createLinuxDeviceState } from '../devices/linux/LinuxDeviceState';
import { WindowsDeviceState, createWindowsDeviceState } from '../devices/windows/WindowsDeviceState';
import { CiscoDeviceState, createCiscoDeviceState } from '../devices/cisco/CiscoDeviceState';

// ============================================================================
// LINUX DEVICE STATE TESTS
// ============================================================================

describe('LinuxDeviceState', () => {
  let device1: LinuxDeviceState;
  let device2: LinuxDeviceState;

  beforeEach(() => {
    device1 = createLinuxDeviceState({
      deviceId: 'linux-1',
      hostname: 'server1',
      distribution: 'Ubuntu 22.04 LTS'
    });

    device2 = createLinuxDeviceState({
      deviceId: 'linux-2',
      hostname: 'server2',
      distribution: 'Debian 12'
    });
  });

  describe('Isolation', () => {
    it('should have separate file systems for each device', () => {
      // Create file on device1
      device1.createFile('/home/user/test.txt', 'Device 1 content');

      // File should not exist on device2
      expect(device1.exists('/home/user/test.txt')).toBe(true);
      expect(device2.exists('/home/user/test.txt')).toBe(false);
    });

    it('should have separate hostnames', () => {
      expect(device1.getHostname()).toBe('server1');
      expect(device2.getHostname()).toBe('server2');
    });

    it('should have separate processes', () => {
      const pid1 = device1.createProcess('nginx', ['-g', 'daemon off;']);
      const pid2 = device2.createProcess('apache2', ['-D', 'FOREGROUND']);

      // Each device has its own process with the same PID (PIDs are per-machine, not global)
      // Verify isolation by checking the command names
      const process1 = device1.getProcess(pid1);
      const process2 = device2.getProcess(pid2);

      expect(process1).not.toBeNull();
      expect(process1!.command).toBe('nginx');

      expect(process2).not.toBeNull();
      expect(process2!.command).toBe('apache2');

      // Verify the processes are actually different instances
      expect(process1).not.toBe(process2);
    });

    it('should have separate network configurations', () => {
      device1.configureInterface('eth0', {
        ipAddress: '192.168.1.10',
        netmask: '255.255.255.0'
      });

      device2.configureInterface('eth0', {
        ipAddress: '192.168.1.20',
        netmask: '255.255.255.0'
      });

      const iface1 = device1.getInterface('eth0');
      const iface2 = device2.getInterface('eth0');

      expect(iface1?.ipAddress).toBe('192.168.1.10');
      expect(iface2?.ipAddress).toBe('192.168.1.20');
    });
  });

  describe('File System', () => {
    it('should have standard Linux directories', () => {
      expect(device1.isDirectory('/home')).toBe(true);
      expect(device1.isDirectory('/etc')).toBe(true);
      expect(device1.isDirectory('/var')).toBe(true);
      expect(device1.isDirectory('/usr')).toBe(true);
      expect(device1.isDirectory('/tmp')).toBe(true);
      expect(device1.isDirectory('/proc')).toBe(true);
    });

    it('should have configuration files', () => {
      expect(device1.isFile('/etc/hostname')).toBe(true);
      expect(device1.isFile('/etc/passwd')).toBe(true);
      expect(device1.isFile('/etc/hosts')).toBe(true);
      expect(device1.isFile('/etc/resolv.conf')).toBe(true);
    });

    it('should have correct hostname file content', () => {
      const content = device1.readFile('/etc/hostname');
      expect(content).toContain('server1');
    });

    it('should resolve relative paths', () => {
      device1.setWorkingDirectory('/home/user');
      const resolved = device1.resolvePath('Documents');
      expect(resolved).toBe('/home/user/Documents');
    });

    it('should resolve .. in paths', () => {
      const resolved = device1.resolvePath('/home/user/../user/Documents');
      expect(resolved).toBe('/home/user/Documents');
    });

    it('should resolve ~ to home directory', () => {
      const resolved = device1.resolvePath('~/Documents');
      expect(resolved).toBe('/home/user/Documents');
    });

    it('should create files', () => {
      const result = device1.createFile('/tmp/test.txt', 'Hello World');
      expect(result).toBe(true);
      expect(device1.readFile('/tmp/test.txt')).toBe('Hello World');
    });

    it('should create directories recursively', () => {
      const result = device1.createDirectory('/home/user/projects/test/src', true);
      expect(result).toBe(true);
      expect(device1.isDirectory('/home/user/projects/test/src')).toBe(true);
    });

    it('should delete files', () => {
      device1.createFile('/tmp/todelete.txt', 'temp');
      expect(device1.exists('/tmp/todelete.txt')).toBe(true);

      device1.deleteNode('/tmp/todelete.txt');
      expect(device1.exists('/tmp/todelete.txt')).toBe(false);
    });

    it('should append to files', () => {
      device1.createFile('/tmp/append.txt', 'Line 1\n');
      device1.writeFile('/tmp/append.txt', 'Line 2\n', true);

      const content = device1.readFile('/tmp/append.txt');
      expect(content).toBe('Line 1\nLine 2\n');
    });
  });

  describe('User Management', () => {
    it('should have default users', () => {
      expect(device1.getUser('root')).not.toBeNull();
      expect(device1.getUser('user')).not.toBeNull();
    });

    it('should add new users', () => {
      const result = device1.addUser({
        uid: 1001,
        gid: 1001,
        username: 'newuser',
        home: '/home/newuser',
        shell: '/bin/bash',
        groups: ['newuser']
      });

      expect(result).toBe(true);
      expect(device1.getUser('newuser')).not.toBeNull();
    });

    it('should have default groups', () => {
      expect(device1.getGroup('root')).not.toBeNull();
      expect(device1.getGroup('sudo')).not.toBeNull();
    });
  });

  describe('Process Management', () => {
    it('should create processes', () => {
      const pid = device1.createProcess('bash', ['-c', 'echo hello']);
      expect(pid).toBeGreaterThan(0);
      expect(device1.getProcess(pid)).not.toBeNull();
    });

    it('should kill processes', () => {
      const pid = device1.createProcess('sleep', ['100']);
      expect(device1.killProcess(pid)).toBe(true);
    });

    it('should list processes', () => {
      const processes = device1.listProcesses();
      expect(processes.length).toBeGreaterThan(0);

      // Should have init process
      const initProcess = processes.find(p => p.pid === 1);
      expect(initProcess).not.toBeUndefined();
    });
  });

  describe('Service Management', () => {
    it('should have default services', () => {
      const sshService = device1.getService('ssh');
      expect(sshService).not.toBeNull();
      expect(sshService?.state).toBe('running');
    });

    it('should stop and start services', () => {
      device1.stopService('ssh');
      expect(device1.getService('ssh')?.state).toBe('stopped');

      device1.startService('ssh');
      expect(device1.getService('ssh')?.state).toBe('running');
    });

    it('should list services', () => {
      const services = device1.listServices();
      expect(services.length).toBeGreaterThan(0);
    });
  });

  describe('Package Management', () => {
    it('should have default packages', () => {
      expect(device1.getPackage('bash')).not.toBeNull();
      expect(device1.getPackage('openssh-server')).not.toBeNull();
    });

    it('should list installed packages', () => {
      const packages = device1.listPackages(true);
      expect(packages.length).toBeGreaterThan(0);
    });
  });

  describe('Network Configuration', () => {
    it('should have loopback interface', () => {
      const lo = device1.getInterface('lo');
      expect(lo).not.toBeNull();
      expect(lo?.ipAddress).toBe('127.0.0.1');
    });

    it('should configure interfaces', () => {
      device1.configureInterface('eth0', {
        type: 'ethernet',
        ipAddress: '10.0.0.5',
        netmask: '255.255.255.0',
        isUp: true
      });

      const eth0 = device1.getInterface('eth0');
      expect(eth0).not.toBeNull();
      expect(eth0?.ipAddress).toBe('10.0.0.5');
    });

    it('should add routes when interface is configured', () => {
      device1.configureInterface('eth0', {
        ipAddress: '192.168.1.100',
        netmask: '255.255.255.0',
        isUp: true
      });

      const routes = device1.getRoutes();
      const connectedRoute = routes.find(r => r.destination === '192.168.1.0');
      expect(connectedRoute).not.toBeUndefined();
    });

    it('should manage ARP table', () => {
      device1.addARPEntry({
        ipAddress: '192.168.1.1',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        interface: 'eth0',
        type: 'dynamic',
        age: 0
      });

      const arpTable = device1.getARPTable();
      expect(arpTable.length).toBe(1);
      expect(arpTable[0].macAddress).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should resolve hostnames', () => {
      const localhost = device1.resolveHostname('localhost');
      expect(localhost).toBe('127.0.0.1');
    });
  });

  describe('Environment', () => {
    it('should have environment variables', () => {
      expect(device1.getEnv('PATH')).toBeDefined();
      expect(device1.getEnv('HOME')).toBe('/home/user');
      expect(device1.getEnv('USER')).toBe('user');
    });

    it('should set environment variables', () => {
      device1.setEnv('CUSTOM_VAR', 'custom_value');
      expect(device1.getEnv('CUSTOM_VAR')).toBe('custom_value');
    });

    it('should change working directory', () => {
      const result = device1.setWorkingDirectory('/tmp');
      expect(result).toBe(true);
      expect(device1.getWorkingDirectory()).toBe('/tmp');
    });
  });
});

// ============================================================================
// WINDOWS DEVICE STATE TESTS
// ============================================================================

describe('WindowsDeviceState', () => {
  let device1: WindowsDeviceState;
  let device2: WindowsDeviceState;

  beforeEach(() => {
    device1 = createWindowsDeviceState({
      deviceId: 'windows-1',
      hostname: 'WORKSTATION1',
      windowsVersion: 'Windows 10 Pro'
    });

    device2 = createWindowsDeviceState({
      deviceId: 'windows-2',
      hostname: 'SERVER1',
      windowsVersion: 'Windows Server 2022'
    });
  });

  describe('Isolation', () => {
    it('should have separate file systems', () => {
      device1.createFile('C:\\Users\\User\\Documents\\test.txt', 'Device 1');

      expect(device1.exists('C:\\Users\\User\\Documents\\test.txt')).toBe(true);
      expect(device2.exists('C:\\Users\\User\\Documents\\test.txt')).toBe(false);
    });

    it('should have separate hostnames (uppercase)', () => {
      expect(device1.getHostname()).toBe('WORKSTATION1');
      expect(device2.getHostname()).toBe('SERVER1');
    });
  });

  describe('File System', () => {
    it('should have Windows directory structure', () => {
      expect(device1.isDirectory('C:\\Windows')).toBe(true);
      expect(device1.isDirectory('C:\\Windows\\System32')).toBe(true);
      expect(device1.isDirectory('C:\\Program Files')).toBe(true);
      expect(device1.isDirectory('C:\\Users')).toBe(true);
    });

    it('should have system files', () => {
      expect(device1.isFile('C:\\Windows\\System32\\cmd.exe')).toBe(true);
      expect(device1.isFile('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true);
    });

    it('should handle case-insensitive paths', () => {
      expect(device1.isDirectory('c:\\windows')).toBe(true);
      expect(device1.isDirectory('C:\\WINDOWS')).toBe(true);
    });

    it('should handle environment variables in paths', () => {
      const resolved = device1.resolvePath('%USERPROFILE%\\Documents');
      expect(resolved).toBe('C:\\Users\\User\\Documents');
    });

    it('should have multiple drives', () => {
      const drives = device1.getDrives();
      expect(drives).toContain('C:');
      expect(drives).toContain('D:');
    });
  });

  describe('User Management', () => {
    it('should have default users', () => {
      expect(device1.getUser('Administrator')).not.toBeNull();
      expect(device1.getUser('User')).not.toBeNull();
      expect(device1.getUser('SYSTEM')).not.toBeNull();
    });

    it('should have default groups', () => {
      expect(device1.getGroup('Administrators')).not.toBeNull();
      expect(device1.getGroup('Users')).not.toBeNull();
    });
  });

  describe('Process Management', () => {
    it('should have system processes', () => {
      const processes = device1.listProcesses();

      const system = processes.find(p => p.command === 'System');
      expect(system).not.toBeUndefined();

      const explorer = processes.find(p => p.command === 'explorer.exe');
      expect(explorer).not.toBeUndefined();
    });

    it('should not kill system processes', () => {
      expect(device1.killProcess(4)).toBe(false); // System process
    });
  });

  describe('Service Management', () => {
    it('should have Windows services', () => {
      expect(device1.getService('wuauserv')).not.toBeNull(); // Windows Update
      expect(device1.getService('Dhcp')).not.toBeNull();
      expect(device1.getService('Dnscache')).not.toBeNull();
    });

    it('should manage services', () => {
      const termService = device1.getService('TermService');
      expect(termService?.state).toBe('stopped');

      device1.startService('TermService');
      expect(device1.getService('TermService')?.state).toBe('running');
    });
  });

  describe('Network Configuration', () => {
    it('should have loopback interface', () => {
      const lo = device1.getInterface('Loopback Pseudo-Interface 1');
      expect(lo).not.toBeNull();
      expect(lo?.ipAddress).toBe('127.0.0.1');
    });

    it('should configure interfaces', () => {
      device1.configureInterface('Ethernet', {
        type: 'ethernet',
        ipAddress: '192.168.1.50',
        netmask: '255.255.255.0',
        isUp: true
      });

      const eth = device1.getInterface('Ethernet');
      expect(eth?.ipAddress).toBe('192.168.1.50');
    });
  });

  describe('Environment', () => {
    it('should have Windows environment variables', () => {
      expect(device1.getEnv('SystemRoot')).toBe('C:\\Windows');
      expect(device1.getEnv('COMPUTERNAME')).toBe('WORKSTATION1');
      expect(device1.getEnv('USERPROFILE')).toBe('C:\\Users\\User');
    });
  });
});

// ============================================================================
// CISCO DEVICE STATE TESTS
// ============================================================================

describe('CiscoDeviceState', () => {
  let router1: CiscoDeviceState;
  let switch1: CiscoDeviceState;

  beforeEach(() => {
    router1 = createCiscoDeviceState({
      deviceId: 'router-1',
      hostname: 'Router1',
      ciscoType: 'router'
    });

    switch1 = createCiscoDeviceState({
      deviceId: 'switch-1',
      hostname: 'Switch1',
      ciscoType: 'switch'
    });
  });

  describe('Isolation', () => {
    it('should have separate configurations', () => {
      router1.setHostname('R1');
      switch1.setHostname('SW1');

      expect(router1.getHostname()).toBe('R1');
      expect(switch1.getHostname()).toBe('SW1');
    });

    it('should have separate VLANs', () => {
      switch1.createVLAN(10, 'Engineering');

      expect(switch1.getVLAN(10)).not.toBeNull();
      expect(router1.getVLAN(10)).toBeNull();
    });
  });

  describe('Device Type', () => {
    it('should identify device type', () => {
      expect(router1.getCiscoType()).toBe('router');
      expect(switch1.getCiscoType()).toBe('switch');
    });
  });

  describe('Interfaces', () => {
    it('router should have GigabitEthernet and Serial interfaces', () => {
      const interfaces = router1.getCiscoInterfaces();

      const ge = interfaces.find(i => i.name.startsWith('GigabitEthernet'));
      expect(ge).not.toBeUndefined();

      const serial = interfaces.find(i => i.name.startsWith('Serial'));
      expect(serial).not.toBeUndefined();
    });

    it('switch should have FastEthernet and GigabitEthernet interfaces', () => {
      const interfaces = switch1.getCiscoInterfaces();

      const fe = interfaces.find(i => i.name.startsWith('FastEthernet'));
      expect(fe).not.toBeUndefined();

      const ge = interfaces.find(i => i.name.startsWith('GigabitEthernet'));
      expect(ge).not.toBeUndefined();
    });

    it('should configure interfaces', () => {
      router1.setCiscoInterfaceConfig('GigabitEthernet0/0', {
        ipAddress: '192.168.1.1',
        netmask: '255.255.255.0',
        status: 'up',
        protocol: 'up'
      });

      const iface = router1.getCiscoInterface('GigabitEthernet0/0');
      expect(iface?.ipAddress).toBe('192.168.1.1');
      expect(iface?.status).toBe('up');
    });
  });

  describe('VLAN Management', () => {
    it('should have default VLAN 1', () => {
      const vlan1 = switch1.getVLAN(1);
      expect(vlan1).not.toBeNull();
      expect(vlan1?.name).toBe('default');
    });

    it('should create VLANs', () => {
      const result = switch1.createVLAN(100, 'Management');
      expect(result).toBe(true);
      expect(switch1.getVLAN(100)?.name).toBe('Management');
    });

    it('should not delete VLAN 1', () => {
      const result = switch1.deleteVLAN(1);
      expect(result).toBe(false);
    });

    it('should delete user-created VLANs', () => {
      switch1.createVLAN(50, 'Test');
      expect(switch1.deleteVLAN(50)).toBe(true);
      expect(switch1.getVLAN(50)).toBeNull();
    });
  });

  describe('Routing', () => {
    it('should add static routes', () => {
      router1.addRoute({
        destination: '10.0.0.0',
        netmask: '255.0.0.0',
        gateway: '192.168.1.254',
        interface: 'GigabitEthernet0/0',
        metric: 1,
        flags: [],
        protocol: 'static'
      });

      const routes = router1.getCiscoRoutes();
      const staticRoute = routes.find(r => r.network === '10.0.0.0');
      expect(staticRoute).not.toBeUndefined();
      expect(staticRoute?.protocol).toBe('S');
    });

    it('should add connected routes when interface is configured', () => {
      router1.configureInterface('GigabitEthernet0/0', {
        ipAddress: '192.168.1.1',
        netmask: '255.255.255.0',
        isUp: true
      });

      const routes = router1.getCiscoRoutes();
      const connectedRoute = routes.find(r => r.network === '192.168.1.0' && r.protocol === 'C');
      expect(connectedRoute).not.toBeUndefined();
    });
  });

  describe('Terminal State', () => {
    it('should track CLI mode', () => {
      expect(router1.getTerminalState().mode).toBe('user');

      router1.setTerminalMode('privileged');
      expect(router1.getTerminalState().mode).toBe('privileged');

      router1.setTerminalMode('global-config');
      expect(router1.getTerminalState().mode).toBe('global-config');
    });

    it('should set enable password/secret', () => {
      router1.setEnableSecret('cisco123');
      expect(router1.getTerminalState().enableSecret).toBe('cisco123');
    });
  });

  describe('Configuration', () => {
    it('should generate running config', () => {
      router1.setHostname('MainRouter');
      router1.setCiscoInterfaceConfig('GigabitEthernet0/0', {
        description: 'LAN Interface',
        ipAddress: '192.168.1.1',
        netmask: '255.255.255.0',
        status: 'up'
      });

      const config = router1.getRunningConfig();
      expect(config.some(line => line.includes('hostname MainRouter'))).toBe(true);
      expect(config.some(line => line.includes('interface GigabitEthernet0/0'))).toBe(true);
    });

    it('should save configuration', () => {
      router1.setHostname('TestRouter');
      router1.saveConfig();

      const startupConfig = router1.getStartupConfig();
      expect(startupConfig.some(line => line.includes('hostname TestRouter'))).toBe(true);
    });
  });

  describe('MAC Table (Switch)', () => {
    it('should add MAC entries', () => {
      switch1.addMACEntry({
        vlan: 1,
        macAddress: 'AABB.CCDD.EEFF',
        type: 'dynamic',
        interface: 'FastEthernet0/1',
        age: 0
      });

      const macTable = switch1.getMACTable();
      expect(macTable.length).toBe(1);
      expect(macTable[0].macAddress).toBe('AABB.CCDD.EEFF');
    });

    it('should clear MAC table', () => {
      switch1.addMACEntry({
        vlan: 1,
        macAddress: 'AABB.CCDD.EEFF',
        type: 'dynamic',
        interface: 'FastEthernet0/1',
        age: 0
      });

      switch1.clearMACTable();
      expect(switch1.getMACTable().length).toBe(0);
    });
  });

  describe('File System (Flash/NVRAM)', () => {
    it('should have flash: filesystem', () => {
      expect(router1.isDirectory('flash:')).toBe(true);
    });

    it('should have nvram: filesystem', () => {
      expect(router1.isDirectory('nvram:')).toBe(true);
    });

    it('should create files in flash', () => {
      router1.createFile('flash:test.txt', 'test content');
      expect(router1.readFile('flash:test.txt')).toBe('test content');
    });
  });
});

// ============================================================================
// CROSS-DEVICE ISOLATION TESTS
// ============================================================================

describe('Cross-Device Isolation', () => {
  it('should maintain complete isolation between different device types', () => {
    const linux = createLinuxDeviceState({ deviceId: 'linux', hostname: 'linux-host' });
    const windows = createWindowsDeviceState({ deviceId: 'windows', hostname: 'WINDOWS-HOST' });
    const cisco = createCiscoDeviceState({ deviceId: 'cisco', hostname: 'cisco-host', ciscoType: 'router' });

    // Each device has its own filesystem
    linux.createFile('/tmp/linux.txt', 'linux');
    windows.createFile('C:\\Temp\\windows.txt', 'windows');
    cisco.createFile('flash:cisco.txt', 'cisco');

    // Files are isolated
    expect(linux.readFile('/tmp/linux.txt')).toBe('linux');
    expect(windows.readFile('C:\\Temp\\windows.txt')).toBe('windows');
    expect(cisco.readFile('flash:cisco.txt')).toBe('cisco');

    // Cross-device checks
    expect(linux.exists('C:\\Temp\\windows.txt')).toBe(false);
    expect(windows.exists('/tmp/linux.txt')).toBe(false);
  });

  it('should allow multiple instances of same device type with isolation', () => {
    const devices: LinuxDeviceState[] = [];

    for (let i = 0; i < 5; i++) {
      devices.push(createLinuxDeviceState({
        deviceId: `linux-${i}`,
        hostname: `host${i}`
      }));
    }

    // Create unique file on each device
    devices.forEach((device, i) => {
      device.createFile(`/tmp/device-${i}.txt`, `Content from device ${i}`);
    });

    // Verify isolation
    devices.forEach((device, i) => {
      // Should have own file
      expect(device.readFile(`/tmp/device-${i}.txt`)).toBe(`Content from device ${i}`);

      // Should not have other devices' files
      devices.forEach((other, j) => {
        if (i !== j) {
          expect(device.exists(`/tmp/device-${j}.txt`)).toBe(false);
        }
      });
    });
  });
});
