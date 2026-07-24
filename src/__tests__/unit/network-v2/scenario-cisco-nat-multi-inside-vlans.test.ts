/**
 * Scénario 9 (Cisco) — NAT avec plusieurs interfaces internes
 * (multi-inside, un sous-interface 802.1Q par VLAN).
 *
 * Transcription littérale et fidèle : VLAN 10 (Admin), 20 (Production)
 * et 99 (Management) sur un tronc 802.1Q vers un switch Cisco, chaque
 * sous-interface GigabitEthernet0/0.X marquée `ip nat inside`, ACL
 * couvrant les trois sous-réseaux, PAT vers l'IP publique unique —
 * même patron de topologie que inter-vlan-routing.test.ts (routeur sur
 * un bâton).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';

interface Lab {
  h10: LinuxPC;
  h20: LinuxPC;
  h99: LinuxPC;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const router = new CiscoRouter('router', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 100, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);
  const h10 = new LinuxPC('linux-pc', 'h10', -100, 0);
  const h20 = new LinuxPC('linux-pc', 'h20', -100, 100);
  const h99 = new LinuxPC('linux-pc', 'h99', -100, 200);

  new Cable('up').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('FastEthernet0/4')!);
  new Cable('c').connect(h99.getPort('eth0')!, sw.getPort('FastEthernet0/5')!);
  new Cable('wan').connect(router.getPort('GigabitEthernet0/1')!, outside.getPort('eth0')!);

  await run(outside, [`ip addr add ${OUTSIDE_IP}/30 dev eth0`, `ip route add default via ${GW_OUTSIDE}`]);

  await run(sw, ['enable', 'configure terminal',
    'vlan 10', 'exit', 'vlan 20', 'exit', 'vlan 99', 'exit',
    'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface FastEthernet0/4', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface FastEthernet0/5', 'switchport mode access', 'switchport access vlan 99', 'exit',
    'interface FastEthernet0/2', 'switchport trunk encapsulation dot1q', 'switchport mode trunk',
    'switchport trunk allowed vlan 10,20,99', 'exit', 'end']);

  await run(router, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'no ip address', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.254 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.254 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0.99', 'encapsulation dot1Q 99', 'ip address 192.168.99.254 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${GW_OUTSIDE} 255.255.255.252`, 'ip nat outside', 'no shutdown', 'exit',
    'ip access-list standard ACL-TOUS-VLANS',
    '10 permit 192.168.10.0 0.0.0.255',
    '20 permit 192.168.20.0 0.0.0.255',
    '30 permit 192.168.99.0 0.0.0.255',
    'exit',
    'ip nat inside source list ACL-TOUS-VLANS interface GigabitEthernet0/1 overload',
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1',
    'end']);

  await run(h10, ['ip link set eth0 up', 'ip addr add 192.168.10.101/24 dev eth0', 'ip route add default via 192.168.10.254']);
  await run(h20, ['ip link set eth0 up', 'ip addr add 192.168.20.101/24 dev eth0', 'ip route add default via 192.168.20.254']);
  await run(h99, ['ip link set eth0 up', 'ip addr add 192.168.99.10/24 dev eth0', 'ip route add default via 192.168.99.254']);

  return { h10, h20, h99, router };
}

describe('Scénario 9 (Cisco) — NAT multi-inside (un sous-interface 802.1Q par VLAN)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('configuration NAT multi-inside', () => {
    it('les trois sous-interfaces .10/.20/.99 sont enregistrées comme inside dans le moteur NAT', async () => {
      const { router } = await buildLab();
      const inside = router._getNATEngine().getInsideInterfaces();
      expect(inside.has('GigabitEthernet0/0.10')).toBe(true);
      expect(inside.has('GigabitEthernet0/0.20')).toBe(true);
      expect(inside.has('GigabitEthernet0/0.99')).toBe(true);
    });

    it('show ip nat statistics | include Inside liste les trois sous-interfaces', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics | include Inside');
      expect(out).toContain('GigabitEthernet0/0.10');
      expect(out).toContain('GigabitEthernet0/0.20');
      expect(out).toContain('GigabitEthernet0/0.99');
    });
  });

  describe('test depuis chaque VLAN', () => {
    it('le trafic des trois VLANs est traduit vers la même IP publique 203.0.113.1', async () => {
      const { h10, h20, h99, router } = await buildLab();
      await h10.executeCommand(`ping -c 2 ${OUTSIDE_IP}`);
      await h20.executeCommand(`ping -c 2 ${OUTSIDE_IP}`);
      await h99.executeCommand(`ping -c 2 ${OUTSIDE_IP}`);

      const table = await router.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.10.101');
      expect(table).toContain('192.168.20.101');
      expect(table).toContain('192.168.99.10');
      const rx = /^icmp\s+(\d+\.\d+\.\d+\.\d+):/gm;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(table)) !== null) expect(m[1]).toBe(GW_OUTSIDE);
    });

    it('show ip nat translations verbose indique l\'interface d\'entrée correcte pour chaque VLAN', async () => {
      const { h10, h20, router } = await buildLab();
      await h10.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      await h20.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat translations verbose');
      expect(out).toMatch(/input iface:\s*GigabitEthernet0\/0\.10/);
      expect(out).toMatch(/input iface:\s*GigabitEthernet0\/0\.20/);
    });
  });
});
