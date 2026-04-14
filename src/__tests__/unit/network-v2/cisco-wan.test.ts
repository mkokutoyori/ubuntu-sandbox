/**
 * Tests unitaires pour un grand réseau WAN
 *
 * Topologie :
 * - 4 LANs (LAN1 à LAN4) chacun avec :
 *   - 1 routeur Cisco (R1..R4)
 *   - 1 switch Cisco
 *   - 3 machines (Linux ou Windows)
 * - Interconnexion des routeurs en anneau : R1-R2, R2-R3, R3-R4, R4-R1 (liens point-à-point /30)
 * - Adressage :
 *   - LAN1 : 192.168.1.0/24, passerelle R1: 192.168.1.254
 *   - LAN2 : 192.168.2.0/24, passerelle R2: 192.168.2.254
 *   - LAN3 : 192.168.3.0/24, passerelle R3: 192.168.3.254
 *   - LAN4 : 192.168.4.0/24, passerelle R4: 192.168.4.254
 *   - Liens routeurs :
 *     - R1-R2 : 10.0.12.0/30 (R1=.1, R2=.2)
 *     - R2-R3 : 10.0.23.0/30 (R2=.1, R3=.2)
 *     - R3-R4 : 10.0.34.0/30 (R3=.1, R4=.2)
 *     - R4-R1 : 10.0.41.0/30 (R4=.1, R1=.2)
 *
 * Les tests couvrent :
 * - Configuration IP statique (hôtes et routeurs)
 * - Serveur DHCP sur chaque routeur pour son LAN
 * - ARP (affichage, ajout/suppression statique, résolution)
 * - Ping (intra-LAN, inter-LAN, timeout, taille de paquet)
 * - Traceroute (découverte de chemin, hops)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress,
  SubnetMask,
  MACAddress,
  resetCounters,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ----------------------------------------------------------------------
// Helpers pour configurer la topologie
// ----------------------------------------------------------------------

function createTopology() {
  // Routeurs
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  const r4 = new CiscoRouter('R4');

  // Switches de LAN (26 ports: 24 FastEthernet + 2 GigabitEthernet uplinks)
  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 26);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 26);
  const sw3 = new CiscoSwitch('switch-cisco', 'SW3', 26);
  const sw4 = new CiscoSwitch('switch-cisco', 'SW4', 26);

  // Machines LAN1 : 2 Linux, 1 Windows
  const lan1_pc1 = new LinuxPC('linux-pc', 'LAN1-PC1', 0, 0);
  const lan1_pc2 = new LinuxPC('linux-pc', 'LAN1-PC2', 100, 0);
  const lan1_pc3 = new WindowsPC('windows-pc', 'LAN1-PC3', 200, 0);

  // LAN2 : 1 Linux, 2 Windows
  const lan2_pc1 = new LinuxPC('linux-pc', 'LAN2-PC1', 0, 100);
  const lan2_pc2 = new WindowsPC('windows-pc', 'LAN2-PC2', 100, 100);
  const lan2_pc3 = new WindowsPC('windows-pc', 'LAN2-PC3', 200, 100);

  // LAN3 : 3 Linux
  const lan3_pc1 = new LinuxPC('linux-pc', 'LAN3-PC1', 0, 200);
  const lan3_pc2 = new LinuxPC('linux-pc', 'LAN3-PC2', 100, 200);
  const lan3_pc3 = new LinuxPC('linux-pc', 'LAN3-PC3', 200, 200);

  // LAN4 : 2 Linux, 1 Windows
  const lan4_pc1 = new LinuxPC('linux-pc', 'LAN4-PC1', 0, 300);
  const lan4_pc2 = new WindowsPC('windows-pc', 'LAN4-PC2', 100, 300);
  const lan4_pc3 = new LinuxPC('linux-pc', 'LAN4-PC3', 200, 300);

  // Câbles LAN : chaque PC vers son switch
  const cLan1_1 = new Cable('cLan1-1'); cLan1_1.connect(lan1_pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/1')!);
  const cLan1_2 = new Cable('cLan1-2'); cLan1_2.connect(lan1_pc2.getPort('eth0')!, sw1.getPort('FastEthernet0/2')!);
  const cLan1_3 = new Cable('cLan1-3'); cLan1_3.connect(lan1_pc3.getPort('eth0')!, sw1.getPort('FastEthernet0/3')!);
  const cLan1_router = new Cable('cLan1-router'); cLan1_router.connect(r1.getPort('GigabitEthernet0/0')!, sw1.getPort('GigabitEthernet0/0')!);

  const cLan2_1 = new Cable('cLan2-1'); cLan2_1.connect(lan2_pc1.getPort('eth0')!, sw2.getPort('FastEthernet0/1')!);
  const cLan2_2 = new Cable('cLan2-2'); cLan2_2.connect(lan2_pc2.getPort('eth0')!, sw2.getPort('FastEthernet0/2')!);
  const cLan2_3 = new Cable('cLan2-3'); cLan2_3.connect(lan2_pc3.getPort('eth0')!, sw2.getPort('FastEthernet0/3')!);
  const cLan2_router = new Cable('cLan2-router'); cLan2_router.connect(r2.getPort('GigabitEthernet0/0')!, sw2.getPort('GigabitEthernet0/0')!);

  const cLan3_1 = new Cable('cLan3-1'); cLan3_1.connect(lan3_pc1.getPort('eth0')!, sw3.getPort('FastEthernet0/1')!);
  const cLan3_2 = new Cable('cLan3-2'); cLan3_2.connect(lan3_pc2.getPort('eth0')!, sw3.getPort('FastEthernet0/2')!);
  const cLan3_3 = new Cable('cLan3-3'); cLan3_3.connect(lan3_pc3.getPort('eth0')!, sw3.getPort('FastEthernet0/3')!);
  const cLan3_router = new Cable('cLan3-router'); cLan3_router.connect(r3.getPort('GigabitEthernet0/0')!, sw3.getPort('GigabitEthernet0/0')!);

  const cLan4_1 = new Cable('cLan4-1'); cLan4_1.connect(lan4_pc1.getPort('eth0')!, sw4.getPort('FastEthernet0/1')!);
  const cLan4_2 = new Cable('cLan4-2'); cLan4_2.connect(lan4_pc2.getPort('eth0')!, sw4.getPort('FastEthernet0/2')!);
  const cLan4_3 = new Cable('cLan4-3'); cLan4_3.connect(lan4_pc3.getPort('eth0')!, sw4.getPort('FastEthernet0/3')!);
  const cLan4_router = new Cable('cLan4-router'); cLan4_router.connect(r4.getPort('GigabitEthernet0/0')!, sw4.getPort('GigabitEthernet0/0')!);

  // Câbles inter-routeurs
  const cR1R2 = new Cable('cR1R2'); cR1R2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  const cR2R3 = new Cable('cR2R3'); cR2R3.connect(r2.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/1')!);
  const cR3R4 = new Cable('cR3R4'); cR3R4.connect(r3.getPort('GigabitEthernet0/2')!, r4.getPort('GigabitEthernet0/1')!);
  const cR4R1 = new Cable('cR4R1'); cR4R1.connect(r4.getPort('GigabitEthernet0/2')!, r1.getPort('GigabitEthernet0/2')!);

  return {
    routers: { r1, r2, r3, r4 },
    switches: { sw1, sw2, sw3, sw4 },
    hosts: {
      lan1: [lan1_pc1, lan1_pc2, lan1_pc3],
      lan2: [lan2_pc1, lan2_pc2, lan2_pc3],
      lan3: [lan3_pc1, lan3_pc2, lan3_pc3],
      lan4: [lan4_pc1, lan4_pc2, lan4_pc3],
    },
  };
}

// Configuration IP statique sur les routeurs (interfaces LAN et WAN)
async function configureRoutersStatic(routers: any) {
  const { r1, r2, r3, r4 } = routers;

  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 192.168.1.254 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/2');
  await r1.executeCommand('ip address 10.0.41.2 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  // Routes statiques
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('ip route 192.168.3.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('ip route 192.168.4.0 255.255.255.0 10.0.41.1');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.254 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/2');
  await r2.executeCommand('ip address 10.0.23.1 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
  await r2.executeCommand('ip route 192.168.3.0 255.255.255.0 10.0.23.2');
  await r2.executeCommand('ip route 192.168.4.0 255.255.255.0 10.0.23.2');
  await r2.executeCommand('end');

  // R3
  await r3.executeCommand('enable');
  await r3.executeCommand('configure terminal');
  await r3.executeCommand('interface GigabitEthernet0/0');
  await r3.executeCommand('ip address 192.168.3.254 255.255.255.0');
  await r3.executeCommand('no shutdown');
  await r3.executeCommand('exit');
  await r3.executeCommand('interface GigabitEthernet0/1');
  await r3.executeCommand('ip address 10.0.23.2 255.255.255.252');
  await r3.executeCommand('no shutdown');
  await r3.executeCommand('exit');
  await r3.executeCommand('interface GigabitEthernet0/2');
  await r3.executeCommand('ip address 10.0.34.1 255.255.255.252');
  await r3.executeCommand('no shutdown');
  await r3.executeCommand('exit');
  await r3.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.23.1');
  await r3.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.23.1');
  await r3.executeCommand('ip route 192.168.4.0 255.255.255.0 10.0.34.2');
  await r3.executeCommand('end');

  // R4
  await r4.executeCommand('enable');
  await r4.executeCommand('configure terminal');
  await r4.executeCommand('interface GigabitEthernet0/0');
  await r4.executeCommand('ip address 192.168.4.254 255.255.255.0');
  await r4.executeCommand('no shutdown');
  await r4.executeCommand('exit');
  await r4.executeCommand('interface GigabitEthernet0/1');
  await r4.executeCommand('ip address 10.0.34.2 255.255.255.252');
  await r4.executeCommand('no shutdown');
  await r4.executeCommand('exit');
  await r4.executeCommand('interface GigabitEthernet0/2');
  await r4.executeCommand('ip address 10.0.41.1 255.255.255.252');
  await r4.executeCommand('no shutdown');
  await r4.executeCommand('exit');
  await r4.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.41.2');
  await r4.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.34.1');
  await r4.executeCommand('ip route 192.168.3.0 255.255.255.0 10.0.34.1');
  await r4.executeCommand('end');
}

// Configuration IP statique sur les hôtes (Linux/Windows)
// Chaque LAN a jusqu'à 3 hôtes ; les tableaux peuvent être partiels (scénarios combinés)
async function configureHostsStatic(hosts: any) {
  // Helper pour configurer un hôte Linux
  async function cfgLinux(pc: any, ip: string, gw: string) {
    if (!pc) return;
    await pc.executeCommand(`ifconfig eth0 ${ip} netmask 255.255.255.0 up`);
    await pc.executeCommand(`route add default gw ${gw}`);
  }
  // Helper pour configurer un hôte Windows
  async function cfgWindows(pc: any, ip: string, mask: string, gw: string) {
    if (!pc) return;
    await pc.executeCommand(`netsh interface ip set address name="eth0" static ${ip} ${mask} ${gw}`);
  }

  // LAN1 : 192.168.1.1-3, gateway 192.168.1.254
  const lan1 = hosts.lan1 || [];
  await cfgLinux(lan1[0], '192.168.1.1', '192.168.1.254');
  await cfgLinux(lan1[1], '192.168.1.2', '192.168.1.254');
  await cfgWindows(lan1[2], '192.168.1.3', '255.255.255.0', '192.168.1.254');

  // LAN2 : 192.168.2.1-3
  const lan2 = hosts.lan2 || [];
  await cfgLinux(lan2[0], '192.168.2.1', '192.168.2.254');
  await cfgWindows(lan2[1], '192.168.2.2', '255.255.255.0', '192.168.2.254');
  await cfgWindows(lan2[2], '192.168.2.3', '255.255.255.0', '192.168.2.254');

  // LAN3 : 192.168.3.1-3
  const lan3 = hosts.lan3 || [];
  await cfgLinux(lan3[0], '192.168.3.1', '192.168.3.254');
  await cfgLinux(lan3[1], '192.168.3.2', '192.168.3.254');
  await cfgLinux(lan3[2], '192.168.3.3', '192.168.3.254');

  // LAN4 : 192.168.4.1-3
  const lan4 = hosts.lan4 || [];
  await cfgLinux(lan4[0], '192.168.4.1', '192.168.4.254');
  await cfgWindows(lan4[1], '192.168.4.2', '255.255.255.0', '192.168.4.254');
  await cfgLinux(lan4[2], '192.168.4.3', '192.168.4.254');
}

// Configuration DHCP sur les routeurs (serveur pour chaque LAN)
async function configureDHCPServers(routers: any) {
  const { r1, r2, r3, r4 } = routers;

  // R1 DHCP pour LAN1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('ip dhcp excluded-address 192.168.1.1 192.168.1.10'); // réservé pour statique
  await r1.executeCommand('ip dhcp pool LAN1_POOL');
  await r1.executeCommand('network 192.168.1.0 255.255.255.0');
  await r1.executeCommand('default-router 192.168.1.254');
  await r1.executeCommand('dns-server 8.8.8.8');
  await r1.executeCommand('lease 1');
  await r1.executeCommand('exit');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('ip dhcp excluded-address 192.168.2.1 192.168.2.10');
  await r2.executeCommand('ip dhcp pool LAN2_POOL');
  await r2.executeCommand('network 192.168.2.0 255.255.255.0');
  await r2.executeCommand('default-router 192.168.2.254');
  await r2.executeCommand('dns-server 8.8.8.8');
  await r2.executeCommand('lease 1');
  await r2.executeCommand('end');

  // R3
  await r3.executeCommand('enable');
  await r3.executeCommand('configure terminal');
  await r3.executeCommand('ip dhcp excluded-address 192.168.3.1 192.168.3.10');
  await r3.executeCommand('ip dhcp pool LAN3_POOL');
  await r3.executeCommand('network 192.168.3.0 255.255.255.0');
  await r3.executeCommand('default-router 192.168.3.254');
  await r3.executeCommand('dns-server 8.8.8.8');
  await r3.executeCommand('lease 1');
  await r3.executeCommand('end');

  // R4
  await r4.executeCommand('enable');
  await r4.executeCommand('configure terminal');
  await r4.executeCommand('ip dhcp excluded-address 192.168.4.1 192.168.4.10');
  await r4.executeCommand('ip dhcp pool LAN4_POOL');
  await r4.executeCommand('network 192.168.4.0 255.255.255.0');
  await r4.executeCommand('default-router 192.168.4.254');
  await r4.executeCommand('dns-server 8.8.8.8');
  await r4.executeCommand('lease 1');
  await r4.executeCommand('end');
}

// Helper pour obtenir une adresse IP via DHCP sur un hôte
async function dhcpRequest(host: LinuxPC | WindowsPC) {
  if (host instanceof LinuxPC) {
    await host.executeCommand('dhclient eth0');
    // Attendre que l'IP soit attribuée (simulation)
    await new Promise(resolve => setTimeout(resolve, 100));
  } else {
    await host.executeCommand('ipconfig /renew');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  MACAddress.resetCounter();
});

describe('Configuration IP statique', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureHostsStatic(topology.hosts);
  });

  it('devrait configurer les adresses IP sur les routeurs correctement', async () => {
    const { r1, r2, r3, r4 } = topology.routers;

    const r1_if = await r1.executeCommand('show ip interface brief');
    expect(r1_if).toContain('192.168.1.254');
    expect(r1_if).toContain('10.0.12.1');
    expect(r1_if).toContain('10.0.41.2');

    const r2_if = await r2.executeCommand('show ip interface brief');
    expect(r2_if).toContain('192.168.2.254');
    expect(r2_if).toContain('10.0.12.2');
    expect(r2_if).toContain('10.0.23.1');
  });

  it('devrait configurer les adresses IP statiques sur les hôtes', async () => {
    const { hosts } = topology;
    const pc1 = hosts.lan1[0] as LinuxPC;
    const ifconfig = await pc1.executeCommand('ifconfig eth0');
    expect(ifconfig).toContain('192.168.1.1');

    const pcWin = hosts.lan2[1] as WindowsPC;
    const ipconfig = await pcWin.executeCommand('ipconfig');
    expect(ipconfig).toContain('192.168.2.2');
  });

  it('devrait avoir des routes statiques sur les routeurs', async () => {
    const { r1 } = topology.routers;
    const routeTable = await r1.executeCommand('show ip route');
    // Vérifier que les routes statiques sont présentes (marquées avec S)
    expect(routeTable).toContain('192.168.2.0');
    expect(routeTable).toContain('192.168.3.0');
    expect(routeTable).toContain('192.168.4.0');
  });
});

describe('DHCP', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureDHCPServers(topology.routers);
    // On ne configure pas les hôtes en statique ici, ils utiliseront DHCP
  });

  it('devrait attribuer une adresse IP via DHCP à un client Linux', async () => {
    const linuxHost = topology.hosts.lan3[0] as LinuxPC;
    await dhcpRequest(linuxHost);
    const ifconfig = await linuxHost.executeCommand('ifconfig eth0');
    expect(ifconfig).toMatch(/192\.168\.3\.\d+/);
    const route = await linuxHost.executeCommand('route -n');
    expect(route).toContain('192.168.3.254');
  });

  it('devrait attribuer une adresse IP via DHCP à un client Windows', async () => {
    const winHost = topology.hosts.lan4[1] as WindowsPC;
    await dhcpRequest(winHost);
    const ipconfig = await winHost.executeCommand('ipconfig');
    expect(ipconfig).toMatch(/192\.168\.4\.\d+/);
  });

  it('devrait afficher les liaisons DHCP sur le routeur', async () => {
    const { r1 } = topology.routers;
    // Simuler une demande depuis un client
    const linuxHost = topology.hosts.lan1[0] as LinuxPC;
    await dhcpRequest(linuxHost);
    const bindings = await r1.executeCommand('show ip dhcp binding');
    expect(bindings).toContain('192.168.1.');
  });

  it('devrait renouveler un bail DHCP', async () => {
    const linuxHost = topology.hosts.lan2[0] as LinuxPC;
    await dhcpRequest(linuxHost);
    const ipBefore = (await linuxHost.executeCommand('ifconfig eth0')).match(/192\.168\.2\.\d+/)?.[0];
    expect(ipBefore).toBeDefined();
    // Forcer le renouvellement
    await linuxHost.executeCommand('dhclient -r eth0');
    await linuxHost.executeCommand('dhclient eth0');
    const ipAfter = (await linuxHost.executeCommand('ifconfig eth0')).match(/192\.168\.2\.\d+/)?.[0];
    expect(ipAfter).toBe(ipBefore); // même IP normalement
  });
});

describe('ARP', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureHostsStatic(topology.hosts);
  });

  it('devrait afficher une table ARP vide avant tout trafic', async () => {
    const pc = topology.hosts.lan1[0] as LinuxPC;
    const arpTable = await pc.executeCommand('arp -n');
    expect(arpTable.trim()).toBe('');
  });

  it('devrait remplir la table ARP après un ping', async () => {
    const pc1 = topology.hosts.lan1[0] as LinuxPC;
    const pc2 = topology.hosts.lan1[1] as LinuxPC;
    await pc1.executeCommand('ping -c 1 192.168.1.2');
    const arp = await pc1.executeCommand('arp -n');
    expect(arp).toContain('192.168.1.2');
    expect(arp).toContain('ether');
  });

  it('devrait ajouter une entrée ARP statique sur Linux', async () => {
    const pc = topology.hosts.lan3[0] as LinuxPC;
    await pc.executeCommand('arp -s 192.168.3.100 aa:bb:cc:dd:ee:ff');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toContain('192.168.3.100');
    expect(arp).toContain('aa:bb:cc:dd:ee:ff');
  });

  it('devrait supprimer une entrée ARP sur Windows', async () => {
    const win = topology.hosts.lan2[1] as WindowsPC;
    // D'abord populer
    await win.executeCommand('ping -n 1 192.168.2.254');
    let arp = await win.executeCommand('arp -a');
    expect(arp).toContain('192.168.2.254');
    await win.executeCommand('arp -d 192.168.2.254');
    arp = await win.executeCommand('arp -a');
    expect(arp).not.toContain('192.168.2.254');
  });

  it('devrait afficher la table ARP du routeur', async () => {
    const { r1 } = topology.routers;
    // Générer du trafic pour remplir ARP
    const pc = topology.hosts.lan1[0] as LinuxPC;
    await pc.executeCommand('ping -c 1 192.168.1.254');
    const arpRouter = await r1.executeCommand('show ip arp');
    expect(arpRouter).toContain('192.168.1.1');
    expect(arpRouter).toContain('ARPA');
  });
});

describe('Ping', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureHostsStatic(topology.hosts);
  });

  it('devrait réussir un ping intra-LAN', async () => {
    const pc1 = topology.hosts.lan1[0] as LinuxPC;
    const pc2 = topology.hosts.lan1[1] as LinuxPC;
    const result = await pc1.executeCommand('ping -c 2 192.168.1.2');
    expect(result).toContain('2 packets transmitted');
    expect(result).toContain('0% packet loss');
  });

  it('devrait réussir un ping inter-LAN (LAN1 -> LAN2)', async () => {
    const pc1 = topology.hosts.lan1[0] as LinuxPC;
    const pc4 = topology.hosts.lan2[0] as LinuxPC;
    const result = await pc1.executeCommand('ping -c 2 192.168.2.1');
    expect(result).toContain('0% packet loss');
  });

  it('devrait réussir un ping inter-LAN depuis Windows', async () => {
    const win = topology.hosts.lan2[1] as WindowsPC;
    const pc7 = topology.hosts.lan3[0] as LinuxPC;
    const result = await win.executeCommand('ping -n 2 192.168.3.1');
    expect(result).toContain('0% loss');
  });

  it('devrait échouer un ping vers une adresse inexistante', async () => {
    const pc = topology.hosts.lan1[0] as LinuxPC;
    const result = await pc.executeCommand('ping -c 1 192.168.99.99');
    expect(result).toContain('100% packet loss');
  });

  it('devrait supporter un ping avec taille de paquet personnalisée', async () => {
    const pc1 = topology.hosts.lan1[0] as LinuxPC;
    const result = await pc1.executeCommand('ping -c 1 -s 1400 192.168.1.2');
    // Sur Linux, ping -s 1400 affiche "PING ... 1400(1428) bytes of data."
    expect(result).toContain('1400');
    expect(result).toContain('bytes of data');
  });
});

describe('Traceroute', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureHostsStatic(topology.hosts);
  });

  it('devrait tracer le chemin de LAN1 à LAN3 (3 hops)', async () => {
    const pc1 = topology.hosts.lan1[0] as LinuxPC;
    const result = await pc1.executeCommand('traceroute -n 192.168.3.1');
    // Attendu: 1er hop = passerelle LAN1 (192.168.1.254), puis routeur R2 (10.0.12.2) ou R1? Selon static routes: R1 -> R2 -> R3
    expect(result).toContain('192.168.1.254');
    expect(result).toContain('10.0.12.2');
    expect(result).toContain('10.0.23.2');
    expect(result).toContain('192.168.3.1');
  });

  it('devrait tracer le chemin de LAN2 à LAN4 (via R2-R3-R4)', async () => {
    const pc4 = topology.hosts.lan2[0] as LinuxPC;
    const result = await pc4.executeCommand('traceroute -n 192.168.4.1');
    expect(result).toContain('192.168.2.254');
    expect(result).toContain('10.0.23.2');
    expect(result).toContain('10.0.34.2');
    expect(result).toContain('192.168.4.1');
  });

  it('devrait fonctionner avec tracert sur Windows', async () => {
    const win = topology.hosts.lan4[1] as WindowsPC;
    const result = await win.executeCommand('tracert -d 192.168.1.1');
    expect(result).toContain('192.168.4.254');
    expect(result).toContain('10.0.41.2');
    expect(result).toContain('192.168.1.1');
  });

  it('devrait afficher des marqueurs pour une destination injoignable', async () => {
    const pc = topology.hosts.lan1[0] as LinuxPC;
    const result = await pc.executeCommand('traceroute -n 10.255.255.1');
    // R1 n'a pas de route vers 10.255.255.0 → envoie ICMP Destination Unreachable
    // Le traceroute affiche !N (network unreachable) ou * (timeout)
    expect(result).toMatch(/\*|!N/);
  });
});

describe('Scénarios combinés', () => {
  let topology: any;

  beforeEach(async () => {
    topology = createTopology();
    await configureRoutersStatic(topology.routers);
    await configureDHCPServers(topology.routers);
    // Laisser certains hôtes en DHCP, d'autres en statique
    await configureHostsStatic({
      lan1: topology.hosts.lan1,   // statique
      lan2: [topology.hosts.lan2[0]], // un seul statique
      lan3: [],
      lan4: [],
    });
    // Configurer DHCP pour les autres
    await dhcpRequest(topology.hosts.lan2[1] as WindowsPC);
    await dhcpRequest(topology.hosts.lan2[2] as WindowsPC);
    for (const host of topology.hosts.lan3) await dhcpRequest(host);
    for (const host of topology.hosts.lan4) await dhcpRequest(host);
  });

  it('mélange statique/DHCP : ping entre hôtes de LAN différents', async () => {
    const staticHost = topology.hosts.lan1[0] as LinuxPC;
    const dhcpHost = topology.hosts.lan3[0] as LinuxPC;
    const dhcpIp = (await dhcpHost.executeCommand('ifconfig eth0')).match(/192\.168\.3\.\d+/)?.[0];
    expect(dhcpIp).toBeDefined();
    const result = await staticHost.executeCommand(`ping -c 2 ${dhcpIp}`);
    expect(result).toContain('0% packet loss');
  });

  it('vérification ARP après DHCP', async () => {
    const win = topology.hosts.lan4[1] as WindowsPC;
    await win.executeCommand('ping -n 1 192.168.4.254');
    const arp = await win.executeCommand('arp -a');
    expect(arp).toContain('192.168.4.254');
  });
});
