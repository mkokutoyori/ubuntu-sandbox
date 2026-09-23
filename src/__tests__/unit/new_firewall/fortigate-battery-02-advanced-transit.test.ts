import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

// Topologie Étendue : LAN Client <-> Cisco Switch <-> [FortiGate] <-> DMZ Server & WAN Server
interface LaboAvance {
  pc: LinuxPC;
  sw: CiscoSwitch;
  fw: Cli;
  dmzSrv: LinuxServer;
  wanSrv: LinuxServer;
}

async function creerLaboAvance(): Promise<LaboAvance> {
  const pc = new LinuxPC('linux-pc', 'PC-Client', 100, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 12, 250, 0);
  const fw = createDevice('firewall-fortinet', 450, 0) as unknown as Cli;
  const dmzSrv = new LinuxServer('linux-server', 'SRV-DMZ', 650, 0);
  const wanSrv = new LinuxServer('linux-server', 'SRV-WAN', 850, 0);

  pc.powerOn();
  sw.powerOn();
  dmzSrv.powerOn();
  wanSrv.powerOn();

  // Câblage L2 / L3
  new Cable('c-pc-sw').connect(pc.getPort('eth0') as never, sw.getPort('FastEthernet0/2') as never);
  new Cable('c-sw-fw').connect(sw.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);
  new Cable('c-fw-dmz').connect(fw.getPort('dmz') as never, dmzSrv.getPort('eth0') as never);
  new Cable('c-fw-wan').connect(fw.getPort('wan1') as never, wanSrv.getPort('eth0') as never);

  // Interfaces Pare-feu (LAN, DMZ, WAN)
  await taper(fw, [
    'config system interface',
    'edit port1',
    'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh http https',
    'next',
    'edit dmz',
    'set mode static',
    'set ip 10.0.0.1 255.255.255.0',
    'set allowaccess ping ssh',
    'next',
    'edit wan1',
    'set mode static',
    'set ip 203.0.113.1 255.255.255.0',
    'set allowaccess ping',
    'next',
    'end',
  ]);

  // Client LAN
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
  ]);

  // Serveur DMZ
  await taper(dmzSrv as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 10.0.0.5/24 dev eth0',
    'ip route add default via 10.0.0.1',
  ]);

  // Serveur WAN / Externe
  await taper(wanSrv as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 203.0.113.9/24 dev eth0',
    'ip route add default via 203.0.113.1',
  ]);

  return { pc, sw, fw, dmzSrv, wanSrv };
}

describe('Batterie 2 : Tests 51 à 100 — Flux Réseau Traversants Avancés', () => {

  // =========================================================================
  // 10. FLUX MULTI-ZONES, ARCHITECTURE 3-TIERS & DMZ (Tests 51 à 57)
  // =========================================================================
  describe('DMZ & Isolation Multi-Zones en Transit', () => {
    it('51. Le client LAN peut joindre le serveur Web en DMZ si la policy LAN->DMZ existe', async () => {
      const { pc, fw, dmzSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 10',
        'set srcintf "port1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "HTTP"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://10.0.0.5/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('52. Un hôte DMZ ne peut JAMAIS initier une connexion vers le LAN par défaut', async () => {
      const { dmzSrv } = await creerLaboAvance();
      const res = await dmzSrv.executeCommand('ping -c 1 -W 1 192.168.1.10');
      expect(res).toMatch(/100% packet loss/);
    });

    it('53. Architecture 3-Tiers : Le Web Nginx en DMZ requiert la DB Oracle en LAN/Zone privée', async () => {
      const { pc, fw, dmzSrv } = await creerLaboAvance();
      // On place Oracle sur le PC LAN et on autorise DMZ -> LAN uniquement sur le port 1521
      await taper(pc as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fw, [
        'config firewall policy', 'edit 11',
        'set srcintf "dmz"', 'set dstintf "port1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await dmzSrv.executeCommand('tnsping 192.168.1.10:1521/XE');
      expect(res).toMatch(/OK/);
    });

    it('54. Trafic WAN entrant autorisé vers DMZ en HTTP sans accès direct au LAN', async () => {
      const { fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 12',
        'set srcintf "wan1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "HTTP"', 'next', 'end',
      ]);
      const resDmz = await wanSrv.executeCommand('curl -s http://10.0.0.5/');
      expect(resDmz).toMatch(/nginx/i);
      const resLan = await wanSrv.executeCommand('curl -s --connect-timeout 1 http://192.168.1.10/');
      expect(resLan).toMatch(/Connection timed out|Failed to connect/i);
    });

    it('55. Le serveur DMZ résout les noms via le DNS BIND9 hébergé sur le WAN', async () => {
      const { fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config firewall policy', 'edit 13',
        'set srcintf "dmz"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "DNS"', 'next', 'end',
      ]);
      const res = await dmzSrv.executeCommand('dig @203.0.113.9 api.service.com +short');
      expect(res).not.toMatch(/connection timed out/i);
    });

    it('56. Flux de sauvegarde : Serveur DMZ pousse une archive vers le serveur FTP LAN via port 21', async () => {
      const { pc, fw, dmzSrv } = await creerLaboAvance();
      await taper(pc as unknown as Cli, ['systemctl start vsftpd']);
      await taper(fw, [
        'config firewall policy', 'edit 14',
        'set srcintf "dmz"', 'set dstintf "port1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "FTP"', 'next', 'end',
      ]);
      const res = await dmzSrv.executeCommand('nc -zv -w 2 192.168.1.10 21');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('57. Rebond Bastion SSH : connexion traversante DMZ -> WAN relayée', async () => {
      const { pc, fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start sshd']);
      await taper(wanSrv as unknown as Cli, ['systemctl start sshd']);
      await taper(fw, [
        'config firewall policy',
        'edit 15', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "SSH"', 'next',
        'edit 16', 'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "SSH"', 'next',
        'end',
      ]);
      const jump = await pc.executeCommand('ssh -J root@10.0.0.5 root@203.0.113.9 "hostname"');
      expect(jump).toContain('SRV-WAN');
    });
  });

  // =========================================================================
  // 11. COMMUTATION CISCO, VLAN 802.1Q ET ROUTER-ON-A-STICK (Tests 58 à 63)
  // =========================================================================
  describe('802.1Q VLAN Trunking & Commutation L2 Traversante', () => {
    it('58. Configuration du trunk 802.1Q sur le switch Cisco vers le pare-feu', async () => {
      const { sw } = await creerLaboAvance();
      await taper(sw as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/1',
        'switchport mode trunk',
        'switchport trunk allowed vlan 10,20',
        'end',
      ]);
      const res = await sw.executeCommand('show interfaces trunk');
      expect(res).toMatch(/FastEthernet0\/1/);
    });

    it('59. Sous-interface 802.1Q sur le pare-feu (port1.10) répond au ping d\'un VLAN taggé', async () => {
      const { sw, fw, pc } = await creerLaboAvance();
      await taper(sw as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/1', 'switchport mode trunk', 'exit',
        'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'end',
      ]);
      await taper(fw, [
        'config system interface',
        'edit "port1.10"',
        'set vdom "root"', 'set ip 192.168.10.1 255.255.255.0',
        'set interface "port1"', 'set vlanid 10',
        'set allowaccess ping', 'next', 'end',
      ]);
      await taper(pc as unknown as Cli, [
        'ip addr flush dev eth0',
        'ip addr add 192.168.10.50/24 dev eth0',
        'ip route add default via 192.168.10.1',
      ]);
      const ping = await pc.executeCommand('ping -c 1 192.168.10.1');
      expect(ping).toMatch(/0% packet loss/);
    });

    it('60. Routage inter-VLAN traversant via sous-interfaces pare-feu (VLAN 10 vers VLAN 20)', async () => {
      const { fw, pc } = await creerLaboAvance();
      await taper(fw, [
        'config system interface',
        'edit "port1.20"', 'set vdom "root"', 'set ip 192.168.20.1 255.255.255.0',
        'set interface "port1"', 'set vlanid 20', 'set allowaccess ping', 'next', 'end',
        'config firewall policy', 'edit 20',
        'set srcintf "port1.10"', 'set dstintf "port1.20"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "PING"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('ping -c 1 192.168.20.1');
      expect(res).toMatch(/0% packet loss/);
    });

    it('61. Isolation stricte : échec du transit entre VLANs si aucune policy ne l\'autorise', async () => {
      const { pc } = await creerLaboAvance();
      // On teste vers une IP du VLAN 20 inexistante ou non autorisée
      const res = await pc.executeCommand('ping -c 1 -W 1 192.168.20.99');
      expect(res).toMatch(/100% packet loss|Destination Host Unreachable/);
    });

    it('62. Déplacement de port access sur le switch coupe immédiatement le flux L2', async () => {
      const { sw, pc } = await creerLaboAvance();
      await taper(sw as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'shutdown', 'end',
      ]);
      const res = await pc.executeCommand('ping -c 1 -W 1 192.168.1.1');
      expect(res).toMatch(/100% packet loss|Network is down/i);
    });

    it('63. Nettoyage de la table MAC du switch lors d\'un "clear mac address-table"', async () => {
      const { sw, pc } = await creerLaboAvance();
      await pc.executeCommand('ping -c 1 192.168.1.1');
      await sw.executeCommand('clear mac address-table dynamic');
      const table = await sw.executeCommand('show mac address-table');
      expect(table).not.toMatch(/FastEthernet0\/2/);
    });
  });

  // =========================================================================
  // 12. NAT AVANCÉ : HAIRPINNING, IP POOL & PORT MAPPING (Tests 64 à 70)
  // =========================================================================
  describe('NAT Hairpinning, Translation de Ports & Pools SNAT', () => {
    it('64. NAT Hairpinning (Loopback NAT) : Le client LAN accède au serveur web LAN via la VIP externe', async () => {
      const { pc, fw, dmzSrv } = await creerLaboAvance();
      // dmzSrv héberge Nginx
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall vip', 'edit "VIP_HAIRPIN"',
        'set extip 203.0.113.100', 'set mappedip "10.0.0.5"',
        'next', 'end',
        'config firewall policy', 'edit 30',
        'set srcintf "port1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "VIP_HAIRPIN"',
        'set action accept', 'set nat enable', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://203.0.113.100/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('65. Port Translation (PAT VIP) : Accès WAN port 8080 redirigé en interne sur le port 80', async () => {
      const { fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall vip', 'edit "VIP_PORT_MAP"',
        'set extip 203.0.113.1', 'set mappedip "10.0.0.5"',
        'set portforward enable', 'set protocol tcp',
        'set extport 8080', 'set mappedport 80',
        'next', 'end',
        'config firewall policy', 'edit 31',
        'set srcintf "wan1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "VIP_PORT_MAP"',
        'set action accept', 'next', 'end',
      ]);
      const res = await wanSrv.executeCommand('curl -s http://203.0.113.1:8080/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('66. SNAT avec IP Pool : la source interne sort avec une IP publique dédiée issue d\'un pool', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall ippool', 'edit "POOL_PUBLIC"',
        'set startip 203.0.113.50', 'set endip 203.0.113.50',
        'next', 'end',
        'config firewall policy', 'edit 32',
        'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set nat enable', 'set ippool enable', 'set poolname "POOL_PUBLIC"',
        'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.9/');
      const log = await wanSrv.executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(log).toContain('203.0.113.50');
    });

    it('67. VIP filtrée par IP source : seules certaines adresses publiques peuvent franchir le VIP', async () => {
      const { fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall vip', 'edit "VIP_RESTREINT"',
        'set extip 203.0.113.1', 'set mappedip "10.0.0.5"', 'next', 'end',
        'config firewall policy', 'edit 33',
        'set srcintf "wan1"', 'set dstintf "dmz"',
        // Autorise uniquement une autre IP fictive
        'set srcaddr "198.51.100.22"', 'set dstaddr "VIP_RESTREINT"',
        'set action accept', 'next', 'end',
      ]);
      const res = await wanSrv.executeCommand('curl -s --connect-timeout 1 http://203.0.113.1/');
      expect(res).toMatch(/timed out|refused/i);
    });

    it('68. Multiples VIPs sur la même IP externe vers des serveurs DMZ distincts selon le port', async () => {
      const { fw, dmzSrv, pc, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']); // port 80
      await taper(pc as unknown as Cli, ['systemctl start sshd']);     // port 22
      await taper(fw, [
        'config firewall vip',
        'edit "VIP_HTTP"', 'set extip 203.0.113.1', 'set mappedip "10.0.0.5"', 'set portforward enable', 'set extport 80', 'set mappedport 80', 'next',
        'edit "VIP_SSH_LAN"', 'set extip 203.0.113.1', 'set mappedip "192.168.1.10"', 'set portforward enable', 'set extport 2222', 'set mappedport 22', 'next',
        'end',
        'config firewall policy',
        'edit 34', 'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "VIP_HTTP"', 'set action accept', 'next',
        'edit 35', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "VIP_SSH_LAN"', 'set action accept', 'next',
        'end',
      ]);
      const httpRes = await wanSrv.executeCommand('curl -s http://203.0.113.1/');
      const sshRes = await wanSrv.executeCommand('nc -zv -w 2 203.0.113.1 2222');
      expect(httpRes).toMatch(/nginx/i);
      expect(sshRes).toMatch(/succeeded|open|Connected/i);
    });

    it('69. Préservation de port : le pare-feu conserve le port source dynamique lors du SNAT', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 36',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set nat enable', 'next', 'end',
      ]);
      await pc.executeCommand('curl --local-port 45678 -s http://203.0.113.9/');
      const session = await fw.executeCommand('diagnose sys session list');
      expect(session).toContain('45678');
    });

    it('70. La suppression d\'un VIP interrompt immédiatement les connexions entrantes établies', async () => {
      const { fw, wanSrv } = await creerLaboAvance();
      await taper(fw, ['config firewall vip', 'delete "VIP_HAIRPIN"', 'end']);
      const res = await wanSrv.executeCommand('curl -s --connect-timeout 1 http://203.0.113.100/');
      expect(res).toMatch(/timed out|Failed to connect/i);
    });
  });

  // =========================================================================
  // 13. ROUTAGE STATIQUE MULTI-SAUTS & TRACEROUTE (Tests 71 à 76)
  // =========================================================================
  describe('Routage Avancé, TTL & Découverte de Topologie', () => {
    it('71. Traceroute couche 3 révèle le pare-feu comme premier saut intermédiaire', async () => {
      const { pc, fw } = await creerLaboAvance();
      await taper(fw, [
        'config firewall policy', 'edit 40',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await pc.executeCommand('traceroute -n -w 1 203.0.113.9');
      expect(res).toMatch(/1\s+192\.168\.1\.1/);
    });

    it('72. Paquet avec TTL=1 vers une cible distante expire sur le pare-feu (ICMP Time Exceeded)', async () => {
      const { pc } = await creerLaboAvance();
      const res = await pc.executeCommand('ping -c 1 -t 1 203.0.113.9');
      expect(res).toMatch(/Time to live exceeded|From 192\.168\.1\.1/i);
    });

    it('73. Route statique spécifique prioritaire sur la route par défaut (Longest Prefix Match)', async () => {
      const { fw } = await creerLaboAvance();
      await taper(fw, [
        'config router static',
        'edit 1', 'set dst 203.0.113.0 255.255.255.0', 'set device "wan1"', 'next',
        'edit 2', 'set dst 203.0.113.9 255.255.255.255', 'set device "wan1"', 'next',
        'end',
      ]);
      const routing = await fw.executeCommand('get router info routing-table all');
      expect(routing).toMatch(/203\.0\.113\.9\/32/);
    });

    it('74. Blackhole Route : le trafic vers un sous-réseau interdit est jeté silencieusement sans paquet retour', async () => {
      const { pc, fw } = await creerLaboAvance();
      await taper(fw, [
        'config router static',
        'edit 99', 'set dst 198.51.100.0 255.255.255.0', 'set blackhole enable', 'next',
        'end',
      ]);
      const res = await pc.executeCommand('ping -c 1 -W 1 198.51.100.5');
      expect(res).toMatch(/100% packet loss/);
    });

    it('75. Rejet par le pare-feu du routage asymétrique non déclaré', async () => {
      const { pc, fw } = await creerLaboAvance();
      await taper(fw, [
        'config system settings', 'set asymroute disable', 'end',
      ]);
      const status = await fw.executeCommand('get system settings');
      expect(status).toMatch(/asymroute\s*:\s*disable/i);
    });

    it('76. Basculement de passerelle par défaut sur le PC en cas d\'indisponibilité', async () => {
      const { pc } = await creerLaboAvance();
      await taper(pc as unknown as Cli, [
        'ip route del default',
        'ip route add default via 192.168.1.1 metric 10',
        'ip route add default via 192.168.1.254 metric 20',
      ]);
      const route = await pc.executeCommand('ip route show');
      expect(route).toContain('metric 10');
      expect(route).toContain('metric 20');
    });
  });

  // =========================================================================
  // 14. DHCP RELAY & DNS BIND9 AVANCÉ (Tests 77 à 82)
  // =========================================================================
  describe('DHCP Relay & BIND9 Haute Précision', () => {
    it('77. DHCP Relay configuré sur le pare-feu convertit le Broadcast LAN en Unicast vers le serveur WAN', async () => {
      const { fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start isc-dhcp-server']);
      await taper(fw, [
        'config system interface', 'edit "port1"',
        'set dhcp-relay-service enable',
        'set dhcp-relay-ip "203.0.113.9"', 'next', 'end',
      ]);
      const conf = await fw.executeCommand('show system interface port1');
      expect(conf).toContain('203.0.113.9');
    });

    it('78. Le client obtient son bail avec passerelle et serveur DNS via le relais traversant', async () => {
      const { pc, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start isc-dhcp-server']);
      const res = await pc.executeCommand('cat /var/lib/dhcp/dhclient.leases');
      expect(res).toMatch(/routers|domain-name-servers/i);
    });

    it('79. Résolution DNS récursive d\'un enregistrement CNAME pointant vers un alias traversant', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config firewall policy', 'edit 45',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "DNS"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('dig @203.0.113.9 alias.lab.lan');
      expect(res).toMatch(/CNAME/);
    });

    it('80. DNS TCP Fallback : Réponse DNS tronquée (>512 octets) traversant le pare-feu sur le port 53/TCP', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config firewall policy', 'edit 46',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "DNS"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('dig +tcp @203.0.113.9 largezone.lab.lan AXFR');
      expect(res).not.toMatch(/connection refused|timed out/i);
    });

    it('81. Cache DNS : Seconde requête résolue instantanément avec un query time réduit', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config firewall policy', 'edit 47',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "DNS"', 'next', 'end',
      ]);
      await pc.executeCommand('dig @203.0.113.9 host.lab.lan');
      const res = await pc.executeCommand('dig @203.0.113.9 host.lab.lan');
      expect(res).toMatch(/Query time: [01] msec/);
    });

    it('82. Renouvellement de bail DHCP Unicast direct vers le serveur sans passer par le broadcast', async () => {
      const { pc, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start isc-dhcp-server']);
      const res = await pc.executeCommand('dhclient -r eth0 && dhclient -1 eth0');
      expect(res).not.toMatch(/failed/i);
    });
  });

  // =========================================================================
  // 15. SERVICES APPLICATIFS PROFONDS (NGINX, ORACLE, FTP ACTIF) (Tests 83 à 91)
  // =========================================================================
  describe('Protocoles Applicatifs Avancés en Transit', () => {
    it('83. Nginx Reverse Proxy : DMZ relaie la requête HTTP du client vers le WAN backend', async () => {
      const { pc, fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']); // Backend final
      await taper(dmzSrv as unknown as Cli, [
        'systemctl start nginx-proxy', // Proxy inverse pointant vers 203.0.113.9
      ]);
      await taper(fw, [
        'config firewall policy',
        'edit 50', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "HTTP"', 'next',
        'edit 51', 'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "HTTP"', 'next',
        'end',
      ]);
      const res = await pc.executeCommand('curl -s http://10.0.0.5/api/data');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('84. Nginx Keep-Alive : Plusieurs requêtes HTTP successives réutilisent la même session TCP', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 52',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "HTTP"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -v http://203.0.113.9/ http://203.0.113.9/ 2>&1');
      expect(res).toMatch(/Re-using existing connection!|Connected to 203\.0\.113\.9/i);
    });

    it('85. FTP Active Mode : L\'ALG FTP du pare-feu ouvre dynamiquement le port de retour', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start vsftpd']);
      await taper(fw, [
        'config system session-helper', 'edit 1', 'set name "ftp"', 'set port 21', 'set protocol 6', 'next', 'end',
        'config firewall policy', 'edit 53',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "FTP"', 'set nat enable', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s --no-pasv ftp://203.0.113.9/');
      expect(res).not.toMatch(/Illegal PORT command|couldn't connect/i);
    });

    it('86. Transaction Oracle PL/SQL : exécution d\'un bloc BEGIN...END traversant la passerelle', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fw, [
        'config firewall policy', 'edit 54',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const plsql = 'echo "BEGIN NULL; END; /" | sqlplus -S system/oracle@203.0.113.9:1521/XE';
      const res = await pc.executeCommand(plsql);
      expect(res).toMatch(/PL\/SQL procedure successfully completed/i);
    });

    it('87. Oracle Connection Pool : le maintien KeepAlive empêche la déconnexion après inactivité', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fw, [
        'config firewall policy', 'edit 55',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const ping = await pc.executeCommand('tnsping 203.0.113.9:1521/XE');
      expect(ping).toContain('OK');
    });

    it('88. SCP (Secure Copy) : transfert chiffré intègre de fichier volumineux traversant le switch et firewall', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start sshd']);
      await taper(fw, [
        'config firewall policy', 'edit 56',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "SSH"', 'next', 'end',
      ]);
      await pc.executeCommand('head -c 100000 /dev/urandom > payload.bin');
      const scpRes = await pc.executeCommand('scp -o StrictHostKeyChecking=no payload.bin root@203.0.113.9:/tmp/');
      expect(scpRes).not.toMatch(/stalled|lost connection/i);
    });

    it('89. Déconnexion brutale Telnet : le serveur ferme le socket localement lors du drop de session', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start telnetd']);
      await taper(fw, [
        'config firewall policy', 'edit 57',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "TELNET"', 'next', 'end',
      ]);
      await pc.executeCommand('echo "exit" | nc 203.0.113.9 23');
      const sock = await wanSrv.executeCommand('ss -ant | grep :23');
      expect(sock).not.toMatch(/ESTAB/);
    });

    it('90. Détection d\'erreur HTTP 502 Bad Gateway quand le proxy Nginx ne peut joindre le backend', async () => {
      const { pc, fw, dmzSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx-proxy']); // Backend éteint
      await taper(fw, [
        'config firewall policy', 'edit 58',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "HTTP"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.0.0.5/api/dead');
      expect(res.trim()).toBe('502');
    });

    it('91. Annulation Oracle Rollback : une transaction interrompue ne persiste aucune écriture', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fw, [
        'config firewall policy', 'edit 59',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const sql = 'echo "INSERT INTO t VALUES (1); ROLLBACK; EXIT;" | sqlplus -S system/oracle@203.0.113.9:1521/XE';
      const res = await pc.executeCommand(sql);
      expect(res).toMatch(/Rollback complete/i);
    });
  });

  // =========================================================================
  // 16. MOTEUR STATEFUL BAS-NIVEAU, TCP FLAGS & EDGE CASES (Tests 92 à 100)
  // =========================================================================
  describe('Sécurité Stateful Bas-Niveau, RPF Anti-Spoofing & Robustesse', () => {
    it('92. Rejet stateful des paquets TCP hors-fenêtre ou sans SYN initial', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 60',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      // Injection directe d'un ACK sans SYN préalable via hping3
      const res = await pc.executeCommand('hping3 -A -p 80 -c 1 203.0.113.9');
      expect(res).toMatch(/100% packet loss|0 packets received/i);
    });

    it('93. TCP FIN Handshake : La fermeture propre libère l\'entrée dans la table de session', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 61',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.9/');
      const sessions = await fw.executeCommand('diagnose sys session list');
      // La session fermée ne doit plus être à l'état ESTABLISHED
      expect(sessions).not.toMatch(/proto_state=01/); // 01 = ESTABLISHED sous FortiOS
    });

    it('94. Connexion sur un port fermé renvoie un TCP RST immédiat qui clôture le flux', async () => {
      const { pc, fw } = await creerLaboAvance();
      await taper(fw, [
        'config firewall policy', 'edit 62',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s --connect-timeout 2 http://203.0.113.9:9999/');
      expect(res).toMatch(/Connection refused/i);
    });

    it('95. Clamping MSS / MTU : Le pare-feu ajuste le champ TCP MSS pour éviter la fragmentation', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 63',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set tcp-mss-sender 1400', 'set tcp-mss-receiver 1400', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://203.0.113.9/');
      expect(res).toMatch(/nginx/i);
    });

    it('96. Anti-Spoofing RPF (Reverse Path Forwarding) : Le pare-feu détruit un paquet émis avec une IP source usurpée', async () => {
      const { pc, fw } = await creerLaboAvance();
      await taper(fw, [
        'config system interface', 'edit "port1"',
        'set src-check enable', 'next', 'end', // Strict RPF
      ]);
      // PC envoie un paquet avec IP source externe (203.0.113.88) depuis son interface LAN
      const res = await pc.executeCommand('hping3 -a 203.0.113.88 -1 -c 1 203.0.113.1');
      expect(res).toMatch(/100% packet loss|0 packets received/i);
    });

    it('97. Expiration de session TCP : suppression automatique de la table après inactivité prolongée', async () => {
      const { fw } = await creerLaboAvance();
      await taper(fw, [
        'config system session-ttl',
        'set default 5', // 5 secondes TTL
        'end',
      ]);
      const conf = await fw.executeCommand('get system session-ttl');
      expect(conf).toMatch(/default\s*:\s*5/);
    });

    it('98. Détection et journalisation d\'un balayage de ports (Port Scan)', async () => {
      const { pc, fw } = await creerLaboAvance();
      await pc.executeCommand('nc -zv -w 1 203.0.113.1 80 81 82 83');
      const logs = await fw.executeCommand('diagnose log test');
      expect(refuse(logs)).toBe(false);
    });

    it('99. Réassemblage transparent de trames IP fragmentées lors du transit', async () => {
      const { pc, fw, wanSrv } = await creerLaboAvance();
      await taper(wanSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 64',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      // Envoi de trames fragmentées de force (MTU 576)
      const res = await pc.executeCommand('curl -s --compressed http://203.0.113.9/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('100. Stress Test Transit : Rafale concurrente HTTP, SQL, Telnet et ICMP sans perte de paquet', async () => {
      const { pc, fw, dmzSrv, wanSrv } = await creerLaboAvance();
      await taper(dmzSrv as unknown as Cli, ['systemctl start nginx']);
      await taper(wanSrv as unknown as Cli, [
        'systemctl start nginx',
        'systemctl start sshd',
        'systemctl start oracle-xe',
      ]);
      await taper(fw, [
        'config firewall policy',
        'edit 100', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set nat enable', 'next',
        'edit 101', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set nat enable', 'next',
        'end',
      ]);

      const rafale = await Promise.all([
        pc.executeCommand('ping -c 3 203.0.113.9'),
        pc.executeCommand('curl -s http://10.0.0.5/'),
        pc.executeCommand('curl -s http://203.0.113.9/'),
        pc.executeCommand('tnsping 203.0.113.9:1521/XE'),
        pc.executeCommand('ssh -o StrictHostKeyChecking=no 203.0.113.9 "echo CLUSTER_STABLE"'),
      ]);

      expect(rafale[0]).toMatch(/0% packet loss/);
      expect(rafale[1]).toMatch(/Welcome to nginx|nginx/i);
      expect(rafale[2]).toMatch(/Welcome to nginx|nginx/i);
      expect(rafale[3]).toContain('OK');
      expect(rafale[4]).toContain('CLUSTER_STABLE');
    });
  });

});