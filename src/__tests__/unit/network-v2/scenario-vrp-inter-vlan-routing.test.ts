/**
 * Scénario 4 — Routage inter-VLAN sur routeur Huawei AR-series
 * (purement Huawei).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab { sw1: HuaweiSwitch; ar1: HuaweiRouter; pc10: LinuxPC; pc20: LinuxPC }

function buildLab(): Lab {
  const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 10);
  const ar1 = new HuaweiRouter('AR1');
  const pc10 = new LinuxPC('linux-pc', 'PC-Linux-1', 0, 0);
  const pc20 = new LinuxPC('linux-pc', 'PC-Linux-2', 0, 0);

  new Cable('c1').connect(pc10.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/1')!);
  new Cable('c2').connect(pc20.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/2')!);
  new Cable('c3').connect(sw1.getPort('GigabitEthernet0/0/3')!, ar1.getPort('GE0/0/0')!);

  return { sw1, ar1, pc10, pc20 };
}

async function configureSwitch(sw1: HuaweiSwitch): Promise<void> {
  await sw1.executeCommand('system-view');
  await sw1.executeCommand('vlan batch 10 20');
  await sw1.executeCommand('interface GigabitEthernet 0/0/1');
  await sw1.executeCommand('port link-type access');
  await sw1.executeCommand('port default vlan 10');
  await sw1.executeCommand('quit');
  await sw1.executeCommand('interface GigabitEthernet 0/0/2');
  await sw1.executeCommand('port link-type access');
  await sw1.executeCommand('port default vlan 20');
  await sw1.executeCommand('quit');
  await sw1.executeCommand('interface GigabitEthernet 0/0/3');
  await sw1.executeCommand('port link-type trunk');
  await sw1.executeCommand('port trunk allow-pass vlan 10 20');
  await sw1.executeCommand('quit');
  await sw1.executeCommand('return');
}

async function configureRouterSubinterfaces(ar1: HuaweiRouter, arpBroadcast: boolean): Promise<void> {
  await ar1.executeCommand('system-view');
  await ar1.executeCommand('interface GigabitEthernet 0/0/0');
  await ar1.executeCommand('undo shutdown');
  await ar1.executeCommand('quit');

  await ar1.executeCommand('interface GigabitEthernet 0/0/0.10');
  await ar1.executeCommand('dot1q termination vid 10');
  await ar1.executeCommand('ip address 192.168.10.254 24');
  if (arpBroadcast) await ar1.executeCommand('arp broadcast enable');
  await ar1.executeCommand('quit');

  await ar1.executeCommand('interface GigabitEthernet 0/0/0.20');
  await ar1.executeCommand('dot1q termination vid 20');
  await ar1.executeCommand('ip address 192.168.20.254 24');
  if (arpBroadcast) await ar1.executeCommand('arp broadcast enable');
  await ar1.executeCommand('quit');
  await ar1.executeCommand('return');
}

async function configurePcs(pc10: LinuxPC, pc20: LinuxPC): Promise<void> {
  await pc10.executeCommand('ifconfig eth0 192.168.10.101 netmask 255.255.255.0');
  await pc10.executeCommand('ip route add default via 192.168.10.254');
  await pc20.executeCommand('ifconfig eth0 192.168.20.101 netmask 255.255.255.0');
  await pc20.executeCommand('ip route add default via 192.168.20.254');
}

describe('Scénario 4 — Routage inter-VLAN sur routeur Huawei AR-series', () => {
  describe('configuration des sous-interfaces dot1q', () => {
    it('display ip routing-table affiche une route directe pour chaque sous-réseau VLAN', async () => {
      const { sw1, ar1 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, true);

      const routes = await ar1.executeCommand('display ip routing-table');
      expect(routes).toMatch(/192\.168\.10\.0\/24/);
      expect(routes).toMatch(/192\.168\.20\.0\/24/);
      expect(routes).toMatch(/Direct/);
    });
  });

  describe('routage inter-VLAN — connectivité réelle', () => {
    it('sans arp broadcast enable, le sous-interface ne répond pas aux ARP (pas de connectivité)', async () => {
      const { sw1, ar1, pc10 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, false);
      await pc10.executeCommand('ifconfig eth0 192.168.10.101 netmask 255.255.255.0');
      await pc10.executeCommand('ip route add default via 192.168.10.254');

      const ping = await pc10.executeCommand('ping -c 1 -W 1 192.168.10.254');
      expect(ping).toMatch(/100% packet loss/);
    });

    it('avec arp broadcast enable, ping fonctionne entre le PC et la passerelle', async () => {
      const { sw1, ar1, pc10, pc20 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, true);
      await configurePcs(pc10, pc20);

      const ping = await pc10.executeCommand('ping -c 2 192.168.10.254');
      expect(ping).toContain('2 packets transmitted, 2 received');
    });

    it('ping inter-VLAN complet : PC-Linux-1 (VLAN 10) vers PC-Linux-2 (VLAN 20) à travers AR1', async () => {
      const { sw1, ar1, pc10, pc20 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, true);
      await configurePcs(pc10, pc20);

      const ping = await pc10.executeCommand('ping -c 4 192.168.20.101');
      expect(ping).toContain('4 packets transmitted, 4 received');

      const routeGet = await pc10.executeCommand('ip route get 192.168.20.101');
      expect(routeGet).toMatch(/via 192\.168\.10\.254/);

      const traceroute = await pc10.executeCommand('traceroute -n 192.168.20.101');
      const lines = traceroute.split('\n').filter((l) => l.trim());
      const hop1 = lines.find((l) => /^\s*1\s/.test(l));
      const hop2 = lines.find((l) => /^\s*2\s/.test(l));
      expect(hop1).toContain('192.168.10.254');
      expect(hop2).toContain('192.168.20.101');
      expect(new Set(lines.map((l) => l.trim().split(/\s+/)[0])).size).toBe(2);
    });

    it('AR1 voit les deux machines dans sa table ARP après le trafic', async () => {
      const { sw1, ar1, pc10, pc20 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, true);
      await configurePcs(pc10, pc20);

      await ar1.executeCommand('ping 192.168.10.101');
      await ar1.executeCommand('ping 192.168.20.101');

      const arp = await ar1.executeCommand('display arp');
      expect(arp).toContain('192.168.10.101');
      expect(arp).toContain('192.168.20.101');
    });
  });

  describe('VLANIF sur switch L3 Huawei (alternative)', () => {
    it('interface Vlanif + ip routing-enable routent entre VLANs sans routeur externe', async () => {
      const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 10);
      const pc10 = new LinuxPC('linux-pc', 'PC-Linux-1', 0, 0);
      const pc20 = new LinuxPC('linux-pc', 'PC-Linux-2', 0, 0);
      new Cable('c1').connect(pc10.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/1')!);
      new Cable('c2').connect(pc20.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/2')!);

      await sw1.executeCommand('system-view');
      await sw1.executeCommand('vlan batch 10 20');
      await sw1.executeCommand('interface GigabitEthernet 0/0/1');
      await sw1.executeCommand('port link-type access');
      await sw1.executeCommand('port default vlan 10');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('interface GigabitEthernet 0/0/2');
      await sw1.executeCommand('port link-type access');
      await sw1.executeCommand('port default vlan 20');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('interface Vlanif 10');
      await sw1.executeCommand('ip address 192.168.10.254 255.255.255.0');
      await sw1.executeCommand('description GATEWAY-VLAN10');
      await sw1.executeCommand('quit');
      await sw1.executeCommand('interface Vlanif 20');
      await sw1.executeCommand('ip address 192.168.20.254 255.255.255.0');
      await sw1.executeCommand('quit');
      const routingOut = await sw1.executeCommand('ip routing-enable');
      expect(routingOut).not.toMatch(/Unrecognized|Error/);
      await sw1.executeCommand('return');

      await pc10.executeCommand('ifconfig eth0 192.168.10.101 netmask 255.255.255.0');
      await pc10.executeCommand('ip route add default via 192.168.10.254');
      await pc20.executeCommand('ifconfig eth0 192.168.20.101 netmask 255.255.255.0');
      await pc20.executeCommand('ip route add default via 192.168.20.254');

      const ping = await pc10.executeCommand('ping -c 2 192.168.20.101');
      expect(ping).toContain('2 packets transmitted, 2 received');
    });
  });

  describe('critère de réussite', () => {
    it('routes directes présentes, arp broadcast enable obligatoire, un seul saut intermédiaire', async () => {
      const { sw1, ar1, pc10, pc20 } = buildLab();
      await configureSwitch(sw1);
      await configureRouterSubinterfaces(ar1, true);
      await configurePcs(pc10, pc20);

      const routes = await ar1.executeCommand('display ip routing-table');
      expect(routes).toMatch(/192\.168\.10\.0\/24/);
      expect(routes).toMatch(/192\.168\.20\.0\/24/);

      const traceroute = await pc10.executeCommand('traceroute -n 192.168.20.101');
      const lines = traceroute.split('\n').filter((l) => l.trim());
      const hopNumbers = new Set(lines.map((l) => l.trim().split(/\s+/)[0]));
      expect(hopNumbers.size).toBe(2);
    });
  });
});
