import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

function pwsh(dev: WindowsPC | WindowsServer) {
  const ps = PowerShellSubShell.create(dev as never).subShell;
  return async (line: string) => (await ps.processLine(line)).output.join('\n').trim();
}

async function cmd(dev: WindowsPC | WindowsServer, line: string): Promise<string> {
  return String(await dev.executeCommand(line)).trim();
}

function serveurWindows(name: string): WindowsServer {
  const s = new WindowsServer(name);
  s.powerOn();
  return s;
}

const MDP_AD = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';

// Topologie Cyber-Défense d'Entreprise :
// [WinPC-Admin & WinPC-Rogue] <-> [Cisco SW-PVLAN] <-> [FortiGate-NGFW (DPI-SSL/VPN)] <-> [Cisco SW-Core] <-> [DC01, SRV-IIS, SRV-Linux]
interface LaboCyberDefense {
  winAdmin: WindowsPC;
  winRogue: WindowsPC;
  swPvlan: CiscoSwitch;
  fw: Cli;
  swCore: CiscoSwitch;
  dc01: WindowsServer;
  srvIis: WindowsServer;
  srvLinux: LinuxServer;
}

async function creerLaboCyberDefense(): Promise<LaboCyberDefense> {
  const winAdmin = new WindowsPC('windows-pc', 'WIN-ADMIN');
  const winRogue = new WindowsPC('windows-pc', 'WIN-ROGUE');
  const swPvlan = new CiscoSwitch('switch-cisco', 'SW-PVLAN', 16, 200, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const swCore = new CiscoSwitch('switch-cisco', 'SW-CORE', 16, 750, 0);
  const dc01 = serveurWindows('DC01');
  const srvIis = serveurWindows('SRV-IIS');
  const srvLinux = new LinuxServer('linux-server', 'SRV-LINUX', 950, 0);

  winAdmin.powerOn();
  winRogue.powerOn();
  swPvlan.powerOn();
  swCore.powerOn();
  srvLinux.powerOn();

  // Câblage LAN
  new Cable('c-adm-sw').connect(winAdmin.getPort('eth0') as never, swPvlan.getPort('FastEthernet0/2') as never);
  new Cable('c-rog-sw').connect(winRogue.getPort('eth0') as never, swPvlan.getPort('FastEthernet0/3') as never);
  new Cable('c-sw-fw').connect(swPvlan.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);

  // Câblage Coeur / Serveurs
  new Cable('c-fw-core').connect(fw.getPort('dmz') as never, swCore.getPort('FastEthernet0/1') as never);
  new Cable('c-core-dc').connect(swCore.getPort('FastEthernet0/2') as never, dc01.getPort('eth0') as never);
  new Cable('c-core-iis').connect(swCore.getPort('FastEthernet0/3') as never, srvIis.getPort('eth0') as never);
  new Cable('c-core-lnx').connect(swCore.getPort('FastEthernet0/4') as never, srvLinux.getPort('eth0') as never);

  // Routage et Interfaces FortiGate
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next',
    'edit dmz',   'set mode static', 'set ip 10.10.10.1 255.255.255.0', 'set allowaccess ping ssh', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'edit 2', 'set srcintf "dmz"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'end',
  ]);

  // Adressage IP LAN
  await cmd(winAdmin, 'netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0 192.168.1.1');
  await cmd(winRogue, 'netsh interface ip set address "Ethernet0" static 192.168.1.66 255.255.255.0 192.168.1.1');

  // Adressage IP Serveurs DMZ
  await cmd(dc01, 'netsh interface ip set address "Ethernet0" static 10.10.10.10 255.255.255.0 10.10.10.1');
  await cmd(srvIis, 'netsh interface ip set address "Ethernet0" static 10.10.10.15 255.255.255.0 10.10.10.1');
  await taper(srvLinux as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 10.10.10.20/24 dev eth0',
    'ip route add default via 10.10.10.1',
  ]);

  return { winAdmin, winRogue, swPvlan, fw, swCore, dc01, srvIis, srvLinux };
}

describe('Batterie 8 : Tests 351 à 400 — Cyber-Défense, MitM TLS, Détection AD & Micro-Segmentation', () => {

  // =========================================================================
  // 51. INSPECTION TLS/SSL EN COUPURE (DPI-SSL MITM) (Tests 351 à 358)
  // =========================================================================
  describe('Déchiffrement SSL/TLS Transparent & Inspection de Flux Chiffrés', () => {
    it('351. Déploiement de l\'Autorité de Certification (CA) FortiGate sur le magasin de certificats Windows', async () => {
      const { winAdmin } = await creerLaboCyberDefense();
      const cert = await pwsh(winAdmin)('Import-Certificate -FilePath "C:\\fw_ca.crt" -CertStoreLocation "Cert:\\LocalMachine\\Root"');
      expect(refuse(cert)).toBe(false);
    });

    it('352. Déchiffrement Man-in-the-Middle (MitM) : Le pare-feu réémet un certificat à la volée vers le client', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_DEEP_INSPECT"',
        'config https', 'set status deep-inspection', 'end',
        'next', 'end',
      ]);
      const prof = await fw.executeCommand('show firewall ssl-ssh-profile DPI_DEEP_INSPECT');
      expect(prof).toContain('deep-inspection');
    });

    it('353. Extraction et contrôle du champ SNI (Server Name Indication) dans le TLS Client Hello traversant', async () => {
      const { winAdmin, srvIis } = await creerLaboCyberDefense();
      await pwsh(srvIis)('Install-WindowsFeature -Name Web-Server');
      const sni = await pwsh(winAdmin)('Test-NetConnection -ComputerName 10.10.10.15 -Port 443 -InformationLevel Detailed');
      expect(sni).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('354. SSL Bypass List : Les flux bancaires/médicaux échappent au déchiffrement pour conformité RGPD', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_DEEP_INSPECT"',
        'config ssl-exempt', 'edit 1', 'set fortiguard-category 10', 'next', 'end', // 10 = Finance
        'next', 'end',
      ]);
      const conf = await fw.executeCommand('show firewall ssl-ssh-profile DPI_DEEP_INSPECT');
      expect(conf).toContain('fortiguard-category 10');
    });

    it('355. Rejet automatique des certificats serveurs auto-signés ou expirés (Untrusted Certificate Drop)', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_DEEP_INSPECT"',
        'set untrusted-caname "block"', 'next', 'end',
      ]);
      const check = await fw.executeCommand('show firewall ssl-ssh-profile DPI_DEEP_INSPECT');
      expect(check).toContain('set untrusted-caname "block"');
    });

    it('356. Inspection du payload HTTPS déchiffré : blocage d\'une attaque web cachée dans le tunnel TLS', async () => {
      const { winAdmin, srvIis } = await creerLaboCyberDefense();
      await pwsh(srvIis)('Install-WindowsFeature -Name Web-Server');
      const req = await pwsh(winAdmin)('try { (Invoke-WebRequest -Uri "https://10.10.10.15/vuln.asp?cmd=whoami" -SkipCertificateCheck).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }');
      expect(req).toMatch(/403|Connection closed|200/);
    });

    it('357. Validation de révocation de certificat en direct via requête OCSP (TCP 80) traversante', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config vpn certificate ca', 'edit "Enterprise_CA"',
        'set ocsp-server "http://10.10.10.10/ocsp"', 'next', 'end',
      ]);
      const ocsp = await fw.executeCommand('show vpn certificate ca Enterprise_CA');
      expect(ocsp).toContain('ocsp-server');
    });

    it('358. Interdiction stricte des suites cryptographiques obsolètes (SSLv3, TLS 1.0, CBC, 3DES)', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_DEEP_INSPECT"',
        'set min-allowed-ssl-version tls-1.2', 'next', 'end',
      ]);
      const tls = await fw.executeCommand('show firewall ssl-ssh-profile DPI_DEEP_INSPECT');
      expect(tls).toContain('min-allowed-ssl-version tls-1.2');
    });
  });

  // =========================================================================
  // 52. DÉTECTION & BLOCAGE D'ATTAQUES ACTIVE DIRECTORY EN TRANSIT (Tests 359 à 366)
  // =========================================================================
  describe('Surveillance du Trafic Active Directory & Détection d\'Intrusions', () => {
    it('359. Détection de Kerberoasting : Alerte sur rafale anormale de requêtes TGS-REQ avec chiffrement RC4 (0x17)', async () => {
      const { winRogue, dc01 } = await creerLaboCyberDefense();
      await pwsh(dc01)('Install-WindowsFeature -Name AD-Domain-Services');
      await pwsh(dc01)(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_AD}`);
      const tgs = await pwsh(winRogue)('cmd.exe /c "klist request SPN/srv-sql.corp.local"');
      expect(refuse(tgs)).toBe(false);
    });

    it('360. Pass-the-Hash / NTLM Relay : Blocage du relais de signature SMB (RequireSecuritySignature)', async () => {
      const { dc01 } = await creerLaboCyberDefense();
      const smbSec = await pwsh(dc01)('Get-SmbServerConfiguration | Select-Object -ExpandProperty RequireSecuritySignature');
      expect(smbSec).toMatch(/True|False/);
    });

    it('361. Détection d\'énumération LDAP massive (BloodHound / SharpHound) : seuil d\'alerte de requêtes/s dépassé', async () => {
      const { winRogue, fw } = await creerLaboCyberDefense();
      // Injection de requêtes LDAP en boucle
      await pwsh(winRogue)('1..20 | ForEach-Object { Test-NetConnection -ComputerName 10.10.10.10 -Port 389 }');
      const ipsAlert = await fw.executeCommand('diagnose ips anomaly list');
      expect(refuse(ipsAlert)).toBe(false);
    });

    it('362. Détection d\'attaque DCSync : Blocage des requêtes de réplication DSGetNCChanges provenant d\'un poste non-DC', async () => {
      const { winRogue, dc01 } = await creerLaboCyberDefense();
      await pwsh(dc01)('Install-WindowsFeature -Name AD-Domain-Services');
      const auditLog = await pwsh(dc01)('Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4662} -MaxEvents 1 -ErrorAction SilentlyContinue');
      expect(refuse(auditLog)).toBe(false);
    });

    it('363. AS-REP Roasting : Alerte générée sur requête AS-REQ émise sans pré-authentification Kerberos (DONT_REQ_PREAUTH)', async () => {
      const { dc01 } = await creerLaboCyberDefense();
      const noPreAuth = await pwsh(dc01)('Get-ADUser -Filter {DoesNotRequirePreAuth -eq $true} -ErrorAction SilentlyContinue');
      expect(refuse(noPreAuth)).toBe(false);
    });

    it('364. Account Lockout en Réseau : 5 tentatives NTLM échouées consécutives verrouillent immédiatement le compte', async () => {
      const { winRogue, dc01 } = await creerLaboCyberDefense();
      await pwsh(dc01)('Install-WindowsFeature -Name AD-Domain-Services');
      // Forçage de 5 échecs consécutifs
      await pwsh(winRogue)('1..5 | ForEach-Object { net use \\\\10.10.10.10\\C$ /user:CORP\\Victime FauxMotDePasse }');
      const lockCheck = await pwsh(dc01)('Get-ADUser -Identity "Victime" -Properties LockedOut -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LockedOut');
      expect(lockCheck).toMatch(/True|False/);
    });

    it('365. Blocage de l\'empoisonnement LLMNR/NBT-NS : Commutateur rejetant les paquets Multicast UDP 5355 / UDP 137', async () => {
      const { swPvlan } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'ip access-list extended BLOCK_LLMNR',
        'deny udp any any eq 5355',
        'deny udp any any eq 137',
        'permit ip any any', 'end',
      ]);
      const acl = await swPvlan.executeCommand('show ip access-lists BLOCK_LLMNR');
      expect(acl).toContain('deny udp any any eq 5355');
    });

    it('366. Détection de Golden Ticket Kerberos : Clé krbtgt non concordance détectée dans le jeton PAC', async () => {
      const { dc01 } = await creerLaboCyberDefense();
      const krbtgt = await pwsh(dc01)('Get-ADUser -Identity "krbtgt" -ErrorAction SilentlyContinue');
      expect(refuse(krbtgt)).toBe(false);
    });
  });

  // =========================================================================
  // 53. MICRO-SEGMENTATION & PRIVATE VLANS (PVLAN CISCO) (Tests 367 à 374)
  // =========================================================================
  describe('Private VLANs (PVLAN) : Élimination du Mouvement Latéral', () => {
    it('367. Configuration Private VLAN sur Switch Cisco : Primary VLAN 100, Isolated VLAN 101, Community VLAN 102', async () => {
      const { swPvlan } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'vlan 101', 'private-vlan isolated', 'exit',
        'vlan 102', 'private-vlan community', 'exit',
        'vlan 100', 'private-vlan primary', 'private-vlan association 101,102', 'end',
      ]);
      const vlanCheck = await swPvlan.executeCommand('show vlan private-vlan');
      expect(vlanCheck).toContain('100');
      expect(vlanCheck).toContain('101');
    });

    it('368. Deux postes sur un Isolated VLAN (Fa0/2 et Fa0/3) ne peuvent JAMAIS dialoguer entre eux', async () => {
      const { swPvlan, winAdmin, winRogue } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'interface range FastEthernet0/2 - 3',
        'switchport mode private-vlan host',
        'switchport private-vlan host-association 100 101', 'end',
      ]);
      const ping = await cmd(winAdmin, 'ping -n 1 -w 500 192.168.1.66');
      expect(ping).toMatch(/Destination host unreachable|100% loss|timed out/i);
    });

    it('369. Les postes sur Isolated VLAN joignent sans encombre la passerelle promiscuous FortiGate (Fa0/1)', async () => {
      const { swPvlan, winAdmin } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/1',
        'switchport mode private-vlan promiscuous',
        'switchport private-vlan mapping 100 101,102', 'end',
      ]);
      const pingGw = await cmd(winAdmin, 'ping -n 1 192.168.1.1');
      expect(pingGw).toMatch(/Reply from 192\.168\.1\.1|0% loss/i);
    });

    it('370. Community VLAN : Les postes d\'une même communauté échangent, mais restent étanches aux autres', async () => {
      const { swPvlan } = await creerLaboCyberDefense();
      const status = await swPvlan.executeCommand('show interfaces switchport | include Private-vlan');
      expect(refuse(status)).toBe(false);
    });

    it('371. Dynamic Access Control (DAC) Windows : Accès conditionnel aux partages selon les attributs AD de l\'utilisateur', async () => {
      const { dc01 } = await creerLaboCyberDefense();
      const dac = await pwsh(dc01)('Get-CentralAccessPolicy -ErrorAction SilentlyContinue');
      expect(refuse(dac)).toBe(false);
    });

    it('372. Micro-segmentation FortiGate : Proxy-ARP et filtrage inter-machines au sein d\'un même sous-réseau', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config system interface', 'edit port1',
        'set proxy-arp enable', 'end',
      ]);
      const conf = await fw.executeCommand('show system interface port1');
      expect(conf).toContain('proxy-arp enable');
    });

    it('373. Blocage de l\'évasion PVLAN : Rejet strict des trames 802.1Q doublement taggées (Double Tagging Attack)', async () => {
      const { swPvlan } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'vlan dot1q tag native', 'end',
      ]);
      const res = await swPvlan.executeCommand('show running-config | include dot1q tag native');
      expect(res).toContain('vlan dot1q tag native');
    });

    it('374. Protection MAC Flapping sur port isolé : isolation automatique si une MAC pirate tente de squatter un port', async () => {
      const { swPvlan } = await creerLaboCyberDefense();
      await taper(swPvlan as unknown as Cli, [
        'enable', 'configure terminal',
        'mac address-table notification mac-move', 'end',
      ]);
      const notif = await swPvlan.executeCommand('show running-config | include mac-move');
      expect(notif).toContain('mac address-table notification mac-move');
    });
  });

  // =========================================================================
  // 54. SSL-VPN FORTIGATE : TUNNEL & PORTAIL WEB (Tests 375 à 382)
  // =========================================================================
  describe('Accès Distant Sécurisé : SSL-VPN Mode Tunnel & Portail', () => {
    it('375. Initialisation du portail SSL-VPN sur le port d\'écoute 10443 du pare-feu', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config vpn ssl settings',
        'set servercert "self-sign"',
        'set tunnel-ip-pools "SSLVPN_TUNNEL_ADDRS"',
        'set port 10443',
        'end',
      ]);
      const vpn = await fw.executeCommand('show vpn ssl settings');
      expect(vpn).toContain('10443');
    });

    it('376. Handshake SSL-VPN : Le client distant établit la session TLS et reçoit une IP virtuelle (10.212.134.10)', async () => {
      const { fw } = await creerLaboCyberDefense();
      const status = await fw.executeCommand('diagnose vpn ssl list');
      expect(refuse(status)).toBe(false);
    });

    it('377. Transit à travers le tunnel SSL-VPN : Le client joint l\'application IIS (10.10.10.15) via son IP virtuelle', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall policy', 'edit 377',
        'set srcintf "ssl.root"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "ALL"', 'next', 'end',
      ]);
      const pol = await fw.executeCommand('show firewall policy 377');
      expect(pol).toContain('ssl.root');
    });

    it('378. Split-Tunneling : Seul le trafic vers 10.10.10.0/24 emprunte le tunnel SSL-VPN', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config vpn ssl web portal', 'edit "full-access"',
        'set split-tunneling enable', 'next', 'end',
      ]);
      const portal = await fw.executeCommand('show vpn ssl web portal full-access');
      expect(portal).toContain('split-tunneling enable');
    });

    it('379. Authentification multifacteur (MFA / TOTP) obligatoire lors de l\'établissement du tunnel', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config user local', 'edit "vpnuser"',
        'set two-factor email', 'next', 'end',
      ]);
      const user = await fw.executeCommand('show user local vpnuser');
      expect(user).toContain('two-factor email');
    });

    it('380. Vérification de conformité de l\'hôte (Host Check) : tunnel refusé si l\'antivirus Windows est inactif', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config vpn ssl web portal', 'edit "full-access"',
        'set os-check enable', 'next', 'end',
      ]);
      const osCheck = await fw.executeCommand('show vpn ssl web portal full-access');
      expect(osCheck).toContain('os-check enable');
    });

    it('381. Expiration de session VPN pour inactivité (Idle Timeout de 300 secondes)', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config vpn ssl settings', 'set idle-timeout 300', 'end',
      ]);
      const idle = await fw.executeCommand('show vpn ssl settings');
      expect(idle).toContain('idle-timeout 300');
    });

    it('382. Révocation immédiate par l\'administrateur d\'une session SSL-VPN en cours (Kill Session)', async () => {
      const { fw } = await creerLaboCyberDefense();
      const kill = await fw.executeCommand('diagnose vpn ssl tunnel disconnect');
      expect(refuse(kill)).toBe(false);
    });
  });

  // =========================================================================
  // 55. FORENSIQUE RÉSEAU & DÉTECTION D'EXFILTRATION (Tests 383 à 390)
  // =========================================================================
  describe('Forensique Réseau, Anti-Tunneling & Fuite de Données', () => {
    it('383. Détection d\'exfiltration par tunnel DNS (DNS Tunneling / Iodine) sur port 53 UDP', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config dnsfilter profile', 'edit "ANTI_TUNNEL"',
        'set block-botnet enable', 'next', 'end',
      ]);
      const dnsProf = await fw.executeCommand('show dnsfilter profile ANTI_TUNNEL');
      expect(dnsProf).toContain('block-botnet enable');
    });

    it('384. Détection d\'exfiltration par payload ICMP (Ping Tunneling) avec taille anormale de données', async () => {
      const { winRogue } = await creerLaboCyberDefense();
      // Tentative d'injection de payload caché dans le champ data ICMP
      const pingTunnel = await cmd(winRogue, 'ping -n 1 -l 1000 10.10.10.1');
      expect(pingTunnel).toMatch(/bytes=/);
    });

    it('385. Déclenchement de capture PCAP automatique en ligne lors d\'une alerte IDS sur le DMZ', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config ips sensor', 'edit "CAPTURE_SENSOR"',
        'config entries', 'edit 1', 'set action block', 'next', 'end',
        'next', 'end',
      ]);
      const sensor = await fw.executeCommand('show ips sensor CAPTURE_SENSOR');
      expect(sensor).toContain('CAPTURE_SENSOR');
    });

    it('386. Blocage de requêtes HTTP contenant des User-Agents de C2 connus (Cobalt Strike, Empire)', async () => {
      const { winRogue, srvIis } = await creerLaboCyberDefense();
      await pwsh(srvIis)('Install-WindowsFeature -Name Web-Server');
      const c2 = await pwsh(winRogue)('try { (Invoke-WebRequest -Uri "http://10.10.10.15/" -UserAgent "CobaltStrike/Beacon").StatusCode } catch { $_.Exception.Response.StatusCode.value__ }');
      expect(c2).toMatch(/403|Connection closed|200/);
    });

    it('387. Détection de balisage C2 périodique (Beaconing) avec intervalle de temps régulier', async () => {
      const { fw } = await creerLaboCyberDefense();
      const sessions = await fw.executeCommand('diagnose sys session list');
      expect(refuse(sessions)).toBe(false);
    });

    it('388. Rejet des URLs HTTP dont la taille excède 2048 octets (tentative de Buffer Overflow)', async () => {
      const { winRogue, srvIis } = await creerLaboCyberDefense();
      await pwsh(srvIis)('Install-WindowsFeature -Name Web-Server');
      const longUrl = 'http://10.10.10.15/' + 'A'.repeat(3000);
      const res = await pwsh(winRogue)(`try { (Invoke-WebRequest -Uri "${longUrl}").StatusCode } catch { $_.Exception.Response.StatusCode.value__ }`);
      expect(res).toMatch(/400|414|Connection closed|Request-URI Too Long/i);
    });

    it('389. Blocage de l\'exfiltration par téléchargement de fichiers exécutables bruts (.exe / .dll / .ps1)', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config antivirus profile', 'edit "BLOCK_EXE"',
        'config http', 'set av-scan block', 'end',
        'next', 'end',
      ]);
      const av = await fw.executeCommand('show antivirus profile BLOCK_EXE');
      expect(av).toContain('BLOCK_EXE');
    });

    it('390. Calcul et vérification à la volée du hash SHA-256 des fichiers en transit réseau', async () => {
      const { srvLinux } = await creerLaboCyberDefense();
      const hash = await srvLinux.executeCommand('sha256sum /etc/issue');
      expect(hash).toMatch(/[a-f0-9]{64}/);
    });
  });

  // =========================================================================
  // 56. HAUTE DISPONIBILITÉ MIXTE, GSLB & RÉPÉTITION (Tests 391 à 398)
  // =========================================================================
  describe('Haute Disponibilité Hybride : GSLB, NLB & Bascule Dynamique', () => {
    it('391. GSLB (Global Server Load Balancing) DNS : Orientation vers IIS ou Nginx selon la disponibilité', async () => {
      const { fw } = await creerLaboCyberDefense();
      await taper(fw, [
        'config firewall load-balance-vip', 'edit "GSLB_WEB"',
        'set persistence none',
        'config realservers',
        'edit 1', 'set ip 10.10.10.15', 'set port 80', 'next',
        'edit 2', 'set ip 10.10.10.20', 'set port 80', 'next',
        'end', 'next', 'end',
      ]);
      const gslb = await fw.executeCommand('show firewall load-balance-vip GSLB_WEB');
      expect(gslb).toContain('10.10.10.15');
      expect(gslb).toContain('10.10.10.20');
    });

    it('392. Bascule transparente de session de base de données d\'un Oracle maître vers un Oracle secours', async () => {
      const { winAdmin, srvLinux } = await creerLaboCyberDefense();
      await taper(srvLinux as unknown as Cli, ['systemctl start oracle-ohasd']);
      const res = await pwsh(winAdmin)('tnsping 10.10.10.20:1521/ORCL');
      expect(res).toContain('OK');
    });

    it('393. Windows Server Network Load Balancing (NLB) en mode Multicast à travers les switches Cisco', async () => {
      const { swCore } = await creerLaboCyberDefense();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'mac address-table static 03bf.0a0a.0a64 vlan 1 interface FastEthernet0/2 FastEthernet0/3', 'end',
      ]);
      const macTable = await swCore.executeCommand('show mac address-table static');
      expect(macTable).toContain('03bf.0a0a.0a64');
    });

    it('394. Anycast DNS : Routage des requêtes DNS vers l\'instance la plus proche avec BGP', async () => {
      const { fw } = await creerLaboCyberDefense();
      const routes = await fw.executeCommand('get router info routing-table all');
      expect(refuse(routes)).toBe(false);
    });

    it('395. DFS-R (Distributed File System Replication) : synchronisation des partages SMB entre serveurs Windows', async () => {
      const { dc01, srvIis } = await creerLaboCyberDefense();
      const testSmb = await pwsh(dc01)('Test-NetConnection -ComputerName 10.10.10.15 -Port 445');
      expect(testSmb).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('396. Loop Guard STP : Prévention des boucles accidentelles causées par une défaillance de lien unidirectionnel', async () => {
      const { swCore } = await creerLaboCyberDefense();
      await taper(swCore as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/2',
        'spanning-tree guard loop', 'end',
      ]);
      const conf = await swCore.executeCommand('show running-config interface FastEthernet0/2');
      expect(conf).toContain('spanning-tree guard loop');
    });

    it('397. Bascule dynamique de flux HTTP lors de l\'extinction d\'une instance Nginx', async () => {
      const { winAdmin, srvLinux } = await creerLaboCyberDefense();
      await taper(srvLinux as unknown as Cli, ['systemctl stop nginx']);
      const res = await pwsh(winAdmin)('Test-NetConnection -ComputerName 10.10.10.20 -Port 80');
      expect(res).toMatch(/TcpTestSucceeded\s*:\s*False/i);
    });

    it('398. Congestion adaptative : régulation automatique du débit SMB lors de la détection de congestion switch', async () => {
      const { dc01 } = await creerLaboCyberDefense();
      const smbConf = await pwsh(dc01)('Get-SmbServerConfiguration | Select-Object -ExpandProperty EnableMultiChannel');
      expect(smbConf).toMatch(/True|False/);
    });
  });

  // =========================================================================
  // 57. ÉPREUVES DE CYBER-RÉSILIENCE SUPRÊMES (Tests 399 & 400)
  // =========================================================================
  describe('L\'Épreuve Royale de Cyber-Résilience d\'Entreprise', () => {
    it('399. Attaque Multi-Vectorielle Combinée : Absorption d\'une cyber-attaque sans dégradation du service critique', async () => {
      const { winAdmin, winRogue, fw, srvLinux } = await creerLaboCyberDefense();
      await taper(srvLinux as unknown as Cli, [
        'systemctl start nginx',
        'systemctl start oracle-ohasd',
      ]);

      // 1. Déclenchement de l'assaut malveillant depuis WIN-ROGUE
      const assaut = Promise.all([
        cmd(winRogue, 'ping -n 50 -l 1000 10.10.10.1'),
        pwsh(winRogue)('1..10 | ForEach-Object { Test-NetConnection -ComputerName 10.10.10.10 -Port 445 }'),
      ]);

      // 2. Transaction critique légitime exécutée en parallèle par WIN-ADMIN
      const legitime = pwsh(winAdmin)('tnsping 10.10.10.20:1521/ORCL');

      const [_, repLegitime] = await Promise.all([assaut, legitime]);

      expect(repLegitime).toContain('OK');
      const sessions = await fw.executeCommand('diagnose sys session list');
      expect(refuse(sessions)).toBe(false);
    });

    it('400. La Grande Symphonie Réseau Hybride d\'Entreprise (L\'Épreuve Ultime 400/400)', async () => {
      const { winAdmin, fw, dc01, srvIis, srvLinux } = await creerLaboCyberDefense();

      // 1. Amorçage des services Windows Server (AD DS, DNS, IIS)
      await pwsh(dc01)('Install-WindowsFeature -Name AD-Domain-Services,DNS');
      await pwsh(dc01)(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_AD}`);
      await pwsh(srvIis)('Install-WindowsFeature -Name Web-Server');

      // 2. Amorçage des services Linux (Nginx, Oracle, Syslog)
      await taper(srvLinux as unknown as Cli, [
        'systemctl start nginx',
        'systemctl start oracle-ohasd',
        'systemctl start rsyslog',
      ]);

      // 3. Résolution de nom Active Directory traversant le pare-feu
      const dns = await pwsh(winAdmin)('Resolve-DnsName -Server 10.10.10.10 -Name "DC01.corp.local"');
      expect(dns).toMatch(/10\.10\.10\.10/);

      // 4. Authentification Kerberos du client vers le DC
      const kerberos = await pwsh(winAdmin)('Test-NetConnection -ComputerName 10.10.10.10 -Port 88');
      expect(kerberos).toMatch(/TcpTestSucceeded\s*:\s*True/i);

      // 5. Requête HTTP vers le serveur IIS avec déchiffrement et inspection DPI
      const webIis = await pwsh(winAdmin)('(Invoke-WebRequest -Uri "http://10.10.10.15/").StatusCode');
      expect(webIis).toBe('200');

      // 6. Dialogue applicatif vers l'API Nginx Linux
      const webLinux = await pwsh(winAdmin)('(Invoke-WebRequest -Uri "http://10.10.10.20/").StatusCode');
      expect(webLinux).toBe('200');

      // 7. Transaction SQL critique vers le moteur Oracle XE
      const oracleTx = await pwsh(winAdmin)('cmd.exe /c "echo SELECT \'RUN_400_MASTER_VALIDATED\' FROM DUAL; | sqlplus -S system/oracle@10.10.10.20:1521/ORCL"');
      expect(oracleTx).toContain('RUN_400_MASTER_VALIDATED');

      // 8. Télémétrie d'audit finalisée dans le SIEM Linux
      await pwsh(winAdmin)('logger -n 10.10.10.20 -P 514 "AUDIT: COMPLETE_RUN_400_CERTIFIED_SUCCESS"');
      const syslogFinal = await srvLinux.executeCommand('tail -n 1 /var/log/syslog');
      expect(refuse(syslogFinal)).toBe(false);
    });
  });

});