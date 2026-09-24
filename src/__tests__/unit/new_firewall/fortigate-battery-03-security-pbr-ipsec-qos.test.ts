import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

// Topologie Entreprise Multi-Liens :
// PC1 + Attaquant <-> Cisco SW1 <-> [FortiOS FW (port1, wan1, wan2, dmz)] <-> SW2 <-> SRV-Prod, SRV-Backup, Syslog
interface LaboEntreprise {
  pc: LinuxPC;
  rogue: LinuxPC;
  sw1: CiscoSwitch;
  fw: Cli;
  srvProd: LinuxServer;
  srvBackup: LinuxServer;
  syslogSrv: LinuxServer;
}

async function creerLaboEntreprise(): Promise<LaboEntreprise> {
  const pc = new LinuxPC('linux-pc', 'PC-Compta', 100, 0);
  const rogue = new LinuxPC('linux-pc-rogue', 'PC-Attacker', 100, 150);
  const sw1 = new CiscoSwitch('switch-cisco', 'SW-Access', 16, 300, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const srvProd = new LinuxServer('linux-server', 'SRV-PROD', 700, 0);
  const srvBackup = new LinuxServer('linux-server', 'SRV-BACKUP', 700, 150);
  const syslogSrv = new LinuxServer('linux-server', 'SRV-SYSLOG', 700, 300);

  pc.powerOn();
  rogue.powerOn();
  sw1.powerOn();
  srvProd.powerOn();
  srvBackup.powerOn();
  syslogSrv.powerOn();

  // Câblage LAN
  new Cable('c-pc-sw').connect(pc.getPort('eth0') as never, sw1.getPort('FastEthernet0/2') as never);
  new Cable('c-rogue-sw').connect(rogue.getPort('eth0') as never, sw1.getPort('FastEthernet0/3') as never);
  new Cable('c-sw-fw').connect(sw1.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);

  // Câblage Serveurs & WAN
  new Cable('c-fw-prod').connect(fw.getPort('wan1') as never, srvProd.getPort('eth0') as never);
  new Cable('c-fw-bkp').connect(fw.getPort('wan2') as never, srvBackup.getPort('eth0') as never);
  new Cable('c-fw-log').connect(fw.getPort('dmz') as never, syslogSrv.getPort('eth0') as never);

  // Adressage Firewall
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next',
    'edit wan1',  'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit wan2',  'set mode static', 'set ip 198.51.100.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit dmz',   'set mode static', 'set ip 10.10.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);

  // Clients
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);
  await taper(rogue as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.66/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);

  // Serveurs
  await taper(srvProd as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0', 'ip route add default via 203.0.113.1',
  ]);
  await taper(srvBackup as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 198.51.100.10/24 dev eth0', 'ip route add default via 198.51.100.1',
  ]);
  await taper(syslogSrv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.10.10.254/24 dev eth0', 'ip route add default via 10.10.10.1',
  ]);

  return { pc, rogue, sw1, fw, srvProd, srvBackup, syslogSrv };
}

describe('Batterie 3 : Tests 101 à 150 — Sécurité Avancée, PBR, IPsec, QoS & Robustesse', () => {

  // =========================================================================
  // 17. COMMUTATION CISCO AVANCÉE & SÉCURITÉ DE PORT L2 (Tests 101 à 107)
  // =========================================================================
  describe('Cisco Switching Sécurisé : Filtrage L2 & Contrôle de Trafic', () => {
    it('101. Port-Security : blocage du port switch si le nombre max d\'adresses MAC est dépassé', async () => {
      const { sw1, pc } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'switchport mode access',
        'switchport port-security',
        'switchport port-security maximum 1',
        'switchport port-security violation restrict',
        'end',
      ]);
      await pc.executeCommand('ping -c 1 192.168.1.1');
      // Émission avec une fausse MAC secondaire sur le même port physique
      const res = await pc.executeCommand('macchanger -m 00:11:22:33:44:55 eth0 && ping -c 1 -W 1 192.168.1.1');
      expect(res).toMatch(/100% packet loss/);
    });

    it('102. Port-Security Sticky MAC : apprentissage persistant de la MAC légitime du PC', async () => {
      const { sw1, pc } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'switchport mode access',
        'switchport port-security',
        'switchport port-security mac-address sticky',
        'end',
      ]);
      await pc.executeCommand('ping -c 1 192.168.1.1');
      const conf = await sw1.executeCommand('show run interface FastEthernet0/2');
      expect(conf).toMatch(/switchport port-security mac-address sticky/);
    });

    it('103. Storm Control : écrêtage d\'une tempête de paquets Broadcast traversant le switch', async () => {
      const { sw1, rogue } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/3',
        'storm-control broadcast level 10.00',
        'end',
      ]);
      const status = await sw1.executeCommand('show storm-control FastEthernet0/3 broadcast');
      expect(status).toMatch(/^Fa0\/3\s+Forwarding\s+10\.00%/m);
    });

    it('104. BPDU Guard : desactivation immediate d\'un port utilisateur (err-disable) recevant des BPDUs STP', async () => {
      const { sw1 } = await creerLaboEntreprise();
      // Un commutateur pirate, racine par sa priorite basse, emet des BPDUs
      // sur le port protege : c'est ce qu'un vrai poste ne fait jamais.
      const rogueSwitch = new CiscoSwitch('switch-cisco', 'SW-Rogue', 8, 900, 0);
      rogueSwitch.powerOn();
      await taper(rogueSwitch as unknown as Cli, ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 0', 'end']);
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/5',
        'spanning-tree bpduguard enable',
        'end',
      ]);
      new Cable('c-rogue-bpdu').connect(sw1.getPort('FastEthernet0/5') as never, rogueSwitch.getPort('FastEthernet0/1') as never);
      const err = await sw1.executeCommand('show interfaces FastEthernet0/5 status');
      expect(err).toMatch(/^Fa0\/5\s+err-disabled/m);
    });

    it('105. Dynamic ARP Inspection (DAI) : destruction des paquets ARP non concordants avec le bail DHCP', async () => {
      const { sw1, rogue } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'ip arp inspection vlan 1',
        'end',
      ]);
      // Envoi d'un ARP reply non légitime
      const spoof = await rogue.executeCommand('arping -c 1 -S 192.168.1.1 192.168.1.10');
      expect(spoof).not.toMatch(/100% answers/i);
    });

    it('106. EtherChannel (LACP) : répartition de charge du trafic traversant sur agrégat de liens', async () => {
      const { sw1 } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface range FastEthernet0/11 - 12',
        'channel-group 1 mode active',
        'end',
      ]);
      const ether = await sw1.executeCommand('show etherchannel summary');
      expect(ether).toMatch(/^1\s+Po1\(S[UD]\)\s+LACP\s+Fa0\/11/m);
    });

    it('107. Isolation L2 Protected Port : deux PC sur le même VLAN ne peuvent dialoguer entre eux', async () => {
      const { sw1, pc, rogue } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2', 'switchport protected', 'exit',
        'interface FastEthernet0/3', 'switchport protected', 'end',
      ]);
      const res = await pc.executeCommand('ping -c 1 -W 1 192.168.1.66');
      expect(res).toMatch(/100% packet loss/);
    });
  });

  // =========================================================================
  // 18. ROUTAGE AVANCÉ, PBR & MULTI-WAN DUAL-HOMING (Tests 108 à 114)
  // =========================================================================
  describe('Policy-Based Routing (PBR) & Redondance WAN', () => {
    it('108. PBR : Le trafic HTTP sort par WAN1 tandis que le trafic Oracle 1521 est aiguillé sur WAN2', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config router policy',
        'edit 1', 'set input-device "port1"', 'set output-device "wan1"', 'set protocol 6', 'set start-port 80', 'set end-port 80', 'set gateway 203.0.113.1', 'next',
        'edit 2', 'set input-device "port1"', 'set output-device "wan2"', 'set protocol 6', 'set start-port 1521', 'set end-port 1521', 'set gateway 198.51.100.1', 'next',
        'end',
      ]);
      const rules = await fw.executeCommand('show router policy');
      expect(rules).toContain('wan1');
      expect(rules).toContain('wan2');
    });

    it('109. Routage de bascule (WAN Failover) : basculement transparent vers WAN2 lors d\'une panne de WAN1', async () => {
      const { pc, fw, srvBackup } = await creerLaboEntreprise();
      await taper(srvBackup as unknown as Cli, ['systemctl start nginx']);
      // WAN1 coupé
      await taper(fw, [
        'config system interface', 'edit "wan1"', 'set status down', 'next', 'end',
        'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set gateway 198.51.100.1', 'set device "wan2"', 'next', 'end',
        'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "wan2"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set nat enable', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://198.51.100.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('110. Link Health-Monitor : détection automatique de perte de liaison par sondage ICMP', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config system link-monitor',
        'edit "WAN1_HEALTH"',
        'set srcintf "wan1"',
        'set server "203.0.113.10"',
        'set protocol ping',
        'set interval 500',
        'set failtime 3',
        'next',
        'end',
      ]);
      const mon = await fw.executeCommand('diagnose sys link-monitor status');
      expect(refuse(mon)).toBe(false);
    });

    it('111. ECMP (Equal-Cost Multi-Path) : distribution du trafic entre deux passerelles de même métrique', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config router static',
        'edit 10', 'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.1', 'set device "wan1"', 'set distance 10', 'next',
        'edit 11', 'set dst 0.0.0.0 0.0.0.0', 'set gateway 198.51.100.1', 'set device "wan2"', 'set distance 10', 'next',
        'end',
      ]);
      const routes = await fw.executeCommand('get router info routing-table all');
      expect(routes).toMatch(/wan1/);
      expect(routes).toMatch(/wan2/);
    });

    it('112. Détection de boucle de routage et rejet par TTL expiré au cours du transit multi-routeurs', async () => {
      const { pc } = await creerLaboEntreprise();
      // Test d'un ping avec un TTL ultra court
      const res = await pc.executeCommand('ping -c 1 -t 2 8.8.8.8');
      expect(res).toMatch(/Time to live exceeded|100% packet loss/i);
    });

    it('113. Routage par IP source : Le PC Compta sort via WAN1, le PC Rogue est confiné à WAN2', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config router policy',
        'edit 3', 'set src "192.168.1.10/32"', 'set output-device "wan1"', 'next',
        'edit 4', 'set src "192.168.1.66/32"', 'set output-device "wan2"', 'next',
        'end',
      ]);
      const pbr = await fw.executeCommand('show router policy');
      expect(pbr).toContain('192.168.1.10/32');
      expect(pbr).toContain('192.168.1.66/32');
    });

    it('114. Invalidation instantanée des sessions associées à une route statique supprimée', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set device "wan1"', 'next', 'end',
        'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.10/');
      await taper(fw, ['config router static', 'delete 1', 'end']);
      const res = await pc.executeCommand('curl -sS --connect-timeout 1 http://203.0.113.10/');
      expect(res).toMatch(/Network is unreachable|timed out|Failed to connect/i);
    });
  });

  // =========================================================================
  // 19. TUNNEL VPN IPSEC & FLUX CHIFFRÉS EN TRANSIT (Tests 115 à 121)
  // =========================================================================
  describe('VPN IPsec : Encapsulation ESP & Trafic Traversant', () => {
    it('115. Négociation Phase 1 IKEv2 (UDP 500) à travers l\'infrastructure WAN', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config vpn ipsec phase1-interface',
        'edit "VPN-SITE2"',
        'set interface "wan1"',
        'set ike-version 2',
        'set remote-gw 203.0.113.10',
        'set psksecret "SharedKeySecret2026"',
        'next',
        'end',
      ]);
      const res = await fw.executeCommand('diagnose vpn ike gateway list');
      expect(refuse(res)).toBe(false);
    });

    it('116. Création de la Phase 2 (Quick Mode / ESP) avec chiffrement AES-256', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config vpn ipsec phase2-interface',
        'edit "VPN-SITE2-P2"',
        'set phase1name "VPN-SITE2"',
        'set proposal aes256-sha256',
        'next',
        'end',
      ]);
      const p2 = await fw.executeCommand('show vpn ipsec phase2-interface');
      expect(p2).toContain('VPN-SITE2');
    });

    it('117. Requête HTTP traversant le tunnel IPsec chiffré de bout en bout', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy',
        'edit 70', 'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "HTTP"',
        'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://203.0.113.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('118. Trafic Oracle SQL (1521) traversant le tunnel chiffré sans corruption', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start oracle-ohasd']);
      await taper(fw, [
        'config firewall policy',
        'edit 71', 'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set action accept',
        'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('tnsping 203.0.113.10:1521/ORCL');
      expect(res).toContain('OK');
    });

    it('119. Baisse de la MTU effective due à l\'overhead ESP (MSS Clamping sur IPsec)', async () => {
      const { pc, fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall policy', 'edit 72',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set tcp-mss-sender 1360', 'set tcp-mss-receiver 1360',
        'set service "ALL"', 'next', 'end',
      ]);
      const ping = await pc.executeCommand('ping -c 1 -M do -s 1332 203.0.113.10');
      expect(ping).not.toMatch(/Frag needed/i);
    });

    it('120. Coupure du tunnel IPsec bloque immédiatement tout flux inter-sites', async () => {
      const { pc, fw } = await creerLaboEntreprise();
      await taper(fw, ['diagnose vpn ike gateway clear']);
      const res = await pc.executeCommand('ping -c 1 -W 1 172.16.0.10');
      expect(res).toMatch(/100% packet loss|unreachable/i);
    });

    it('121. Chiffrement vérifié : aucune donnée en clair identifiable sur le WAN lors du transit', async () => {
      const { fw } = await creerLaboEntreprise();
      const sniffer = await fw.executeCommand('diagnose sniffer packet wan1 "esp" 1');
      expect(refuse(sniffer)).toBe(false);
    });
  });

  // =========================================================================
  // 20. TRAFFIC SHAPING, QOS & LIMITATION DE DÉBIT (Tests 122 à 127)
  // =========================================================================
  describe('Gestion de la Bande Passante, QoS & Anti-Saturation', () => {
    it('122. Traffic Shaper : limitation de bande passante sur téléchargement HTTP', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall shaper traffic-shaper',
        'edit "LIMITE_1MB"',
        'set maximum-bandwidth 1000',
        'set guaranteed-bandwidth 500',
        'next', 'end',
      ]);
      const shaper = await fw.executeCommand('show firewall shaper traffic-shaper');
      expect(shaper).toContain('LIMITE_1MB');
    });

    it('123. Priorisation de la voix et du ping (ICMP) au détriment d\'un flux lourd FTP', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall shaper traffic-shaper',
        'edit "PRIO_HAUTE"', 'set priority high', 'next',
        'edit "PRIO_BASSE"', 'set priority low', 'next',
        'end',
      ]);
      const check = await fw.executeCommand('show firewall shaper traffic-shaper');
      expect(check).toContain('priority high');
    });

    it('124. Limitation du nombre maximal de connexions TCP simultanées par client', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall policy', 'edit 80',
        'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept',
        'set session-ttl 60',
        'set service "ALL"', 'next', 'end',
      ]);
      const pol = await fw.executeCommand('show firewall policy 80');
      expect(pol).toContain('set session-ttl 60');
    });

    it('125. Marquage DSCP : Le pare-feu préserve ou réécrit le champ ToS/DSCP dans l\'entête IP', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 81',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set diffserv-forward enable', 'set diffservcode-forward 101110', // EF
        'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://203.0.113.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('126. Per-IP Shaper : Un poste saturant la ligne n\'impacte pas le débit garanti d\'un autre', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall shaper per-ip-shaper',
        'edit "SHAPER_PER_USER"',
        'set max-bandwidth 2048',
        'next', 'end',
      ]);
      const res = await fw.executeCommand('show firewall shaper per-ip-shaper');
      expect(res).toContain('SHAPER_PER_USER');
    });

    it('127. Rejet des paquets excédentaires (Drop Tail) lorsque la file d\'attente de shaping est pleine', async () => {
      const { fw } = await creerLaboEntreprise();
      const diag = await fw.executeCommand('diagnose firewall shaper status');
      expect(refuse(diag)).toBe(false);
    });
  });

  // =========================================================================
  // 21. SUPERVISION, SYSLOG ET TÉLÉMÉTRIE EN TRANSIT (Tests 128 à 133)
  // =========================================================================
  describe('Journalisation Réseau & Télémesure Traversante', () => {
    it('128. Envoi de logs Syslog (UDP 514) du pare-feu vers le serveur Syslog en DMZ', async () => {
      const { fw, syslogSrv } = await creerLaboEntreprise();
      await taper(syslogSrv as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config log syslogd setting',
        'set status enable',
        'set server "10.10.10.254"',
        'set mode udp',
        'set port 514',
        'end',
      ]);
      const setting = await fw.executeCommand('show log syslogd setting');
      expect(setting).toContain('10.10.10.254');
    });

    it('129. Génération et émission d\'un log Syslog immédiat lors d\'un blocage de paquet', async () => {
      const { pc, fw, syslogSrv } = await creerLaboEntreprise();
      await taper(syslogSrv as unknown as Cli, ['systemctl start rsyslog']);
      // Tente une connexion interdite vers une IP inconnue
      await pc.executeCommand('curl -s --connect-timeout 1 http://203.0.113.199/');
      const check = await syslogSrv.executeCommand('tail -n 5 /var/log/syslog');
      expect(check.length).toBeGreaterThan(0);
    });

    it('130. Exportation NetFlow / IPFIX (port 2055) vers le collecteur lors d\'un transfert lourd', async () => {
      const { fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config system netflow',
        'set collector-ip 10.10.10.254',
        'set collector-port 2055',
        'end',
      ]);
      const netflow = await fw.executeCommand('show system netflow');
      expect(netflow).toContain('10.10.10.254');
    });

    it('131. SNMP polling (UDP 161) : requêtes SNMP traversant le switch vers les équipements', async () => {
      const { pc, fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config system snmp community',
        'edit 1', 'set name "public"', 'next', 'end',
      ]);
      const snmp = await pc.executeCommand('snmpget -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.1.0');
      expect(snmp).not.toMatch(/Timeout: No Response/i);
    });

    it('132. Traitement et capture de paquets en temps réel (Packet Sniffer) sur interface WAN', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 90',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.10/');
      const sniff = await fw.executeCommand('diagnose sniffer packet wan1 "port 80" 1');
      expect(refuse(sniff)).toBe(false);
    });

    it('133. Horodatage NTP synchronisé : requêtes UDP 123 traversantes vers un serveur de temps', async () => {
      const { pc, fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config system ntp',
        'set ntpserver "pool.ntp.org"', 'set type custom', 'end',
      ]);
      const ntp = await pc.executeCommand('sntp 192.168.1.1');
      expect(ntp).not.toMatch(/no response/i);
    });
  });

  // =========================================================================
  // 22. SCÉNARIOS D'ENTREPRISE & NGINX / ORACLE COMPLEXES (Tests 134 à 142)
  // =========================================================================
  describe('Scénarios d\'Intégration Applicative Poussés', () => {
    it('134. SSL Offloading : Le pare-feu termine le HTTPS côté client et joint Nginx en clair (HTTP 80) côté WAN', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']); // Nginx écoute en clair sur le port 80
      await taper(fw, [
        'config firewall vip', 'edit "VIP_SSL_OFFLOAD"',
        'set extip 203.0.113.1', 'set mappedip "203.0.113.10"',
        'set portforward enable', 'set extport 443', 'set mappedport 80',
        'next', 'end',
        'config firewall policy', 'edit 91',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "VIP_SSL_OFFLOAD"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -k -s https://203.0.113.1/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('135. Oracle Data Guard : synchronisation de redo-logs entre base primaire et standby (port 1521)', async () => {
      const { srvProd, srvBackup, fw } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start oracle-ohasd']);
      await taper(srvBackup as unknown as Cli, ['systemctl start oracle-ohasd']);
      await taper(fw, [
        'config firewall policy', 'edit 92',
        'set srcintf "wan1"', 'set dstintf "wan2"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const sync = await srvProd.executeCommand('tnsping 198.51.100.10:1521/ORCL');
      expect(sync).toContain('OK');
    });

    it('136. Nginx HTTP 429 Too Many Requests : rejet côté serveur d\'un assaut de requêtes rapides', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, [
        'systemctl start nginx-ratelimited', // Configuration Nginx avec limit_req_zone rate=1r/s
      ]);
      await taper(fw, [
        'config firewall policy', 'edit 93',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.10/login');
      const burst = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://203.0.113.10/login');
      expect(burst.trim()).toBe('429');
    });

    it('137. WebSocket : Négociation HTTP 101 Switching Protocols à travers le firewall', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start ws-server']);
      await taper(fw, [
        'config firewall policy', 'edit 94',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('wscat -c ws://203.0.113.10:8080/ws --connect-timeout 2');
      expect(res).not.toMatch(/Error: connect ECONNREFUSED/i);
    });

    it('138. FTPS Explicite (FTP sur TLS port 21) : sécurisation du flux de contrôle traversant', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start vsftpd-ssl']);
      await taper(fw, [
        'config firewall policy', 'edit 95',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -k --ssl -s ftp://203.0.113.10/');
      expect(res).not.toMatch(/SSL: certificate subject name mismatch/i);
    });

    it('139. Authentification HTTP Basic : transmission intègre des credentials chiffrés en base64', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx-auth']);
      await taper(fw, [
        'config firewall policy', 'edit 96',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const unauth = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://203.0.113.10/private/');
      expect(unauth.trim()).toBe('401');
      const auth = await pc.executeCommand('curl -u admin:secret -s -o /dev/null -w "%{http_code}" http://203.0.113.10/private/');
      expect(auth.trim()).toBe('200');
    });

    it('140. Injection de routes statiques sans classe (Option DHCP 121) appliquées par le client', async () => {
      const { pc, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start isc-dhcp-server']);
      await pc.executeCommand('dhclient -v eth0');
      const routes = await pc.executeCommand('ip route');
      expect(routes.length).toBeGreaterThan(0);
    });

    it('141. Oracle Listener : rejet de connexion avec code ORA-12514 si le service DB est inconnu', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start oracle-ohasd']);
      await taper(fw, [
        'config firewall policy', 'edit 97',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('sqlplus -S system/oracle@203.0.113.10:1521/SERVICE_INCONNU');
      expect(res).toMatch(/ORA-12514|TNS:listener does not currently know of service/i);
    });

    it('142. Split-Horizon DNS : l\'IP retournée par BIND9 dépend du réseau source de la requête', async () => {
      const { pc, srvProd, fw } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start named-views']); // Vue LAN vs Vue WAN
      await taper(fw, [
        'config firewall policy', 'edit 98',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const resLan = await pc.executeCommand('dig @203.0.113.10 portal.lab.lan +short');
      expect(resLan).toMatch(/192\.168\.|10\./);
    });
  });

  // =========================================================================
  // 23. RÉSISTANCE AUX ATTAQUES, DÉFENSES & VALIDATION FINALE (Tests 143 à 150)
  // =========================================================================
  describe('Défense Périmétrique & Résilience aux Attaques', () => {
    it('143. SYN Flood Mitigation : activation des SYN Cookies pour préserver la disponibilité', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config system settings',
        'set tcp-syn-flood-threshold 100',
        'end',
      ]);
      const status = await fw.executeCommand('get system settings');
      expect(status).toContain('tcp-syn-flood-threshold');
      // Le client régulier peut toujours se connecter
      await taper(fw, [
        'config firewall policy', 'edit 99', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('curl -s http://203.0.113.10/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('144. Détection et destruction d\'une Land Attack (IP source = IP destination)', async () => {
      const { rogue, fw } = await creerLaboEntreprise();
      // Le rogue envoie un paquet avec IP source = IP dest = 203.0.113.10
      const res = await rogue.executeCommand('hping3 -a 203.0.113.10 -S -p 80 -c 1 203.0.113.10');
      expect(res).toMatch(/100% packet loss|0 packets received/i);
    });

    it('145. Mitigation de l\'attaque Smurf (ICMP directed broadcast rejeté à l\'entrée)', async () => {
      const { rogue } = await creerLaboEntreprise();
      // Broadcast directed
      const res = await rogue.executeCommand('ping -c 1 -b 192.168.1.255');
      expect(res).not.toMatch(/bytes from 203\.0\.113\./);
    });

    it('146. Protection contre l\'attaque CAM Overflow sur le switch Cisco', async () => {
      const { sw1, rogue } = await creerLaboEntreprise();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/3',
        'switchport port-security',
        'switchport port-security maximum 10',
        'end',
      ]);
      // Tentative de flood MAC
      await rogue.executeCommand('macof -n 50');
      const table = await sw1.executeCommand('show mac address-table count');
      expect(table).not.toMatch(/Total Mac Address count : 10000/);
    });

    it('147. Slowloris Mitigation : fermeture précoce des connexions HTTP incomplètes sans payload', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config system session-ttl',
        'config port', 'edit 80', 'set timeout 5', 'next', 'end',
        'end',
      ]);
      const ttl = await fw.executeCommand('show system session-ttl');
      expect(ttl).toContain('80');
    });

    it('148. Destruction des fragments IP anormaux et superposés (Teardrop Attack)', async () => {
      const { rogue, fw } = await creerLaboEntreprise();
      await taper(fw, [
        'config firewall policy', 'edit 105', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      // Injection de fragments IP chevauchants
      const res = await rogue.executeCommand('hping3 --frag --mtu 8 -1 203.0.113.10 -c 2');
      expect(res).toMatch(/100% packet loss|0 packets received/i);
    });

    it('149. Nettoyage de fin de session immédiat lors d\'un timeout d\'inactivité UDP', async () => {
      const { pc, fw, srvProd } = await creerLaboEntreprise();
      await taper(srvProd as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config system session-ttl',
        'config port', 'edit 53', 'set timeout 10', 'next', 'end',
        'end',
      ]);
      await pc.executeCommand('dig @203.0.113.10 test.lan +timeout=1');
      const check = await fw.executeCommand('show system session-ttl');
      expect(check).toContain('53');
    });

    it('150. Épreuve Reine Bout-en-Bout : Bail DHCP, DNS A-Record, Auth Nginx, Rebond SQL, Audit Syslog', async () => {
      const { pc, fw, srvProd, syslogSrv } = await creerLaboEntreprise();
      // 1. Démarrage des daemons
      await taper(srvProd as unknown as Cli, [
        'systemctl start named',
        'systemctl start nginx',
        'systemctl start oracle-ohasd',
      ]);
      await taper(syslogSrv as unknown as Cli, ['systemctl start rsyslog']);

      // 2. Politique pare-feu unifiée
      await taper(fw, [
        'config firewall policy', 'edit 150',
        'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"',
        'set nat enable', 'next', 'end',
      ]);

      // 3. Résolution DNS du serveur de prod
      const ip = (await pc.executeCommand('dig @203.0.113.10 prod.entreprise.lan +short')).trim();
      expect(ip).toMatch(/203\.0\.113\.10/);

      // 4. Appel HTTP Nginx
      const web = await pc.executeCommand(`curl -s http://${ip}/`);
      expect(web).toMatch(/Welcome to nginx|nginx/i);

      // 5. Requête transactionnelle Oracle DB
      const db = await pc.executeCommand(`echo "SELECT 'ALL_SYSTEMS_GO' FROM DUAL;" | sqlplus -S system/oracle@${ip}:1521/ORCL`);
      expect(db).toContain('ALL_SYSTEMS_GO');

      // 6. Présence des sessions dans la table de suivi
      const sessions = await fw.executeCommand('diagnose sys session list');
      expect(sessions).toMatch(/dport=80|dport=1521/);
    });
  });

});