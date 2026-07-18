/**
 * Scénario 3 — Capture sur interface trunk 802.1Q et isolation du trafic
 * par VLAN. LinuxPC trunké sur eth0 (sous-interfaces eth0.10/20/99, eth0
 * natif VLAN1), relié à un switch Cisco dont les SVI Vlan1/10/20/99
 * génèrent le trafic de test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface TrunkLab { pc: LinuxPC; sw: CiscoSwitch }

async function buildTrunkLab(): Promise<TrunkLab> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  new Cable('trunk').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  await run(sw, [
    'enable', 'configure terminal',
    'vlan 10', 'exit', 'vlan 20', 'exit', 'vlan 99', 'exit',
    'interface FastEthernet0/1',
    'switchport trunk encapsulation dot1q',
    'switchport mode trunk',
    'switchport trunk native vlan 1',
    'switchport trunk allowed vlan 1,10,20,99',
    'exit',
    'interface Vlan1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan10', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan20', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan99', 'ip address 192.168.99.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]);

  await run(pc, [
    'ifconfig eth0 192.168.1.2 netmask 255.255.255.0',
    'ip link add link eth0 name eth0.10 type vlan id 10',
    'ip addr add 192.168.10.2/24 dev eth0.10',
    'ip link add link eth0 name eth0.20 type vlan id 20',
    'ip addr add 192.168.20.2/24 dev eth0.20',
    'ip link add link eth0 name eth0.99 type vlan id 99',
    'ip addr add 192.168.99.2/24 dev eth0.99',
  ]);

  return { pc, sw };
}

async function captureOn(pc: LinuxPC, cmd: string, stimulus: () => Promise<unknown>): Promise<string> {
  const pending = pc.executeCommand(cmd);
  await new Promise((r) => setTimeout(r, 20));
  await stimulus();
  await new Promise((r) => setTimeout(r, 30));
  return pending;
}

describe('Scénario 3 — Capture sur interface trunk 802.1Q et isolation du trafic par VLAN', () => {
  it('capture sur trunk avec filtrage par VLAN ID (vlan 10 and tcp) réussit sans erreur, avec écriture pcap', async () => {
    const { pc } = await buildTrunkLab();
    const output = await pc.executeCommand(
      `tcpdump -i eth0 -nn -e -vvv 'vlan 10 and tcp' -w /tmp/vlan10-traffic.pcap`,
    );
    expect(output).not.toMatch(/tcpdump: error/);
    expect(output).toContain('packets captured');
  });

  it('capture simultanée multi-VLAN identifie chaque trame par son VLAN ID (vlan 10, 20, 99)', async () => {
    const { pc } = await buildTrunkLab();
    const dump = await captureOn(pc, `tcpdump -nn -e 'vlan and (vlan 10 or vlan 20 or vlan 99)'`, async () => {
      await pc.executeCommand('ping -c 1 192.168.10.1');
      await pc.executeCommand('ping -c 1 192.168.20.1');
      await pc.executeCommand('ping -c 1 192.168.99.1');
    });

    expect(dump).toMatch(/vlan 10, p 0/);
    expect(dump).toMatch(/vlan 20, p 0/);
    expect(dump).toMatch(/vlan 99, p 0/);
  });

  describe('décodage des trames 802.1Q', () => {
    it('la sortie -e expose ethertype 802.1Q (0x8100), le VLAN ID et la priorité CoS', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -c 2 -nn -e icmp`, () => pc.executeCommand('ping -c 1 192.168.10.1'));

      expect(dump).toMatch(/ethertype 802\.1Q \(0x8100\)/);
      expect(dump).toMatch(/vlan 10, p 0, ethertype IPv4 \(0x0800\)/);
    });

    it('la taille de trame diffère exactement de 4 octets entre la vue trunk (tagguée) et la vue sous-interface (sans tag) d\'un même type de segment TCP', async () => {
      const { pc } = await buildTrunkLab();
      const lengthOf = (l: string) => Number(/length (\d+):/.exec(l)?.[1]);

      // Deux captures séquentielles plutôt que `-i any` simultané : la
      // dédup de segments TCP fusionne les deux vues d'un même segment.
      const trunkDump = await captureOn(pc, `tcpdump -c 1 -nn -e tcp and port 9000`, () => {
        pc.getTcpStack().connect('192.168.10.1', 9000);
        return Promise.resolve();
      });
      const taggedLine = trunkDump.split('\n').find((l) => l.includes('Flags [') && l.includes('vlan 10'));
      expect(taggedLine).toBeDefined();

      const subDump = await captureOn(pc, `tcpdump -c 1 -nn -e -i eth0.10 tcp and port 9000`, () => {
        pc.getTcpStack().connect('192.168.10.1', 9000);
        return Promise.resolve();
      });
      const untaggedLine = subDump.split('\n').find((l) => l.includes('Flags ['));
      expect(untaggedLine).toBeDefined();
      expect(untaggedLine).not.toContain('vlan');

      expect(lengthOf(taggedLine!)).toBe(lengthOf(untaggedLine!) + 4);
    });
  });

  describe('isolation par VLAN et étanchéité', () => {
    it('capture sur eth0.10 ne montre que le trafic VLAN 10, sans tag et sans filtre BPF supplémentaire', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -nn -i eth0.10`, async () => {
        await pc.executeCommand('ping -c 1 192.168.10.1');
      });

      expect(dump).toContain('192.168.10');
      expect(dump).not.toContain('vlan');
    });

    it('aucune trame VLAN 20 ne fuit vers une capture sur eth0.10, même quand du trafic VLAN 20 est généré en parallèle', async () => {
      const { pc } = await buildTrunkLab();
      const pending = pc.executeCommand('tcpdump -nn -i eth0.10');
      await new Promise((r) => setTimeout(r, 20));
      await pc.executeCommand('ping -c 1 192.168.20.1');
      await pc.executeCommand('ping -c 1 192.168.10.1');
      await new Promise((r) => setTimeout(r, 30));
      const dump = await pending;

      expect(dump).not.toContain('192.168.20');
      expect(dump).toContain('192.168.10');
    });
  });

  describe('capture de trafic natif (non tagué) sur trunk', () => {
    it('le trafic du VLAN natif est capturé sur eth0 sans tag 802.1Q, ethertype IPv4 direct', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -c 2 -nn -e icmp and host 192.168.1.1`, () => pc.executeCommand('ping -c 1 192.168.1.1'));

      expect(dump).toMatch(/ethertype IPv4 \(0x0800\)/);
      expect(dump).not.toContain('802.1Q');
      expect(dump).not.toContain('vlan');
    });

    it('le filtre "not vlan" isole le trafic natif du trafic taggué dans une même capture trunk', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -nn -e 'not vlan'`, async () => {
        await pc.executeCommand('ping -c 1 192.168.10.1'); // taggué VLAN 10 — doit être exclu
        await pc.executeCommand('ping -c 1 192.168.1.1');  // natif — doit apparaître
      });

      expect(dump).not.toContain('192.168.10.1');
      expect(dump).toContain('192.168.1.1');
      expect(dump).not.toContain('vlan');
    });
  });

  describe('trafic inter-VLAN routé visible sur le trunk', () => {
    it('une passerelle Linux (ip_forward=1) sur le même trunk fait apparaître deux trames consécutives taguées différemment (VLAN 10 puis VLAN 20) pour un même échange routé', async () => {
      const gw = new LinuxServer('linux-server', 'GW', 0, 0);
      const h10 = new LinuxPC('linux-pc', 'H10', -100, 0);
      const h20 = new LinuxPC('linux-pc', 'H20', -100, 100);
      const sw = new CiscoSwitch('switch-cisco', 'SW2', 8, 100, 0);

      new Cable('trunk2').connect(gw.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);

      await run(sw, [
        'enable', 'configure terminal',
        'vlan 10', 'exit', 'vlan 20', 'exit',
        'interface FastEthernet0/1', 'switchport trunk encapsulation dot1q',
        'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit',
        'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'exit',
        'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 20', 'exit',
        'end',
      ]);
      await run(gw, [
        'ip link add link eth0 name eth0.10 type vlan id 10',
        'ip addr add 192.168.10.1/24 dev eth0.10',
        'ip link add link eth0 name eth0.20 type vlan id 20',
        'ip addr add 192.168.20.1/24 dev eth0.20',
        'sysctl -w net.ipv4.ip_forward=1',
      ]);
      await run(h10, ['ip addr add 192.168.10.10/24 dev eth0', 'ip route add default via 192.168.10.1']);
      await run(h20, ['ip addr add 192.168.20.10/24 dev eth0', 'ip route add default via 192.168.20.1']);

      const gwMac = (await gw.executeCommand('ip link show eth0')).match(/link\/ether ([0-9a-f:]+)/)?.[1];
      expect(gwMac).toBeDefined();

      const pending = gw.executeCommand('tcpdump -nn -e -c 4 icmp');
      await new Promise((r) => setTimeout(r, 20));
      const ping = h10.executeCommand('ping -c 1 192.168.20.10');
      await new Promise((r) => setTimeout(r, 40));
      const dump = await pending;
      expect(await ping).toContain('1 packets transmitted');

      const lines = dump.split('\n').filter((l) => l.includes('>') && l.includes('ethertype'));
      const vlan10Frame = lines.find((l) => l.includes('vlan 10'));
      const vlan20Frame = lines.find((l) => l.includes('vlan 20'));
      expect(vlan10Frame).toBeDefined();
      expect(vlan20Frame).toBeDefined();

      expect(vlan10Frame).toContain(`> ${gwMac}`);
      expect(vlan20Frame).toMatch(new RegExp(`^\\S+ ${gwMac} >`));
    });
  });

  describe('critère de réussite', () => {
    it('le filtrage BPF vlan <id> isole exactement le trafic du VLAN spécifié — aucune trame d\'un autre VLAN ne passe', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -nn -e 'vlan 10'`, async () => {
        await pc.executeCommand('ping -c 1 192.168.20.1');
        await pc.executeCommand('ping -c 1 192.168.99.1');
        await pc.executeCommand('ping -c 1 192.168.10.1');
      });

      const taggedLines = dump.split('\n').filter((l) => l.includes('vlan '));
      expect(taggedLines.length).toBeGreaterThan(0);
      for (const line of taggedLines) expect(line).toContain('vlan 10,');
      expect(dump).not.toContain('192.168.20');
      expect(dump).not.toContain('192.168.99');
    });

    it('cohérence systématique de taille trunk (+4 octets) vs sous-interface (sans tag) — vérifiable pour un second échange indépendant', async () => {
      const { pc } = await buildTrunkLab();
      const dump = await captureOn(pc, `tcpdump -nn -e -i any icmp`, () => pc.executeCommand('ping -c 1 192.168.20.1'));

      const lines = dump.split('\n').filter((l) => !l.includes('ARP,') && l.includes('ethertype'));
      const tagged = lines.find((l) => l.includes('vlan 20'));
      const untagged = lines.find((l) => !l.includes('vlan') && l.includes('192.168.20'));
      expect(tagged).toBeDefined();
      expect(untagged).toBeDefined();
      const lengthOf = (l: string) => Number(/length (\d+):/.exec(l)?.[1]);
      expect(lengthOf(tagged!)).toBe(lengthOf(untagged!) + 4);
    });
  });
});
