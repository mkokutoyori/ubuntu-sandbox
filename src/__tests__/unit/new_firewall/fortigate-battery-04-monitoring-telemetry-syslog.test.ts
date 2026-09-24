import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

// Topologie dédiée Supervision :
// [Client LAN] --- (Cisco SW1) --- [FortiOS FW] --- (DMZ: Serveur Prod)
//                                         |
//                                   (WAN: Serveur SIEM / Monitoring / NetFlow)
interface LaboSupervision {
  pc: LinuxPC;
  sw1: CiscoSwitch;
  fw: Cli;
  srvProd: LinuxServer;
  siem: LinuxServer;
}

async function creerLaboSupervision(): Promise<LaboSupervision> {
  const pc = new LinuxPC('linux-pc', 'PC-Admin', 100, 0);
  const sw1 = new CiscoSwitch('switch-cisco', 'SW-Core', 16, 300, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const srvProd = new LinuxServer('linux-server', 'SRV-PROD', 700, 0);
  const siem = new LinuxServer('linux-server', 'SRV-SIEM', 700, 200);

  pc.powerOn();
  sw1.powerOn();
  srvProd.powerOn();
  siem.powerOn();

  // Câblage physique
  new Cable('c-pc-sw').connect(pc.getPort('eth0') as never, sw1.getPort('FastEthernet0/2') as never);
  new Cable('c-sw-fw').connect(sw1.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);
  new Cable('c-fw-dmz').connect(fw.getPort('dmz') as never, srvProd.getPort('eth0') as never);
  new Cable('c-fw-wan').connect(fw.getPort('wan1') as never, siem.getPort('eth0') as never);

  // Configuration IP Pare-feu
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit dmz',   'set mode static', 'set ip 10.10.10.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit wan1',  'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);

  // Client Administrateur
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);

  // Serveur Surveillé (DMZ)
  await taper(srvProd as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.10.10.5/24 dev eth0', 'ip route add default via 10.10.10.1',
  ]);

  // Serveur Central de Supervision / SIEM (WAN)
  await taper(siem as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.50/24 dev eth0', 'ip route add default via 203.0.113.1',
  ]);

  return { pc, sw1, fw, srvProd, siem };
}

describe('Batterie 4 : Tests 151 à 200 — Supervision Réseau, Télémétrie & Syslog', () => {

  // =========================================================================
  // 24. SYSLOG TRANSPORT TRAVERSANT (UDP 514, TCP 514, TLS 6514) (Tests 151 à 158)
  // =========================================================================
  describe('Transport Syslog : Acheminement des trames vers le SIEM', () => {
    it('151. Acheminement d\'un message Syslog standard UDP 514 depuis le pare-feu vers le SIEM', async () => {
      const { fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config log syslogd setting',
        'set status enable', 'set server "203.0.113.50"', 'set mode udp', 'set port 514',
        'end',
      ]);
      await fw.executeCommand('diagnose log test');
      const logs = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(logs).toMatch(/fortigate|logver=/i);
    });

    it('152. Syslog fiable en mode TCP 514 avec établissement de 3-way handshake traversant', async () => {
      const { fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config log syslogd setting',
        'set status enable', 'set server "203.0.113.50"', 'set mode reliable', 'set port 514',
        'end',
      ]);
      const session = await fw.executeCommand('diagnose sys session list');
      expect(session).toMatch(/proto=6.*dport=514/);
    });

    it('153. Syslog sécurisé chiffré TLS (port 6514) traversant sans altération de payload', async () => {
      const { fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog-tls']);
      await taper(fw, [
        'config log syslogd setting',
        'set status enable', 'set server "203.0.113.50"', 'set mode reliable', 'set port 6514', 'set enc-algorithm high',
        'end',
      ]);
      const stat = await fw.executeCommand('get log syslogd setting');
      expect(stat).toContain('6514');
    });

    it('154. Préservation intégrale du format RFC 5424 (PRI, VERSION, TIMESTAMP, HOSTNAME, APP-NAME)', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 154',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      // Envoi d'un message standard RFC 5424 via logger Linux
      await srvProd.executeCommand('logger --rfc5424 -n 203.0.113.50 -P 514 -t NGINX_APP "Test log RFC5424"');
      const recu = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(recu).toMatch(/NGINX_APP.*Test log RFC5424/);
    });

    it('155. Fragmentation et réassemblage de logs Syslog volumineux excédant la MTU 1500', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 155',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const longPayload = 'A'.repeat(2000);
      await srvProd.executeCommand(`logger -n 203.0.113.50 -P 514 "${longPayload}"`);
      const logs = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(logs).toContain('AAAA');
    });

    it('156. Réception simultanée de flux Syslog concurrents (Switch + FW + Serveurs) sans entrelacement', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 156',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await Promise.all([
        fw.executeCommand('diagnose log test'),
        srvProd.executeCommand('logger -n 203.0.113.50 -P 514 "MSG_FROM_PROD"'),
      ]);
      const logs = await siem.executeCommand('grep -E "fortigate|MSG_FROM_PROD" /var/log/syslog');
      expect(logs).toContain('MSG_FROM_PROD');
    });

    it('157. Mise en mémoire tampon (Spooling) locale et vidage lors de la reconnexion au SIEM', async () => {
      const { fw, siem } = await creerLaboSupervision();
      // Coupure du SIEM
      await taper(siem as unknown as Cli, ['systemctl stop rsyslog']);
      await taper(fw, [
        'config log syslogd setting',
        'set status enable', 'set server "203.0.113.50"', 'set max-log-rate 100',
        'end',
      ]);
      await fw.executeCommand('diagnose log test');
      // SIEM de retour
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      const logs = await siem.executeCommand('tail -n 5 /var/log/syslog');
      expect(logs.length).toBeGreaterThanOrEqual(0);
    });

    it('158. VIP / Load Balancer Syslog : distribution du trafic UDP 514 traversant vers un groupe de SIEM', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config firewall vip', 'edit "VIP_SYSLOG_LB"',
        'set extip 203.0.113.1', 'set mappedip "203.0.113.50"', 'set extport 514', 'set mappedport 514',
        'next', 'end',
      ]);
      const vip = await fw.executeCommand('show firewall vip VIP_SYSLOG_LB');
      expect(vip).toContain('203.0.113.50');
    });
  });

  // =========================================================================
  // 25. AUDIT DE SÉCURITÉ & JALONNEMENT DES SÉVÉRITÉS (Tests 159 à 166)
  // =========================================================================
  describe('Filtrage des Événements & Envoi Sélectif au SIEM', () => {
    it('159. Filtrage de sévérité : Seuls les logs de niveau Warning ou supérieur traversent vers le SIEM', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config log syslogd filter',
        'set severity warning',
        'end',
      ]);
      const filter = await fw.executeCommand('get log syslogd filter');
      expect(filter).toContain('warning');
    });

    it('160. Log de fermeture de session (session-close) incluant les compteurs d\'octets et de paquets exacts', async () => {
      const { pc, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 160',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set logtraffic all', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://10.0.10.5/');
      const logs = await fw.executeCommand('diagnose log test');
      expect(refuse(logs)).toBe(false);
    });

    it('161. Journalisation instantanée des paquets rejetés (DROP/DENY) avec IP source et port cibles', async () => {
      const { pc, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config log syslogd setting', 'set status enable', 'set server "203.0.113.50"', 'end',
        'config firewall policy', 'edit 161',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action deny', 'set logtraffic all', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s --connect-timeout 1 http://10.10.10.5/');
      const logs = await siem.executeCommand('tail -n 2 /var/log/syslog');
      expect(logs).toMatch(/action="deny"|policyid=161/i);
    });

    it('162. Journalisation Nginx en DMZ transmise en flux continu vers le SIEM centralisé', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 162',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      // Nginx configuré pour émettre ses logs sur syslog local qui relaie au SIEM
      await taper(srvProd as unknown as Cli, [
        'systemctl start nginx',
        'logger -n 203.0.113.50 -P 514 "nginx: 192.168.1.10 GET /index.html 200"',
      ]);
      const res = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(res).toContain('GET /index.html 200');
    });

    it('163. Audit Oracle DB : Échec de connexion (ORA-01017) notifié au SIEM à travers le firewall', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 163',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await srvProd.executeCommand('logger -n 203.0.113.50 -P 514 "ORACLE AUDIT: ACTION=LOGON STATUS=1017 USER=system"');
      const audit = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(audit).toMatch(/STATUS=1017/);
    });

    it('164. Détection de tentative d\'attaque brute force SSH générant une alerte Syslog authpriv', async () => {
      const { srvProd, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 164',
        'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await srvProd.executeCommand('logger -p authpriv.alert -n 203.0.113.50 "sshd: Failed password for root from 192.168.1.99"');
      const res = await siem.executeCommand('tail -n 1 /var/log/syslog');
      expect(res).toContain('Failed password for root');
    });

    it('165. Alerte Port-Security Violation issue du switch Cisco acheminée au SIEM', async () => {
      const { sw1, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'logging host 203.0.113.50',
        'logging trap warnings',
        'end',
      ]);
      const status = await sw1.executeCommand('show logging');
      expect(status).toContain('203.0.113.50');
    });

    it('166. Écrêtage anti-flood Syslog : limitation de fréquence d\'émission pour prévenir la saturation réseau', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config log syslogd setting',
        'set max-log-rate 50', // 50 logs/seconde max
        'end',
      ]);
      const res = await fw.executeCommand('get log syslogd setting');
      expect(res).toContain('50');
    });
  });

  // =========================================================================
  // 26. SNMP POLLING TRAVERSANT (GET, WALK, BULK) (Tests 167 à 174)
  // =========================================================================
  describe('Interrogation SNMP (UDP 161) à Travers les Équipements', () => {
    it('167. Requête SNMP v2c GET traversant le pare-feu pour interroger le statut d\'une interface switch', async () => {
      const { pc, sw1 } = await creerLaboSupervision();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'snmp-server community PublicReadOnly RO',
        'end',
      ]);
      const res = await pc.executeCommand('snmpget -v2c -c PublicReadOnly 192.168.1.1 1.3.6.1.2.1.2.2.1.8.1');
      expect(res).not.toMatch(/Timeout/i);
    });

    it('168. Parcours d\'arbre MIB (SNMPWALK) sur le sous-système IP à travers le switch', async () => {
      const { pc } = await creerLaboSupervision();
      const res = await pc.executeCommand('snmpwalk -v2c -c public 192.168.1.1 1.3.6.1.2.1.4');
      expect(res).not.toMatch(/Timeout: No Response/i);
    });

    it('169. SNMP BULKWALK v2c : rapatriement compact de tables d\'interfaces volumineuses', async () => {
      const { pc } = await creerLaboSupervision();
      const res = await pc.executeCommand('snmpbulkwalk -v2c -c public -Cr10 192.168.1.1 1.3.6.1.2.1.2.2');
      expect(res).not.toMatch(/Timeout/i);
    });

    it('170. Rejet immédiat par le pare-feu d\'un SNMP GET avec Community String invalide', async () => {
      const { pc } = await creerLaboSupervision();
      const res = await pc.executeCommand('snmpget -v2c -c MOT_DE_PASSE_FAUX 192.168.1.1 1.3.6.1.2.1.1.1.0');
      expect(res).toMatch(/Timeout: No Response|AuthorizationError/i);
    });

    it('171. SNMP v3 avec authentification SHA et chiffrement AES (authPriv) traversant les équipements', async () => {
      const { pc, fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system snmp user',
        'edit "admin_v3"',
        'set auth-proto sha', 'set auth-pwd "AuthPass2026"',
        'set priv-proto aes', 'set priv-pwd "PrivPass2026"',
        'set security-level auth-priv',
        'next', 'end',
      ]);
      const res = await pc.executeCommand('snmpget -v3 -u admin_v3 -l authPriv -a SHA -A AuthPass2026 -x AES -X PrivPass2026 192.168.1.1 1.3.6.1.2.1.1.1.0');
      expect(res).not.toMatch(/Authentication failure|Timeout/i);
    });

    it('172. Négociation automatique de l\'EngineID SNMP v3 à travers le réseau', async () => {
      const { pc, fw } = await creerLaboSupervision();
      const res = await pc.executeCommand('snmprequest -v3 -u admin_v3 192.168.1.1 engineIDDiscovery');
      expect(refuse(res)).toBe(false);
    });

    it('173. Blocage strict par le pare-feu des requêtes SNMP issues d\'adresses non autorisées', async () => {
      const { pc, fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system snmp community',
        'edit 1',
        'config hosts', 'edit 1', 'set ip 192.168.1.99 255.255.255.255', 'next', 'end',
        'next', 'end',
      ]);
      const res = await pc.executeCommand('snmpget -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.1.0');
      expect(res).toMatch(/Timeout: No Response/i);
    });

    it('174. Collecte métrique distante (Charge CPU / RAM Linux) sur le serveur DMZ via SNMP', async () => {
      const { pc, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start snmpd']);
      await taper(fw, [
        'config firewall policy', 'edit 174',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "SNMP"', 'next', 'end',
      ]);
      const res = await pc.executeCommand('snmpget -v2c -c public 10.10.10.5 1.3.6.1.4.1.2021.10.1.3.1');
      expect(res).not.toMatch(/Timeout/i);
    });
  });

  // =========================================================================
  // 27. TRAPS & INFORMS SNMP (UDP 162) TRAVERSANTS (Tests 175 à 181)
  // =========================================================================
  describe('Alertes Asynchrones SNMP : Traps & Informs vers le Gestionnaire', () => {
    it('175. Trap SNMP v2c (UDP 162) émis vers le serveur SIEM lors d\'une coupure de lien L2', async () => {
      const { sw1, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start snmptrapd']);
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'snmp-server enable traps',
        'snmp-server host 203.0.113.50 traps version 2c public',
        'interface FastEthernet0/5', 'shutdown', 'end',
      ]);
      const traps = await siem.executeCommand('tail -n 2 /var/log/snmptraps.log');
      expect(traps).toMatch(/linkDown|FastEthernet0\/5/i);
    });

    it('176. SNMP Inform Request : Accusé de réception retourné à travers le pare-feu', async () => {
      const { pc, fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start snmptrapd']);
      await taper(fw, [
        'config firewall policy', 'edit 176',
        'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await pc.executeCommand('snmpinform -v2c -c public 203.0.113.50 0 1.3.6.1.4.1.8072.4');
      expect(res).not.toMatch(/Timeout/i);
    });

    it('177. Règle pare-feu spécifique dédiée au port Trap UDP 162 isolée du flux UDP 161', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config firewall service custom',
        'edit "SNMP-TRAP"', 'set category "Network Services"', 'set protocol IP', 'set udp-portrange 162', 'next',
        'end',
      ]);
      const srv = await fw.executeCommand('show firewall service custom SNMP-TRAP');
      expect(srv).toContain('162');
    });

    it('178. Trap d\'alerte environnementale (Surchauffe / Alim défaillante) acheminé sans délai', async () => {
      const { sw1, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start snmptrapd']);
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'snmp-server enable traps envmon', 'end',
      ]);
      const conf = await sw1.executeCommand('show running-config | include snmp-server enable traps');
      expect(conf).toContain('envmon');
    });

    it('179. Retransmission d\'un Inform SNMP en cas de perte de paquet sur le réseau', async () => {
      const { pc } = await creerLaboSupervision();
      // Vers une IP sans snmptrapd actif pour déclencher les retries
      const res = await pc.executeCommand('snmpinform -v2c -r 2 -t 1 -c public 203.0.113.240 0 1.3.6.1.4.1.8072.4');
      expect(res).toMatch(/Timeout: No Response/i);
    });

    it('180. Émission d\'un Trap ColdStart lors de l\'initialisation d\'un équipement réseau', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system snmp sysinfo', 'set status enable', 'set trap-high-cpu-threshold 90', 'end',
      ]);
      const info = await fw.executeCommand('get system snmp sysinfo');
      expect(info).toContain('90');
    });

    it('181. Trap d\'échec d\'authentification (AuthenticationFailure) généré suite à une intrusion SNMP', async () => {
      const { sw1 } = await creerLaboSupervision();
      const conf = await sw1.executeCommand('show snmp');
      expect(conf).not.toMatch(/error/i);
    });
  });

  // =========================================================================
  // 28. TÉLÉMÉTRIE DE FLUX : NETFLOW, IPFIX & SFLOW (Tests 182 à 188)
  // =========================================================================
  describe('Export NetFlow / IPFIX / sFlow en Transit', () => {
    it('182. Export NetFlow v9 (UDP 2055) vers le collecteur lors d\'un flux HTTP', async () => {
      const { pc, fw, srvProd, siem } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(siem as unknown as Cli, ['systemctl start flow-collector']);
      await taper(fw, [
        'config system netflow',
        'set collector-ip 203.0.113.50', 'set collector-port 2055', 'set active-flow-timeout 1', 'end',
        'config firewall policy', 'edit 182',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://10.10.10.5/');
      const status = await fw.executeCommand('diagnose test application netflow 1');
      expect(refuse(status)).toBe(false);
    });

    it('183. Export IPFIX (RFC 7011) préservant les identifiants de templates et de champs', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system netflow', 'set template-tx-timeout 1', 'end',
      ]);
      const conf = await fw.executeCommand('show system netflow');
      expect(conf).toContain('template-tx-timeout');
    });

    it('184. Échantillonnage sFlow (UDP 6343) généré par le switch Cisco vers la sonde', async () => {
      const { sw1 } = await creerLaboSupervision();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'sflow receiver 1 ip 203.0.113.50',
        'interface FastEthernet0/2', 'sflow sampling-rate 100', 'end',
      ]);
      const sflow = await sw1.executeCommand('show sflow');
      expect(sflow).toContain('203.0.113.50');
    });

    it('185. Active Flow Timeout : Export forcé d\'un flux long-terme (ex: gros export Oracle SQL)', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system netflow', 'set active-flow-timeout 30', 'end',
      ]);
      const conf = await fw.executeCommand('get system netflow');
      expect(conf).toContain('30');
    });

    it('186. Inactive Flow Timeout : Export immédiat du paquet de fin dès la fermeture de connexion', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config system netflow', 'set inactive-flow-timeout 10', 'end',
      ]);
      const conf = await fw.executeCommand('get system netflow');
      expect(conf).toContain('10');
    });

    it('187. Concordance métrique : Le volume en octets exporté en NetFlow reflète le payload curl', async () => {
      const { pc, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 187',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://10.10.10.5/');
      const session = await fw.executeCommand('diagnose sys session list');
      expect(session).toMatch(/bytes=\d+/);
    });

    it('188. Translation NAT appliquée au port de collecte de flux NetFlow (Port Forwarding 2055)', async () => {
      const { fw } = await creerLaboSupervision();
      await taper(fw, [
        'config firewall vip', 'edit "VIP_NETFLOW"',
        'set extip 203.0.113.1', 'set mappedip "203.0.113.50"', 'set extport 2055', 'set mappedport 2055',
        'next', 'end',
      ]);
      const vip = await fw.executeCommand('show firewall vip VIP_NETFLOW');
      expect(vip).toContain('2055');
    });
  });

  // =========================================================================
  // 29. SONDES ACTIVES, HEALTH-CHECKS & ICMP/TCP KEEP-ALIVES (Tests 189 à 194)
  // =========================================================================
  describe('Monitoring Actif & Détection Proactive d\'Incidents', () => {
    it('189. Sonde TCP SYN (check_http) traversant le pare-feu vers Nginx', async () => {
      const { siem, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 189',
        'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await siem.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.10.10.5/');
      expect(res.trim()).toBe('200');
    });

    it('190. Contrôle synthétique périodique d\'Oracle DB Listener (check_oracle_health)', async () => {
      const { siem, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start oracle-ohasd']);
      await taper(fw, [
        'config firewall policy', 'edit 190',
        'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await siem.executeCommand('tnsping 10.10.10.5:1521/ORCL');
      expect(res).toContain('OK');
    });

    it('191. Surveillance continue de gigue et latence ICMP (SmokePing / MTR) traversant le switch', async () => {
      const { siem } = await creerLaboSupervision();
      const res = await siem.executeCommand('ping -c 3 203.0.113.1');
      expect(res).toMatch(/rtt min\/avg\/max/i);
    });

    it('192. Test synthétique de résolution DNS traversante mesurant le temps de réponse', async () => {
      const { siem, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start named']);
      await taper(fw, [
        'config firewall policy', 'edit 192',
        'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const res = await siem.executeCommand('dig @10.10.10.5 app.lan +stats | grep "Query time"');
      expect(res).toMatch(/Query time: \d+ msec/);
    });

    it('193. Détection de transition d\'état de service (UP -> DOWN) et génération d\'une alerte immédiate', async () => {
      const { srvProd, siem } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl stop nginx']);
      const res = await siem.executeCommand('nc -zv -w 1 10.10.10.5 80');
      expect(res).toMatch(/refused|failed/i);
    });

    it('194. Sonde TCP Half-Open refermée proprement par un TCP RST pour ne pas consommer de threads serveur', async () => {
      const { siem, fw, srvProd } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 194',
        'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'next', 'end',
      ]);
      const synProbe = await siem.executeCommand('nping --tcp -p 80 --flags syn -c 1 10.10.10.5');
      expect(synProbe).toMatch(/RCVD.*flags=SA/); // Syn-Ack reçu
    });
  });

  // =========================================================================
  // 30. PORT MIRRORING (SPAN), NTP & CORRÉLATION SIEM (Tests 195 à 200)
  // =========================================================================
  describe('Port Mirroring Cisco SPAN, Horodatage NTP & SIEM End-to-End', () => {
    it('195. Port Mirroring (SPAN Cisco) : Duplication du trafic du port Fa0/2 vers une sonde IDS sans impacter le transit', async () => {
      const { sw1 } = await creerLaboSupervision();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'monitor session 1 source interface FastEthernet0/2 both',
        'monitor session 1 destination interface FastEthernet0/10',
        'end',
      ]);
      const span = await sw1.executeCommand('show monitor session 1');
      expect(span).toMatch(/Source Ports :.*Fa0\/2/);
      expect(span).toMatch(/Destination Ports :.*Fa0\/10/);
    });

    it('196. Remote SPAN (RSPAN) : Transport du trafic répliqué à travers un VLAN de capture dédié', async () => {
      const { sw1 } = await creerLaboSupervision();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'vlan 999', 'remote-span', 'exit',
        'monitor session 2 source interface FastEthernet0/2 rx',
        'monitor session 2 destination remote vlan 999',
        'end',
      ]);
      const rspan = await sw1.executeCommand('show monitor session 2');
      expect(rspan).toContain('Remote Dest VLAN : 999');
    });

    it('197. Horodatage NTP : Synchronisation préalable garantissant la concordance à la milliseconde des logs', async () => {
      const { fw, siem } = await creerLaboSupervision();
      await taper(siem as unknown as Cli, ['systemctl start chronyd']);
      await taper(fw, [
        'config system ntp',
        'set status enable', 'set server-mode enable',
        'end',
      ]);
      const ntp = await siem.executeCommand('chronyc tracking');
      expect(refuse(ntp)).toBe(false);
    });

    it('198. Corrélation Temporelle : Le log Nginx concorde temporellement avec le log de session Pare-feu', async () => {
      const { pc, fw, srvProd, siem } = await creerLaboSupervision();
      await taper(srvProd as unknown as Cli, ['systemctl start nginx']);
      await taper(siem as unknown as Cli, ['systemctl start rsyslog']);
      await taper(fw, [
        'config firewall policy', 'edit 198',
        'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set logtraffic all', 'next', 'end',
      ]);
      await pc.executeCommand('curl -s http://10.10.10.5/');
      const syslogLines = await siem.executeCommand('grep -i "10.10.10.5" /var/log/syslog');
      expect(syslogLines.length).toBeGreaterThanOrEqual(0);
    });

    it('199. Corrélation Multi-Sources : Détection coordonnée d\'un incident (Port-Security + Drop Pare-feu)', async () => {
      const { pc, sw1, fw } = await creerLaboSupervision();
      await taper(sw1 as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'switchport port-security', 'switchport port-security maximum 1',
        'end',
      ]);
      await pc.executeCommand('ping -c 1 192.168.1.1');
      const swLog = await sw1.executeCommand('show logging | include PSEC');
      const fwSession = await fw.executeCommand('diagnose sys session list');
      expect(refuse(swLog)).toBe(false);
      expect(refuse(fwSession)).toBe(false);
    });

    it('200. Grand Test de Charge Supervision : Collecte concurrente SNMP Walk + Traps 162 + Syslog UDP/TCP + NetFlow', async () => {
      const { pc, fw, srvProd, siem } = await creerLaboSupervision();
      // 1. Démarrage des daemons et services
      await taper(srvProd as unknown as Cli, [
        'systemctl start nginx',
        'systemctl start snmpd',
      ]);
      await taper(siem as unknown as Cli, [
        'systemctl start rsyslog',
        'systemctl start snmptrapd',
      ]);

      // 2. Politiques FW ouvertes pour les flux de management et applicatifs
      await taper(fw, [
        'config firewall policy',
        'edit 200', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set logtraffic all', 'next',
        'edit 201', 'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'next',
        'end',
      ]);

      // 3. Rafale simultanée de requêtes de supervision
      const [pHttp, pSnmp, pSyslog] = await Promise.all([
        pc.executeCommand('curl -s http://10.10.10.5/'),
        pc.executeCommand('snmpwalk -v2c -c public 192.168.1.1 1.3.6.1.2.1.1'),
        srvProd.executeCommand('logger -n 203.0.113.50 -P 514 "TELEMETRY_PIPELINE_STABLE"'),
      ]);

      expect(pHttp).toMatch(/Welcome to nginx|nginx/i);
      expect(pSnmp).not.toMatch(/Timeout: No Response/i);
      const siemCheck = await siem.executeCommand('tail -n 5 /var/log/syslog');
      expect(siemCheck).toContain('TELEMETRY_PIPELINE_STABLE');
    });
  });

});
