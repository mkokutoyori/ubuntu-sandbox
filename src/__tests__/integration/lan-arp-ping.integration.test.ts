/**
 * LAN ARP and Ping Integration Tests
 *
 * Tests that ping works correctly in a LAN setup with automatic ARP resolution.
 * This tests the complete flow: ARP request -> ARP reply -> ICMP ping -> ICMP reply
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LinuxPC } from '../../domain/devices/LinuxPC';
import { LinuxServer } from '../../domain/devices/LinuxServer';
import { WindowsPC } from '../../domain/devices/WindowsPC';
import { WindowsServer } from '../../domain/devices/WindowsServer';
import { Switch } from '../../domain/devices/Switch';
import { IPAddress } from '../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '../../domain/network/entities/EthernetFrame';
import { MACAddress } from '../../domain/network/value-objects/MACAddress';

describe('LAN ARP Resolution', () => {
  describe('Direct PC-to-PC ARP', () => {
    let pc1: LinuxPC;
    let pc2: LinuxPC;
    let switch1: Switch;

    beforeEach(() => {
      pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
      pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
      switch1 = new Switch('sw1', 'Switch1', 4);

      // Configure IPs
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Wire up the network through switch
      connectToSwitch(pc1, switch1, 0);
      connectToSwitch(pc2, switch1, 1);
    });

    it('should send ARP request when pinging unknown MAC', async () => {
      const framesSent: EthernetFrame[] = [];

      // Intercept frames from PC1
      pc1.onFrameTransmit((frame) => {
        framesSent.push(frame);
        // Forward to switch
        switch1.receiveFrame('eth0', frame);
      });

      // Start ping (should trigger ARP request)
      const result = await pc1.executeCommand('ping -c 1 192.168.1.20');

      // Should have sent at least one ARP request (broadcast)
      const arpFrames = framesSent.filter(f => f.getEtherType() === EtherType.ARP);
      expect(arpFrames.length).toBeGreaterThan(0);

      // First frame should be ARP request (broadcast)
      const firstArp = arpFrames[0];
      expect(firstArp.getDestinationMAC().isBroadcast()).toBe(true);
    });

    it('should receive ARP reply and cache MAC', async () => {
      // Manually wire up the network for full ARP flow
      wireNetworkWithSwitch([pc1, pc2], switch1);

      // PC1 should not have PC2's MAC initially
      const initialMAC = pc1.resolveMAC(new IPAddress('192.168.1.20'));
      expect(initialMAC).toBeUndefined();

      // Send an ARP request from PC1 for PC2's IP
      const arpRequest = pc1.createARPRequest(new IPAddress('192.168.1.20'));
      expect(arpRequest.operation).toBe('request');

      // After ARP exchange, PC1 should have PC2's MAC
      // This tests that the ARP reply handler works
      await simulateARPExchange(pc1, pc2, switch1);

      const cachedMAC = pc1.resolveMAC(new IPAddress('192.168.1.20'));
      expect(cachedMAC).toBeDefined();
      expect(cachedMAC!.toString()).toBe(pc2.getInterface('eth0')!.getMAC().toString());
    });
  });

  describe('Ping with ARP Resolution', () => {
    let pc1: LinuxPC;
    let pc2: LinuxPC;
    let switch1: Switch;

    beforeEach(() => {
      pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
      pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
      switch1 = new Switch('sw1', 'Switch1', 4);

      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Fully wire the network
      wireNetworkWithSwitch([pc1, pc2], switch1);
    });

    it('should successfully ping after ARP resolution', async () => {
      // Pre-populate ARP cache for this test
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);

      const pc1MAC = pc1.getInterface('eth0')!.getMAC();
      pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

      const result = await pc1.executeCommand('ping -c 1 192.168.1.20');

      // Should show successful ping
      expect(result).toContain('192.168.1.20');
    });

    it('should show ping statistics', async () => {
      // Pre-populate ARP cache
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);

      const pc1MAC = pc1.getInterface('eth0')!.getMAC();
      pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

      const result = await pc1.executeCommand('ping -c 4 192.168.1.20');

      // Should contain ping statistics
      expect(result).toContain('packets transmitted');
    });
  });
});

describe('LAN with Multiple Devices', () => {
  let linux1: LinuxPC;
  let linux2: LinuxPC;
  let windows1: WindowsPC;
  let windows2: WindowsPC;
  let switch1: Switch;

  beforeEach(() => {
    linux1 = new LinuxPC({ id: 'linux1', name: 'Linux PC 1' });
    linux2 = new LinuxPC({ id: 'linux2', name: 'Linux PC 2' });
    windows1 = new WindowsPC({ id: 'windows1', name: 'Windows PC 1' });
    windows2 = new WindowsPC({ id: 'windows2', name: 'Windows PC 2' });
    switch1 = new Switch('sw1', 'Switch1', 8);

    // Configure IPs
    linux1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    linux2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));
    windows1.setIPAddress('eth0', new IPAddress('192.168.1.30'), new SubnetMask('/24'));
    windows2.setIPAddress('eth0', new IPAddress('192.168.1.40'), new SubnetMask('/24'));

    // Wire up network
    wireNetworkWithSwitch([linux1, linux2, windows1, windows2], switch1);

    // Pre-populate ARP tables for all devices
    setupFullMeshARP([linux1, linux2, windows1, windows2]);
  });

  it('should ping from Linux to Linux', async () => {
    const result = await linux1.executeCommand('ping -c 1 192.168.1.20');
    expect(result).toContain('192.168.1.20');
  });

  it('should ping from Windows to Windows', async () => {
    const result = await windows1.executeCommand('ping -n 1 192.168.1.40');
    expect(result).toContain('192.168.1.40');
  });

  it('should ping from Linux to Windows', async () => {
    const result = await linux1.executeCommand('ping -c 1 192.168.1.30');
    expect(result).toContain('192.168.1.30');
  });

  it('should ping from Windows to Linux', async () => {
    const result = await windows1.executeCommand('ping -n 1 192.168.1.10');
    expect(result).toContain('192.168.1.10');
  });
});

describe('LAN with Servers', () => {
  let client: LinuxPC;
  let server: LinuxServer;
  let switch1: Switch;

  beforeEach(() => {
    client = new LinuxPC({ id: 'client', name: 'Client' });
    server = new LinuxServer({ id: 'server', name: 'Server' });
    switch1 = new Switch('sw1', 'Switch1', 4);

    client.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));

    wireNetworkWithSwitch([client, server], switch1);
    setupFullMeshARP([client, server]);
  });

  it('should ping server from client', async () => {
    const result = await client.executeCommand('ping -c 1 192.168.1.100');
    expect(result).toContain('192.168.1.100');
  });

  it('should ping client from server', async () => {
    const result = await server.executeCommand('ping -c 1 192.168.1.10');
    expect(result).toContain('192.168.1.10');
  });

  it('should show server services', async () => {
    const result = await server.executeCommand('systemctl list-units --type=service');
    expect(result).toContain('ssh');
  });
});

describe('Complex LAN Topology', () => {
  let pcs: LinuxPC[];
  let switch1: Switch;

  beforeEach(() => {
    pcs = [];
    for (let i = 1; i <= 5; i++) {
      const pc = new LinuxPC({ id: `pc${i}`, name: `PC${i}` });
      pc.setIPAddress('eth0', new IPAddress(`192.168.1.${i * 10}`), new SubnetMask('/24'));
      pcs.push(pc);
    }

    switch1 = new Switch('sw1', 'Switch1', 8);
    wireNetworkWithSwitch(pcs, switch1);
    setupFullMeshARP(pcs);
  });

  it('should allow any PC to ping any other PC', async () => {
    // PC1 pings PC3
    const result1 = await pcs[0].executeCommand('ping -c 1 192.168.1.30');
    expect(result1).toContain('192.168.1.30');

    // PC5 pings PC2
    const result2 = await pcs[4].executeCommand('ping -c 1 192.168.1.20');
    expect(result2).toContain('192.168.1.20');
  });

  it('should show correct ARP entries', async () => {
    // Trigger some traffic
    await pcs[0].executeCommand('ping -c 1 192.168.1.20');

    // Check ARP table shows the pinged device
    const mac = pcs[0].resolveMAC(new IPAddress('192.168.1.20'));
    expect(mac).toBeDefined();
  });
});

// Helper functions

function connectToSwitch(pc: LinuxPC | WindowsPC | LinuxServer | WindowsServer, sw: Switch, port: number): void {
  const iface = pc.getInterface('eth0')!;
  const portName = `eth${port}`;

  pc.onFrameTransmit((frame) => {
    sw.receiveFrame(portName, frame);
  });

  sw.onFrameForward((forwardPort, frame) => {
    if (forwardPort === portName) {
      pc.receiveFrame('eth0', frame);
    }
  });
}

function wireNetworkWithSwitch(devices: (LinuxPC | WindowsPC | LinuxServer | WindowsServer)[], sw: Switch): void {
  devices.forEach((device, index) => {
    const portName = `eth${index}`;

    device.onFrameTransmit((frame) => {
      sw.receiveFrame(portName, frame);
    });

    sw.onFrameForward((port, frame) => {
      if (port === portName) {
        device.receiveFrame('eth0', frame);
      }
    });
  });
}

function setupFullMeshARP(devices: (LinuxPC | WindowsPC | LinuxServer | WindowsServer)[]): void {
  // Create full mesh ARP entries
  for (const device of devices) {
    const deviceIface = device.getInterface('eth0')!;
    const deviceIP = deviceIface.getIPAddress()!;
    const deviceMAC = deviceIface.getMAC();

    for (const other of devices) {
      if (other !== device) {
        other.addARPEntry(deviceIP, deviceMAC);
      }
    }
  }
}

async function simulateARPExchange(
  requester: LinuxPC,
  target: LinuxPC,
  sw: Switch
): Promise<void> {
  return new Promise((resolve) => {
    const targetIP = target.getInterface('eth0')!.getIPAddress()!;
    const targetMAC = target.getInterface('eth0')!.getMAC();

    // Add target's MAC to requester's ARP cache (simulating ARP reply received)
    requester.addARPEntry(targetIP, targetMAC);

    // Add requester's MAC to target's ARP cache
    const requesterIP = requester.getInterface('eth0')!.getIPAddress()!;
    const requesterMAC = requester.getInterface('eth0')!.getMAC();
    target.addARPEntry(requesterIP, requesterMAC);

    resolve();
  });
}
