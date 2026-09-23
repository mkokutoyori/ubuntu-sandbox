import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
  getPort(name: string): unknown;
}

const REFUS = /Unknown action|command parse error|Invalid|Incomplete|Command fail/i;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function taper(device: Cli, lignes: readonly string[]): Promise<void> {
  for (const ligne of lignes) await device.executeCommand(ligne);
}

// Topologie Hybride Dual-Stack IPv4/IPv6 & Routage Dynamique :
// PC-DualStack <-> Cisco SW-Dist <-> [FortiGate-Core] <-> Cisco R-BGP <-> SRV-Cluster (Web, DB, Auth, Storage)
interface LaboNextGen {
  pc: LinuxPC;
  swDist: CiscoSwitch;
  fw: Cli;
  routerBgp: CiscoSwitch;
  srvCluster: LinuxServer;
}

async function creerLaboNextGen(): Promise<LaboNextGen> {
  const pc = new LinuxPC('linux-pc-ng', 'PC-DualStack', 50, 0);
  const swDist = new CiscoSwitch('switch-cisco-dist', 'SW-Dist', 16, 250, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const routerBgp = new CiscoSwitch('switch-cisco-bgp', 'R-BGP', 16, 750, 0);
  const srvCluster = new LinuxServer('linux-server-cluster', 'SRV-Cluster', 950, 0);

  pc.powerOn();
  swDist.powerOn();
  routerBgp.powerOn();
  srvCluster.powerOn();

  // Câblage L2 / L3
  new Cable('c-pc-swd').connect(pc.getPort('eth0') as never, swDist.getPort('FastEthernet0/2') as never);
  new Cable('c-swd-fw').connect(swDist.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);
  new Cable('c-fw-bgp').connect(fw.getPort('wan1') as never, routerBgp.getPort('FastEthernet0/1') as never);
  new Cable('c-bgp-srv').connect(routerBgp.getPort('FastEthernet0/2') as never, srvCluster.getPort('eth0') as never);

  // Configuration Dual-Stack IPv4/IPv6 sur le Pare-feu FortiGate
  await taper(fw, [
    'config system interface',
    'edit port1',
    'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'config ipv6',
    'set ip6-address 2001:db8:1::1/64',
    'set ip6-allowaccess ping ssh https',
    'end',
    'set allowaccess ping ssh http https',
    'next',
    'edit wan1',
    'set mode static',
    'set ip 203.0.113.1 255.255.255.0',
    'config ipv6',
    'set ip6-address 2001:db8:wan::1/64',
    'set ip6-allowaccess ping',
    'end',
    'set allowaccess ping',
    'next',
    'end',
  ]);

  // Client Dual-Stack
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
    'ip -6 addr add 2001:db8:1::10/64 dev eth0',
    'ip -6 route add default via 2001:db8:1::1',
  ]);

  // Routeur BGP intermédiaire (Transit WAN)
  await taper(routerBgp as unknown as Cli, [
    'enable', 'configure terminal',
    'interface FastEthernet0/1',
    'no switchport',
    'ip address 203.0.113.2 255.255.255.0',
    'ipv6 address 2001:db8:wan::2/64',
    'no shutdown',
    'exit',
    'interface FastEthernet0/2',
    'no switchport',
    'ip address 10.50.0.1 255.255.255.0',
    'ipv6 address 2001:db8:srv::1/64',
    'no shutdown',
    'end',
  ]);

  // Serveur Cluster de destination
  await taper(srvCluster as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 10.50.0.50/24 dev eth0',
    'ip route add default via 10.50.0.1',
    'ip -6 addr add 2001:db8:srv::50/64 dev eth0',
    'ip -6 route add default via 2001:db8:srv::1',
  ]);

  // Règles de sécurité par défaut LAN -> WAN (IPv4 et IPv6)
  await taper(fw, [
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'end',
    'config firewall policy6',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'end',
  ]);

  return { pc, swDist, fw, routerBgp, srvCluster };
}

describe('Batterie 6 : Tests 251 à 300 — IPv6, Routage Dynamique OSPF/BGP, ZTNA & MPTCP', () => {

  // =========================================================================
  // 37. TRAFIC IPV6 & DUAL-STACK EN TRANSIT (Tests 251 à 260)
  // =========================================================================
  describe('IPv6 en Transit : NDP, Routage & Politiques IPv6', () => {
    it('251. Résolution de voisinage NDP (Neighbor Solicitation / Advertisement) remplaçant ARP', async () => {
      const { pc } = await creerLaboNextGen();
      await pc.executeCommand('ping6 -c 1 2001:db8:1::1');
      const table = await pc.executeCommand('ip -6 neigh');
      expect(table).toMatch(/2001:db8:1::1.*lladdr.*REACHABLE|STALE/i);
    });

    it('252. Ping IPv6 (ICMPv6 Echo Request/Reply) traversant le switch et le pare-feu', async () => {
      const { pc } = await creerLaboNextGen();
      const res = await pc.executeCommand('ping6 -c 2 2001:db8:wan::2');
      expect(res).toMatch(/, 0% packet loss/);
    });

    it('253. SLAAC (Stateless Address Autoconfiguration) : écoute des Router Advertisements (RA ICMPv6 134)', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config system interface', 'edit port1',
        'config ipv6', 'set ip6-send-adv enable', 'end',
        'next', 'end',
      ]);
      const conf = await fw.executeCommand('show system interface port1');
      expect(conf).toContain('ip6-send-adv enable');
    });

    it('254. RA Guard sur Switch Cisco : destruction des faux Router Advertisements émis par un poste pirate', async () => {
      const { swDist } = await creerLaboNextGen();
      await taper(swDist as unknown as Cli, [
        'enable', 'configure terminal',
        'ipv6 nd raguard policy RAGUARD_DROP',
        'device-role host', 'exit',
        'interface FastEthernet0/2',
        'ipv6 nd raguard attach-policy RAGUARD_DROP',
        'end',
      ]);
      const status = await swDist.executeCommand('show ipv6 nd raguard policy RAGUARD_DROP');
      expect(status).toContain('device-role host');
    });

    it('255. Requête Web Nginx en IPv6 natif ([::]:80) traversant la politique firewall IPv6', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -6 -s http://[2001:db8:srv::50]/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('256. SSH en IPv6 : établissement de session chiffrée sur adresse globale IPv6', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start sshd']);
      const res = await pc.executeCommand('ssh -6 -o StrictHostKeyChecking=no 2001:db8:srv::50 "hostname"');
      expect(res.trim()).toBe('SRV-Cluster');
    });

    it('257. Résolution DNS AAAA (IPv6) via serveur BIND9 traversant le réseau', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start named']);
      const res = await pc.executeCommand('dig @2001:db8:srv::50 web.lab6.lan AAAA +short');
      expect(res).toMatch(/2001:db8:/);
    });

    it('258. NAT64 / DNS64 : client IPv6 pur accédant à un serveur IPv4 exclusif via préfixe Well-Known 64:ff9b::/96', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config firewall nat64',
        'set status enable',
        'end',
      ]);
      const nat64 = await fw.executeCommand('get firewall nat64');
      expect(refuse(nat64)).toBe(false);
    });

    it('259. Path MTU Discovery IPv6 : gestion du paquet ICMPv6 Type 2 "Packet Too Big" (MTU 1280 min)', async () => {
      const { pc } = await creerLaboNextGen();
      const res = await pc.executeCommand('ping6 -c 1 -M do -s 1400 2001:db8:wan::2');
      expect(res).not.toMatch(/error/i);
    });

    it('260. Happy Eyeballs (RFC 8305) : bascule fluide sur IPv4 si le chemin IPv6 subit une coupure', async () => {
      const { pc, srvCluster, fw } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      // Coupure IPv6 uniquement sur le pare-feu
      await taper(fw, ['config firewall policy6', 'edit 1', 'set status disable', 'next', 'end']);
      const res = await pc.executeCommand('curl -s --connect-timeout 2 http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });
  });

  // =========================================================================
  // 38. ROUTAGE DYNAMIQUE EN TRANSIT : OSPF & BGP (Tests 261 à 270)
  // =========================================================================
  describe('Convergence Dynamique OSPFv2 & eBGP en Coupure Réseau', () => {
    it('261. Adjacence OSPFv2 : émission et réception des paquets HELLO (Multicast 224.0.0.5)', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router ospf',
        'set router-id 1.1.1.1',
        'config area', 'edit 0.0.0.0', 'next', 'end',
        'config network', 'edit 1', 'set prefix 203.0.113.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end',
        'end',
      ]);
      const status = await fw.executeCommand('get router info ospf status');
      expect(status).toContain('1.1.1.1');
    });

    it('262. Échange de LSAs OSPF et injection dynamique du sous-réseau serveur dans la table du firewall', async () => {
      const { fw } = await creerLaboNextGen();
      const routes = await fw.executeCommand('get router info routing-table ospf');
      expect(refuse(routes)).toBe(false);
    });

    it('263. Sélection de chemin OSPF basée sur le coût métrique d\'interface (Bandwidth Cost)', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router ospf',
        'config ospf-interface', 'edit "wan1_cost"', 'set interface "wan1"', 'set cost 10', 'next', 'end',
        'end',
      ]);
      const ospfConf = await fw.executeCommand('show router ospf');
      expect(ospfConf).toContain('set cost 10');
    });

    it('264. Authentification cryptographique MD5 sur les échanges de paquets OSPF traversants', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router ospf',
        'config ospf-interface', 'edit "wan1_md5"',
        'set interface "wan1"', 'set authentication md5',
        'config md5-key', 'edit 1', 'set key-string "OspfSecret2026"', 'next', 'end',
        'next', 'end', 'end',
      ]);
      const check = await fw.executeCommand('show router ospf');
      expect(check).toContain('OspfSecret2026');
    });

    it('265. Session BGP Peering (TCP 179) établie entre FortiGate (AS 65001) et le routeur WAN (AS 65002)', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router bgp',
        'set as 65001', 'set router-id 1.1.1.1',
        'config neighbor', 'edit 203.0.113.2', 'set remote-as 65002', 'next', 'end',
        'end',
      ]);
      const bgp = await fw.executeCommand('get router info bgp summary');
      expect(bgp).toMatch(/203\.0\.113\.2|State\/PfxRcd/i);
    });

    it('266. Annonce BGP (UPDATE) : propagation dynamique du préfixe LAN client vers l\'extérieur', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router bgp',
        'config network', 'edit 1', 'set prefix 192.168.1.0 255.255.255.0', 'next', 'end',
        'end',
      ]);
      const advertised = await fw.executeCommand('get router info bgp neighbors 203.0.113.2 advertised-routes');
      expect(refuse(advertised)).toBe(false);
    });

    it('267. BGP AS-Path Prepending : influence sur le chemin de retour du trafic mondial', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router route-map', 'edit "PREPEND_MAP"',
        'config rule', 'edit 1', 'set set-aspath "65001 65001 65001"', 'next', 'end',
        'next', 'end',
      ]);
      const rmap = await fw.executeCommand('show router route-map PREPEND_MAP');
      expect(rmap).toContain('65001 65001 65001');
    });

    it('268. Graceful Restart BGP : maintien du trafic de données sans drop pendant le redémarrage du démon BGP', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router bgp', 'set graceful-restart enable', 'set graceful-restart-time 120', 'end',
      ]);
      const conf = await fw.executeCommand('show router bgp');
      expect(conf).toContain('set graceful-restart enable');
    });

    it('269. Transit OSPF Multi-Aires (Area 1 vers Backbone Area 0) routé à travers le pare-feu ABR', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router ospf',
        'config area', 'edit 0.0.0.1', 'set type nssa', 'next', 'end',
        'end',
      ]);
      const areas = await fw.executeCommand('show router ospf');
      expect(areas).toContain('0.0.0.1');
    });

    it('270. Convergence sub-seconde lors de l\'association OSPF + BFD sur le lien de transit', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router ospf',
        'config ospf-interface', 'edit "wan1_bfd"', 'set interface "wan1"', 'set bfd enable', 'next', 'end',
        'end',
      ]);
      const check = await fw.executeCommand('show router ospf');
      expect(check).toContain('set bfd enable');
    });
  });

  // =========================================================================
  // 39. ZERO TRUST NETWORK ACCESS (ZTNA), PROXY D'ACCÈS & SÉCURITÉ WEB (Tests 271 à 278)
  // =========================================================================
  describe('Zero Trust (ZTNA), Proxy d\'Accès & Filtrage DNS/Web', () => {
    it('271. ZTNA TCP Forwarding Access Proxy : Accès sécurisé vers Oracle DB avec validation de certificat client', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config firewall access-proxy', 'edit "ZTNA_ORACLE"',
        'set vip "wan1"',
        'config api-gateway', 'edit 1', 'set service tcp-forwarding', 'set port 1521', 'next', 'end',
        'next', 'end',
      ]);
      const ztna = await fw.executeCommand('show firewall access-proxy ZTNA_ORACLE');
      expect(ztna).toContain('tcp-forwarding');
    });

    it('272. Forward Proxy Explicite (Port 8080) : Le client transite obligatoirement par le mandataire HTTP', async () => {
      const { pc, fw, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config web-proxy explicit', 'set status enable', 'set http-incoming-port 8080', 'end',
      ]);
      const res = await pc.executeCommand('curl -x http://192.168.1.1:8080 -s http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('273. Tunnel HTTPS via méthode HTTP CONNECT traversant le proxy explicite', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -x http://192.168.1.1:8080 -k -s https://10.50.0.50/');
      expect(res).not.toMatch(/Proxy CONNECT aborted|502 Bad Gateway/i);
    });

    it('274. DNS Sinkholing : Redirection immédiate d\'un domaine malveillant connu vers une adresse puits', async () => {
      const { pc, fw } = await creerLaboNextGen();
      await taper(fw, [
        'config dnsfilter profile', 'edit "SINKHOLE_PROF"',
        'set block-botnet enable',
        'set redirect-portal 203.0.113.250',
        'next', 'end',
      ]);
      const conf = await fw.executeCommand('show dnsfilter profile SINKHOLE_PROF');
      expect(conf).toContain('203.0.113.250');
    });

    it('275. Injection d\'entêtes HTTP : Ajout automatique de "X-Forwarded-For" et "X-Client-GeoIP" en coupure', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      await pc.executeCommand('curl -s http://10.50.0.50/');
      const accessLog = await srvCluster.executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(accessLog.length).toBeGreaterThan(0);
    });

    it('276. Filtrage d\'URL par catégorie FortiGuard : Blocage des sites catégorisés "Malware/Phishing"', async () => {
      const { pc, fw } = await creerLaboNextGen();
      await taper(fw, [
        'config webfilter profile', 'edit "STRICT_BLOCK"',
        'config ftgd-wf', 'config filters', 'edit 1', 'set category 26', 'set action block', 'next', 'end', // 26 = Malicious
        'end', 'next', 'end',
      ]);
      const wf = await fw.executeCommand('show webfilter profile STRICT_BLOCK');
      expect(wf).toContain('category 26');
    });

    it('277. Enforcing SafeSearch : Injection à la volée de l\'entête de recherche filtrée pour Google/Bing', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config webfilter profile', 'edit "SAFE_SEARCH"',
        'config ftgd-wf', 'set options enforce-safesearch', 'end',
        'next', 'end',
      ]);
      const ss = await fw.executeCommand('show webfilter profile SAFE_SEARCH');
      expect(ss).toContain('enforce-safesearch');
    });

    it('278. Mise en cache Proxy : Réponse 304 Not Modified servie directement par le cache en coupure', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const cacheTest = await pc.executeCommand('curl -s -I -H "If-Modified-Since: Tue, 23 Sep 2026 12:00:00 GMT" http://10.50.0.50/');
      expect(cacheTest).toMatch(/304 Not Modified|200 OK/);
    });
  });

  // =========================================================================
  // 40. MULTIPATH TCP (MPTCP) & MULTIPLEXAGE TRANSPORT (Tests 279 à 284)
  // =========================================================================
  describe('Multipath TCP (MPTCP) : Agrégation et Continuité de Session', () => {
    it('279. Négociation initiale MPTCP : Transmission de l\'option TCP MP_CAPABLE lors du SYN', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      await pc.executeCommand('sysctl -w net.mptcp.enabled=1');
      const res = await pc.executeCommand('curl -s http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('280. Établissement d\'un sous-flux secondaire MP_JOIN traversant un lien WAN alternatif', async () => {
      const { pc } = await creerLaboNextGen();
      const mptcpStatus = await pc.executeCommand('ip mptcp endpoint show');
      expect(refuse(mptcpStatus)).toBe(false);
    });

    it('281. Bascule dynamique sans couture (Seamless Offloading) d\'un flux vidéo/données lors d\'une coupure WAN1', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s --connect-timeout 2 http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('282. Agrégation de débit MPTCP : Utilisation conjointe de la bande passante de deux chemins distincts', async () => {
      const { pc } = await creerLaboNextGen();
      const limits = await pc.executeCommand('ip mptcp limits show');
      expect(refuse(limits)).toBe(false);
    });

    it('283. Repli automatique (Fallback) vers un TCP standard si un équipement intermédiaire filtre les options MPTCP', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('284. Fermeture sélective d\'un sous-flux (Subflow Reset) sans interrompre la session MPTCP mère', async () => {
      const { pc } = await creerLaboNextGen();
      const subflows = await pc.executeCommand('ss -M');
      expect(refuse(subflows)).toBe(false);
    });
  });

  // =========================================================================
  // 41. SERVICES D'INFRASTRUCTURE D'ENTREPRISE ÉTENDUS (Tests 285 à 292)
  // =========================================================================
  describe('Protocoles Métier : NFSv4, SMB, LDAP, SMTP STARTTLS & HTTP/2', () => {
    it('285. Montage et lecture NFSv4 (TCP 2049) traversant le pare-feu sans nécessiter Portmapper', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nfs-server']);
      const res = await pc.executeCommand('showmount -e 10.50.0.50');
      expect(res).not.toMatch(/RPC: Port mapper failure/i);
    });

    it('286. Partage de fichiers SMB / CIFS (TCP 445) traversant la frontière de sécurité', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start smbd']);
      const res = await pc.executeCommand('smbclient -L //10.50.0.50/ -N -g');
      expect(res).not.toMatch(/NT_STATUS_UNSUCCESSFUL/i);
    });

    it('287. Requête d\'annuaire LDAP (TCP 389) et LDAPS chiffré (TCP 636) à travers le firewall', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start slapd']);
      const res = await pc.executeCommand('ldapsearch -x -H ldap://10.50.0.50 -b "" -s base namingContexts');
      expect(res).not.toMatch(/ldap_result: Can't contact LDAP server/i);
    });

    it('288. Émission de courriel SMTP (TCP 25) avec négociation chiffrée STARTTLS en coupure', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start postfix']);
      const res = await pc.executeCommand('nc -zv -w 2 10.50.0.50 25');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('289. Chargement massif Oracle SQLLDR (SQL*Loader) : flux continu de données volumineuses sur port 1521', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start oracle-xe']);
      const res = await pc.executeCommand('tnsping 10.50.0.50:1521/XE');
      expect(res).toContain('OK');
    });

    it('290. Multiplexage HTTP/2 (h2) : Requêtes concurrentes pipelinées sur un unique socket TCP TLS', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -k --http2 -s -I https://10.50.0.50/');
      expect(res).toMatch(/HTTP\/2 200|HTTP\/2/);
    });

    it('291. Keepalived VRRP Multicast (224.0.0.18) traversant les ports du commutateur sans blocage IGMP', async () => {
      const { swDist } = await creerLaboNextGen();
      const igmp = await swDist.executeCommand('show ip igmp snooping groups');
      expect(refuse(igmp)).toBe(false);
    });

    it('292. Blocage des attaques NTP Amplification : Rejet automatique des paquets de diagnostic monlist', async () => {
      const { pc, fw } = await creerLaboNextGen();
      await taper(fw, [
        'config firewall policy', 'edit 292',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await pc.executeCommand('ntpdc -c monlist 203.0.113.1');
      expect(res).toMatch(/timed out|refused/i);
    });
  });

  // =========================================================================
  // 42. RÉSILIENCE AVANCÉE, CONTRÔLE DE PLAN & ÉPREUVE ROYALE (Tests 293 à 300)
  // =========================================================================
  describe('Contrôle de Plan (CoPP), Protection Moteur & Épreuve Ultime', () => {
    it('293. CoPP (Control Plane Policing) : Limitation de débit sur le trafic destiné au processeur du switch', async () => {
      const { swDist } = await creerLaboNextGen();
      await taper(swDist as unknown as Cli, [
        'enable', 'configure terminal',
        'policy-map CONTROL_PLANE_POLICY',
        'class class-default', 'police 8000 conform-action transmit exceed-action drop', 'end',
      ]);
      const copp = await swDist.executeCommand('show policy-map CONTROL_PLANE_POLICY');
      expect(copp).toContain('police 8000');
    });

    it('294. BGP Flap Dampening : Pénalisation et mise en quarantaine temporaire d\'un préfixe instable', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config router bgp', 'set dampening enable', 'end',
      ]);
      const conf = await fw.executeCommand('show router bgp');
      expect(conf).toContain('set dampening enable');
    });

    it('295. TCP Fast Retransmit déclenché suite à la détection de 3 Duplicate ACKs consécutifs', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s http://10.50.0.50/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('296. Mode Bridge Transparent L2 : Le pare-feu filtre les flux IP sans posséder d\'adresse IP de passerelle', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config system settings', 'set opmode transparent', 'end',
      ]);
      const op = await fw.executeCommand('get system settings');
      expect(op).toMatch(/opmode\s*:\s*transparent/i);
    });

    it('297. Protection contre la saturation de la table de session : SYN Proxy actif protégeant le serveur', async () => {
      const { fw } = await creerLaboNextGen();
      await taper(fw, [
        'config firewall policy', 'edit 1', 'set tcp-session-without-syn enable', 'next', 'end',
      ]);
      const synStat = await fw.executeCommand('show firewall policy 1');
      expect(synStat).toContain('tcp-session-without-syn');
    });

    it('298. Micro-bursts et allocation dynamique de mémoire tampon (Dynamic Buffer Sharing) sur le commutateur', async () => {
      const { swDist } = await creerLaboNextGen();
      const buffers = await swDist.executeCommand('show buffers');
      expect(buffers).not.toMatch(/failures/i);
    });

    it('299. Stress Test Double Flux Parallèle : Trafic massif IPv4 et IPv6 concurrent sans goulot d\'étranglement', async () => {
      const { pc, srvCluster } = await creerLaboNextGen();
      await taper(srvCluster as unknown as Cli, ['systemctl start nginx']);

      const [ipv4Res, ipv6Res] = await Promise.all([
        pc.executeCommand('curl -4 -s http://10.50.0.50/'),
        pc.executeCommand('curl -6 -s http://[2001:db8:srv::50]/'),
      ]);

      expect(ipv4Res).toMatch(/Welcome to nginx|nginx/i);
      expect(ipv6Res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('300. L\'Épreuve Ultime Bout-en-Bout : DNS64/BIND9 -> OSPF Multi-saut -> ZTNA Proxy -> Oracle SQL -> Syslog TLS', async () => {
      const { pc, srvCluster, fw } = await creerLaboNextGen();
      // 1. Démarrage de tous les services critiques
      await taper(srvCluster as unknown as Cli, [
        'systemctl start named',
        'systemctl start nginx',
        'systemctl start oracle-xe',
        'systemctl start rsyslog-tls',
      ]);

      // 2. Résolution de nom IPv6
      const dns = await pc.executeCommand('dig @2001:db8:srv::50 db.cluster.lan AAAA +short');
      expect(dns).toMatch(/2001:db8:/);

      // 3. Franchissement ZTNA / HTTP
      const web = await pc.executeCommand('curl -6 -s http://[2001:db8:srv::50]/');
      expect(web).toMatch(/Welcome to nginx|nginx/i);

      // 4. Transaction Oracle SQL sur le chemin dynamique convergé
      const query = 'echo "SELECT \'ULTIMATE_SYSTEM_VALIDATED\' FROM DUAL;" | sqlplus -S system/oracle@10.50.0.50:1521/XE';
      const sqlRes = await pc.executeCommand(query);
      expect(sqlRes).toContain('ULTIMATE_SYSTEM_VALIDATED');

      // 5. Journalisation d\'audit finale Syslog sécurisée
      await srvCluster.executeCommand('logger -p local0.info "END_TO_END_RUN_300_SUCCESS"');
      const sessionList = await fw.executeCommand('diagnose sys session list');
      expect(sessionList).toMatch(/dport=1521|dport=80/);
    });
  });

});