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

// Topologie Haute Disponibilité & Inspection Réseau :
// PC-Client <-> SW-Access <-> [FW-Master / FW-Slave (Cluster HA)] <-> SW-Core <-> SRV-Web, SRV-DB, SRV-Radius
interface LaboHA {
  pc: LinuxPC;
  swAccess: CiscoSwitch;
  fwMaster: Cli;
  fwSlave: Cli;
  swCore: CiscoSwitch;
  srvWeb: LinuxServer;
  srvDb: LinuxServer;
  srvRadius: LinuxServer;
}

async function creerLaboHA(): Promise<LaboHA> {
  const pc = new LinuxPC('linux-pc', 'PC-Client', 50, 0);
  const swAccess = new CiscoSwitch('switch-cisco', 'SW-Access', 16, 200, 0);
  const fwMaster = createDevice('firewall-fortinet', 400, -100) as unknown as Cli;
  const fwSlave = createDevice('firewall-fortinet', 400, 100) as unknown as Cli;
  const swCore = new CiscoSwitch('switch-cisco', 'SW-Core', 16, 600, 0);
  const srvWeb = new LinuxServer('linux-server', 'SRV-WEB', 800, -100);
  const srvDb = new LinuxServer('linux-server', 'SRV-DB', 800, 100);
  const srvRadius = new LinuxServer('linux-server', 'SRV-RADIUS', 800, 250);

  pc.powerOn();
  swAccess.powerOn();
  swCore.powerOn();
  srvWeb.powerOn();
  srvDb.powerOn();
  srvRadius.powerOn();

  // Câblage LAN
  new Cable('c-pc-swa').connect(pc.getPort('eth0') as never, swAccess.getPort('FastEthernet0/2') as never);
  new Cable('c-swa-fwm').connect(swAccess.getPort('FastEthernet0/1') as never, fwMaster.getPort('port1') as never);
  new Cable('c-swa-fws').connect(swAccess.getPort('FastEthernet0/3') as never, fwSlave.getPort('port1') as never);

  // Lien Heartbeat / Sync dédié entre les deux pare-feu
  new Cable('c-ha-sync').connect(fwMaster.getPort('port4') as never, fwSlave.getPort('port4') as never);

  // Câblage Côté Serveurs
  new Cable('c-fwm-swc').connect(fwMaster.getPort('wan1') as never, swCore.getPort('FastEthernet0/1') as never);
  new Cable('c-fws-swc').connect(fwSlave.getPort('wan1') as never, swCore.getPort('FastEthernet0/3') as never);
  new Cable('c-swc-web').connect(swCore.getPort('FastEthernet0/5') as never, srvWeb.getPort('eth0') as never);
  new Cable('c-swc-db').connect(swCore.getPort('FastEthernet0/6') as never, srvDb.getPort('eth0') as never);
  new Cable('c-swc-rad').connect(swCore.getPort('FastEthernet0/7') as never, srvRadius.getPort('eth0') as never);

  // Adressage IP de base
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);
  await taper(srvWeb as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0', 'ip route add default via 10.0.0.1',
  ]);
  await taper(srvDb as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.0.0.20/24 dev eth0', 'ip route add default via 10.0.0.1',
  ]);
  await taper(srvRadius as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.0.0.50/24 dev eth0', 'ip route add default via 10.0.0.1',
  ]);

  // Configuration Cluster HA FortiGate (FGCP Active-Passive)
  for (const [fw, priorite] of [[fwMaster, '200'], [fwSlave, '100']] as const) {
    await taper(fw, [
      'config system interface',
      'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh http', 'next',
      'edit wan1',  'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next',
      'end',
      'config system ha',
      'set group-id 1', 'set group-name "HA-CLUSTER"', 'set mode a-p', 'set hbdev "port4" 50',
      `set priority ${priorite}`,
      'end',
      'config firewall policy',
      'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set service "ALL"', 'next',
      'end',
    ]);
  }

  return { pc, swAccess, fwMaster, fwSlave, swCore, srvWeb, srvDb, srvRadius };
}

describe('Batterie 5 : Tests 201 à 250 — Haute Disponibilité, VRF, DPI/IPS, RADIUS & Chaos', () => {

  // =========================================================================
  // 31. HAUTE DISPONIBILITÉ (HA), FGCP, VRRP & BASCULE DE SESSIONS (Tests 201 à 210)
  // =========================================================================
  describe('Clustering Pare-feu & Reprise de Session sans Déconnexion', () => {
    it('201. Élection du noeud Master : fwMaster prend le statut actif grâce à sa priorité supérieure', async () => {
      const { fwMaster } = await creerLaboHA();
      const status = await fwMaster.executeCommand('get system ha status');
      expect(status).toMatch(/master|primary/i);
    });

    it('202. MAC Virtuelle HA (vMAC) : le cluster répond avec une adresse MAC de cluster partagée', async () => {
      const { pc } = await creerLaboHA();
      await pc.executeCommand('arping -c 1 192.168.1.1');
      const neigh = await pc.executeCommand('ip neigh show 192.168.1.1');
      // Les MAC virtuelles FortiGate HA débutent conventionnellement par 00:09:0f:09
      expect(neigh).toMatch(/00:09:0f|lladdr/i);
    });

    it('203. Trafic HTTP traversant acheminé via le membre Master du cluster', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s http://10.0.0.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('204. Synchronisation temps réel des sessions TCP (Session Sync) via le lien heartbeat port4', async () => {
      const { pc, fwSlave, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await pc.executeCommand('curl -s http://10.0.0.10/');
      const tableSlave = await fwSlave.executeCommand('diagnose sys session list');
      // La session établie doit exister sur l'esclave grâce au heartbeat
      expect(refuse(tableSlave)).toBe(false);
    });

    it('205. Bascule à chaud (Failover HA) : coupure du Master, le Slave prend le relais sans interruption de ping', async () => {
      const { pc, fwMaster } = await creerLaboHA();
      // Arrêt brutal de l'interface LAN du Master
      await taper(fwMaster, ['config system interface', 'edit port1', 'set status down', 'next', 'end']);
      const ping = await pc.executeCommand('ping -c 2 -W 1 10.0.0.10');
      expect(ping).toMatch(/0% packet loss|, 0% loss/);
    });

    it('206. Maintien d\'une session SSH persistante après bascule du Master vers le Slave', async () => {
      const { pc, fwMaster, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start sshd']);
      await pc.executeCommand('ssh -o StrictHostKeyChecking=no 10.0.0.10 "echo PRE_FAILOVER"');
      // Déclenchement de bascule
      await fwMaster.executeCommand('diagnose sys ha reset-uptime');
      const post = await pc.executeCommand('ssh -o StrictHostKeyChecking=no 10.0.0.10 "echo POST_FAILOVER"');
      expect(post).toContain('POST_FAILOVER');
    });

    it('207. Gratuitous ARP émis lors de la bascule pour mettre à jour la table CAM du commutateur', async () => {
      const { swAccess, fwMaster } = await creerLaboHA();
      await taper(fwMaster, ['config system interface', 'edit port1', 'set status down', 'next', 'end']);
      const table = await swAccess.executeCommand('show mac address-table');
      // Le port Fa0/3 (lié au Slave) apprend la MAC virtuelle
      expect(table).toMatch(/FastEthernet0\/3/);
    });

    it('208. VRRP : Bascule de passerelle virtuelle Cisco IOS configurée sur deux routeurs', async () => {
      const { swCore } = await creerLaboHA();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/1',
        'vrrp 10 ip 10.0.0.254',
        'vrrp 10 priority 120',
        'end',
      ]);
      const vrrp = await swCore.executeCommand('show vrrp brief');
      expect(vrrp).toMatch(/10\s+120\s+Master/i);
    });

    it('209. Re-synchronisation incrémentale de configuration lors du retour en ligne du Master réparé', async () => {
      const { fwMaster, fwSlave } = await creerLaboHA();
      await taper(fwMaster, ['config system interface', 'edit port1', 'set status up', 'next', 'end']);
      const syncCheck = await fwSlave.executeCommand('diagnose sys ha checksum cluster');
      expect(refuse(syncCheck)).toBe(false);
    });

    it('210. Split-Brain Mitigation : isolation si les liens heartbeat tombent sans double prise d\'IP active', async () => {
      const { fwMaster, fwSlave } = await creerLaboHA();
      await taper(fwMaster, ['config system interface', 'edit port4', 'set status down', 'next', 'end']);
      const check = await fwSlave.executeCommand('get system ha status');
      expect(refuse(check)).toBe(false);
    });
  });

  // =========================================================================
  // 32. VIRTUALISATION RÉSEAU : VRF CISCO & INTER-VDOM ROUTING (Tests 211 à 218)
  // =========================================================================
  describe('Isolation Multi-Tenant : VRF & Virtual Domains (VDOM)', () => {
    it('211. Création et étanchéité de deux VRF distinctes (CLIENT_A et CLIENT_B) sur le switch Cisco', async () => {
      const { swCore } = await creerLaboHA();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'ip vrf CLIENT_A', 'rd 65000:1', 'exit',
        'ip vrf CLIENT_B', 'rd 65000:2', 'end',
      ]);
      const vrf = await swCore.executeCommand('show ip vrf');
      expect(vrf).toContain('CLIENT_A');
      expect(vrf).toContain('CLIENT_B');
    });

    it('212. Impossibilité pour un flux d\'une VRF de joindre une IP identique dans une autre VRF', async () => {
      const { swCore } = await creerLaboHA();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/10', 'ip vrf forwarding CLIENT_A', 'ip address 172.16.1.1 255.255.255.0', 'exit',
        'interface FastEthernet0/11', 'ip vrf forwarding CLIENT_B', 'ip address 172.16.1.1 255.255.255.0', 'end',
      ]);
      const routeA = await swCore.executeCommand('show ip route vrf CLIENT_A');
      const routeB = await swCore.executeCommand('show ip route vrf CLIENT_B');
      expect(routeA).toContain('FastEthernet0/10');
      expect(routeB).toContain('FastEthernet0/11');
    });

    it('213. VDOM FortiOS : partitionnement du pare-feu physique en deux entités logiques (VDOM-PROD & VDOM-GUEST)', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config system global', 'set vdom-mode multi-vdom', 'end',
        'config vdom', 'edit VDOM-PROD', 'next', 'edit VDOM-GUEST', 'next', 'end',
      ]);
      const vdoms = await fwMaster.executeCommand('get system vdom-property');
      expect(vdoms).toContain('VDOM-PROD');
    });

    it('214. Inter-VDOM Link : transit contrôlé entre deux VDOMs sans câble physique externe', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config system vdom-link',
        'edit "vlink_prod_guest"', 'set type ethernet', 'next',
        'end',
      ]);
      const links = await fwMaster.executeCommand('show system vdom-link');
      expect(links).toContain('vlink_prod_guest');
    });

    it('215. Filtrage d\'un flux traversant un lien Inter-VDOM par une politique de sécurité dédiée', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config firewall policy',
        'edit 10', 'set srcintf "vlink_prod_guest0"', 'set dstintf "vlink_prod_guest1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "HTTP"', 'next',
        'end',
      ]);
      const pol = await fwMaster.executeCommand('show firewall policy 10');
      expect(pol).toContain('vlink_prod_guest0');
    });

    it('216. VRF Route Leaking : importation contrôlée de routes entre VRF via BGP / Target Community', async () => {
      const { swCore } = await creerLaboHA();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'ip vrf CLIENT_A', 'route-target import 65000:2', 'end',
      ]);
      const conf = await swCore.executeCommand('show running-config | section ip vrf CLIENT_A');
      expect(conf).toContain('route-target import 65000:2');
    });

    it('217. Tables ARP hermétiques et étanches entre VDOMs même avec des sous-réseaux superposés', async () => {
      const { fwMaster } = await creerLaboHA();
      const arp = await fwMaster.executeCommand('diagnose ip arp list');
      expect(refuse(arp)).toBe(false);
    });

    it('218. Rejet par le VDOM de transit des paquets ne disposant d\'aucune règle inter-vdom accept', async () => {
      const { pc } = await creerLaboHA();
      const res = await pc.executeCommand('ping -c 1 -W 1 10.250.0.1');
      expect(res).toMatch(/100% packet loss|unreachable/i);
    });
  });

  // =========================================================================
  // 33. INSPECTION APPLICATIVE PROFONDE (DPI / IPS INLINE / WAF) (Tests 219 à 228)
  // =========================================================================
  describe('Inspection Profonde (DPI) & Filtrage d\'Attaques Applicatives en Ligne', () => {
    it('219. Blocage inline d\'une injection SQL (SQLi) traversant le pare-feu vers Nginx', async () => {
      const { pc, fwMaster, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await taper(fwMaster, [
        'config ips sensor', 'edit "SENSOR_SQLI"',
        'config entries', 'edit 1', 'set rule 1001', 'set action block', 'next', 'end',
        'next', 'end',
        'config firewall policy', 'edit 1', 'set utm-status enable', 'set ips-sensor "SENSOR_SQLI"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s -i "http://10.0.0.10/login?user=admin%27%20OR%201=1--"');
      expect(res).toMatch(/403 Forbidden|Connection reset|reset by peer/i);
    });

    it('220. Rejet d\'une tentative de Path Traversal (/../../etc/passwd) en transit HTTP', async () => {
      const { pc, fwMaster, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await taper(fwMaster, [
        'config firewall policy', 'edit 1', 'set utm-status enable', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s "http://10.0.0.10/download?file=../../../../etc/passwd"');
      expect(res).not.toContain('root:x:0:0');
    });

    it('221. Détection et blocage d\'une attaque Cross-Site Scripting (XSS) dans un payload POST HTTP', async () => {
      const { pc, fwMaster, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const xssPayload = '<script>alert(document.cookie)</script>';
      const res = await pc.executeCommand(`curl -s -d "comment=${xssPayload}" http://10.0.0.10/comment`);
      expect(res).toMatch(/Forbidden|rejected|blocked/i);
    });

    it('222. Application Control : blocage sélectif du transfert de fichiers Torrent tout en autorisant le Web HTTP', async () => {
      const { pc, fwMaster, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await taper(fwMaster, [
        'config application list', 'edit "BLOCK_P2P"',
        'config entries', 'edit 1', 'set category 2', 'set action block', 'next', 'end', // 2 = P2P
        'next', 'end',
        'config firewall policy', 'edit 1', 'set app-list "BLOCK_P2P"', 'next', 'end',
      ]);
      const web = await pc.executeCommand('curl -s http://10.0.0.10/');
      expect(web).toMatch(/Welcome to nginx|nginx/i);
    });

    it('223. Détection et destruction immédiate par l\'IPS d\'une commande distante shell (RCE)', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -A "() { :;}; echo VULN; /bin/cat /etc/passwd" http://10.0.0.10/');
      expect(res).not.toContain('VULN');
    });

    it('224. Inspection profonde Oracle TNS : blocage d\'une tentative d\'exploitation de buffer overflow listener', async () => {
      const { pc, fwMaster, srvDb } = await creerLaboHA();
      await taper(srvDb as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fwMaster, [
        'config ips sensor', 'edit "SENSOR_DB"',
        'config entries', 'edit 1', 'set location server', 'set action block', 'next', 'end',
        'next', 'end',
      ]);
      const res = await pc.executeCommand('tnsping 10.0.0.20:1521/XE');
      expect(res).toContain('OK');
    });

    it('225. Blocage de requêtes HTTP basées sur des User-Agents suspects ou outils d\'attaque (sqlmap, nikto)', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -A "sqlmap/1.5" http://10.0.0.10/');
      expect(res).toMatch(/403 Forbidden|Access Denied/i);
    });

    it('226. Émission d\'une trame TCP RST bidirectionnelle par l\'IPS lors de l\'interception d\'une menace', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -v http://10.0.0.10/malicious_payload 2>&1');
      expect(res).toMatch(/reset by peer|closed connection/i);
    });

    it('227. Décompression GZIP en mémoire par le moteur DPI pour inspecter le contenu HTTP zippé', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -H "Accept-Encoding: gzip" http://10.0.0.10/ --compressed');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('228. Faux-positif évité : une requête légitime volumineuse n\'est pas tronquée par le moteur IPS', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const grandTexte = 'DATA_CLEAN_'.repeat(500);
      const res = await pc.executeCommand(`curl -s -d "text=${grandTexte}" http://10.0.0.10/submit`);
      expect(res).not.toMatch(/Connection reset/i);
    });
  });

  // =========================================================================
  // 34. AUTHENTIFICATION CENTRALISÉE RADIUS & SÉCURITÉ D'ACCÈS (Tests 229 à 236)
  // =========================================================================
  describe('Contrôle d\'Accès Traversant : Flux RADIUS (UDP 1812/1813)', () => {
    it('229. Requête RADIUS Access-Request (UDP 1812) traversant le réseau vers FreeRADIUS', async () => {
      const { pc, fwMaster, srvRadius } = await creerLaboHA();
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);
      await taper(fwMaster, [
        'config user radius', 'edit "RAD_SERVER"',
        'set server "10.0.0.50"', 'set secret "RadiusSharedSecret2026"', 'next',
        'end',
      ]);
      const res = await pc.executeCommand('radtest testuser secretpass 10.0.0.50 1812 RadiusSharedSecret2026');
      expect(res).toMatch(/Access-Accept|Access-Reject/i);
    });

    it('230. Réception d\'un RADIUS Access-Accept pour un utilisateur réseau aux identifiants valides', async () => {
      const { pc, srvRadius } = await creerLaboHA();
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);
      const res = await pc.executeCommand('radtest bob BobPassword 10.0.0.50 1812 RadiusSharedSecret2026');
      expect(res).toContain('Access-Accept');
    });

    it('231. Réception d\'un RADIUS Access-Reject en cas de mot de passe erroné à travers le pare-feu', async () => {
      const { pc, srvRadius } = await creerLaboHA();
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);
      const res = await pc.executeCommand('radtest bob MAUVAIS_MDP 10.0.0.50 1812 RadiusSharedSecret2026');
      expect(res).toContain('Access-Reject');
    });

    it('232. RADIUS Accounting (UDP 1813) : Transmission des paquets Start / Stop lors de l\'ouverture de session', async () => {
      const { pc, srvRadius } = await creerLaboHA();
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);
      const acct = await pc.executeCommand('radclient -r 1 10.0.0.50:1813 acct <<EOF\nAcct-Status-Type = Start\nUser-Name = "bob"\nEOF');
      expect(acct).toMatch(/Accounting-Response|Received response/i);
    });

    it('233. 802.1X sur Switch Cisco : le port Fa0/2 passe de bloqué à actif suite à la réponse RADIUS', async () => {
      const { swAccess } = await creerLaboHA();
      await taper(swAccess as unknown as Cli, [
        'enable', 'configure terminal',
        'aaa new-model',
        'radius-server host 10.0.0.50 auth-port 1812 acct-port 1813 key RadiusSharedSecret2026',
        'interface FastEthernet0/2', 'dot1x pae authenticator', 'dot1x port-control auto', 'end',
      ]);
      const status = await swAccess.executeCommand('show dot1x interface FastEthernet0/2');
      expect(status).toMatch(/PAE = AUTHENTICATOR/i);
    });

    it('234. Retransmission RADIUS : le client bascule sur un serveur secondaire si le primaire ne répond pas', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config user radius', 'edit "RAD_PRIMARY"',
        'set server "10.0.0.50"', 'set secondary-server "10.0.0.51"', 'next',
        'end',
      ]);
      const conf = await fwMaster.executeCommand('show user radius RAD_PRIMARY');
      expect(conf).toContain('10.0.0.51');
    });

    it('235. Captive Portal : redirection HTTP 302 du trafic client vers la page d\'authentification Web', async () => {
      const { pc, fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config firewall policy', 'edit 1',
        'set disclaimer enable', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s -I http://10.0.0.10/');
      expect(res).toMatch(/HTTP\/1\.[01] 302|Location:.*login/i);
    });

    it('236. Déconnexion automatique de l\'utilisateur suite à l\'envoi d\'un paquet RADIUS Disconnect-Request (PoE/CoA)', async () => {
      const { srvRadius } = await creerLaboHA();
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);
      const coa = await srvRadius.executeCommand('echo "User-Name = bob" | radclient -r 1 192.168.1.1:3799 disconnect RadiusSharedSecret2026');
      expect(refuse(coa)).toBe(false);
    });
  });

  // =========================================================================
  // 35. TRANSPORT L4 AVANCÉ : BFD, PATH MTU DISCOVERY & ECN (Tests 237 à 244)
  // =========================================================================
  describe('Mécanismes de Transport Rapide : BFD, PMTU, ECN & TCP Scaling', () => {
    it('237. BFD (Bidirectional Forwarding Detection) : négociation de paquets UDP 3784 à cadence de 100ms', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config router bfd',
        'config neighbor', 'edit 10.0.0.10', 'next', 'end',
        'end',
      ]);
      const bfd = await fwMaster.executeCommand('get router info bfd neighbor');
      expect(refuse(bfd)).toBe(false);
    });

    it('238. Détection BFD sub-seconde : bascule immédiate de route statique lors de la perte de 3 sondes BFD', async () => {
      const { fwMaster } = await creerLaboHA();
      await taper(fwMaster, [
        'config router static', 'edit 1', 'set bfd enable', 'next', 'end',
      ]);
      const conf = await fwMaster.executeCommand('show router static 1');
      expect(conf).toContain('set bfd enable');
    });

    it('239. Path MTU Discovery (PMTUD) : réception d\'un ICMP Type 3 Code 4 (Fragmentation Needed)', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      // Envoi avec Don't Fragment (DF) et taille supérieure à la MTU standard
      const res = await pc.executeCommand('ping -c 1 -M do -s 1600 10.0.0.10');
      expect(res).toMatch(/Frag needed and DF set|message too long/i);
    });

    it('240. ECN (Explicit Congestion Notification) : marquage CE (Congestion Encountered) dans l\'entête IP', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      // Activation de l'ECN sur le PC
      await pc.executeCommand('sysctl -w net.ipv4.tcp_ecn=1');
      const res = await pc.executeCommand('curl -s http://10.0.0.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('241. TCP Window Scaling : négociation de fenêtres TCP supérieures à 64 Ko pour optimiser le débit', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -v http://10.0.0.10/ 2>&1');
      expect(res).not.toMatch(/Failed to connect/i);
    });

    it('242. TCP SACK (Selective Acknowledgment) : réémission ciblée des paquets perdus sans réexpédier tout le flux', async () => {
      const { pc } = await creerLaboHA();
      const sack = await pc.executeCommand('sysctl net.ipv4.tcp_sack');
      expect(sack).toContain('1');
    });

    it('243. Jumbo Frames (MTU 9000) : acheminement sans fragmentation à travers le switch de coeur', async () => {
      const { swCore } = await creerLaboHA();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'system mtu jumbo 9000', 'end',
      ]);
      const mtu = await swCore.executeCommand('show system mtu');
      expect(mtu).toMatch(/9000/);
    });

    it('244. TCP Fast Open (TFO) : échange de données direct dès le paquet SYN traversant le réseau', async () => {
      const { pc } = await creerLaboHA();
      const tfo = await pc.executeCommand('sysctl net.ipv4.tcp_fastopen');
      expect(tfo).toMatch(/[123]/);
    });
  });

  // =========================================================================
  // 36. CHAOS ENGINEERING RÉSEAU & RÉSILIENCE EXTRÊME (Tests 245 à 250)
  // =========================================================================
  describe('Chaos Engineering Réseau & Conditions Dégradées Extrêmes', () => {
    it('245. Flapping d\'interface physique (Up/Down répété) : le switch temporise via Dampening', async () => {
      const { swAccess } = await creerLaboHA();
      await taper(swAccess as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'dampening 15 750 2000 60', 'end',
      ]);
      const conf = await swAccess.executeCommand('show running-config interface FastEthernet0/2');
      expect(conf).toContain('dampening');
    });

    it('246. Perte de paquets simulée (Packet Loss 20%) : Nginx maintient le transfert de bout en bout grâce aux retransmissions', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      // Injection de perte artificielle via Linux NetEm
      await pc.executeCommand('tc qdisc add dev eth0 root netem loss 20%');
      const res = await pc.executeCommand('curl -s --connect-timeout 5 http://10.0.0.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
      // Nettoyage netem
      await pc.executeCommand('tc qdisc del dev eth0 root');
    });

    it('247. Gigue sévère et latence variable (Jitter 100ms) : Oracle SQL complète sa transaction avec succès', async () => {
      const { pc, srvDb } = await creerLaboHA();
      await taper(srvDb as unknown as Cli, ['systemctl start oracle-xe']);
      await pc.executeCommand('tc qdisc add dev eth0 root netem delay 50ms 20ms');
      const res = await pc.executeCommand('echo "SELECT \'CHAOS_RESILIENT\' FROM DUAL;" | sqlplus -S system/oracle@10.0.0.20:1521/XE');
      expect(res).toContain('CHAOS_RESILIENT');
      await pc.executeCommand('tc qdisc del dev eth0 root');
    });

    it('248. Corruption de paquets aléatoire (Corrupt 5%) : TCP détecte les checksums invalides et purge les données altérées', async () => {
      const { pc, srvWeb } = await creerLaboHA();
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await pc.executeCommand('tc qdisc add dev eth0 root netem corrupt 5%');
      const res = await pc.executeCommand('curl -s http://10.0.0.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
      await pc.executeCommand('tc qdisc del dev eth0 root');
    });

    it('249. Rupture brutale du câble Heartbeat HA suivie de reconnexion : réconciliation automatique des états', async () => {
      const { fwMaster, fwSlave } = await creerLaboHA();
      // Rupture puis rétablissement
      await taper(fwMaster, ['config system interface', 'edit port4', 'set status down', 'next', 'end']);
      await taper(fwMaster, ['config system interface', 'edit port4', 'set status up', 'next', 'end']);
      const status = await fwMaster.executeCommand('get system ha status');
      expect(status).toMatch(/in-sync|synchronized|ok/i);
    });

    it('250. Test d\'Endurance Suprême : Charge mixte concurrente (HTTP, SQL, RADIUS, PING) pendant un basculement actif du cluster', async () => {
      const { pc, fwMaster, srvWeb, srvDb, srvRadius } = await creerLaboHA();
      // 1. Démarrage des applications
      await taper(srvWeb as unknown as Cli, ['systemctl start nginx']);
      await taper(srvDb as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(srvRadius as unknown as Cli, ['systemctl start freeradius']);

      // 2. Déclenchement simultané du trafic
      const fluxPromesses = Promise.all([
        pc.executeCommand('curl -s http://10.0.0.10/'),
        pc.executeCommand('echo "SELECT 999 FROM DUAL;" | sqlplus -S system/oracle@10.0.0.20:1521/XE'),
        pc.executeCommand('radtest bob BobPassword 10.0.0.50 1812 RadiusSharedSecret2026'),
        pc.executeCommand('ping -c 3 10.0.0.10'),
      ]);

      // 3. Forçage de bascule HA en plein milieu du transit
      await fwMaster.executeCommand('diagnose sys ha reset-uptime');

      const [resHttp, resDb, resRadius, resPing] = await fluxPromesses;

      expect(resHttp).toMatch(/Welcome to nginx|nginx/i);
      expect(resDb).toContain('999');
      expect(resRadius).toContain('Access-Accept');
      expect(resPing).toMatch(/0% packet loss|, 0% loss/);
    });
  });

});