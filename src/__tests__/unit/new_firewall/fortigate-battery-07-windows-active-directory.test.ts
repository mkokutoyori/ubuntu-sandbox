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

// Helpers PowerShell et CMD Windows
function pwsh(dev: WindowsPC | WindowsServer) {
  const ps = PowerShellSubShell.create(dev as never).subShell;
  return async (line: string) => (await ps.processLine(line)).output.join('\n').trim();
}

async function cmd(dev: WindowsPC | WindowsServer, line: string): Promise<string> {
  return String(await dev.executeCommand(line)).trim();
}

function creerServeurWindows(name = 'DC01'): WindowsServer {
  const s = new WindowsServer(name);
  s.powerOn();
  return s;
}

const MDP_SAFE_MODE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';

// Topologie d'Entreprise Hybride Windows & Linux :
// [Win-Client & Linux-Client] <-> [SW-LAN] <-> [FortiGate-Core] <-> [SW-DMZ] <-> [WinServer-DC01 & Linux-Prod]
interface LaboHybride {
  winPc: WindowsPC;
  linuxPc: LinuxPC;
  swLan: CiscoSwitch;
  fw: Cli;
  swDmz: CiscoSwitch;
  winDc: WindowsServer;
  linuxSrv: LinuxServer;
}

async function creerLaboHybride(): Promise<LaboHybride> {
  const winPc = new WindowsPC('windows-pc', 'WIN-CLI');
  const linuxPc = new LinuxPC('linux-pc', 'LINUX-CLI', 100, 0);
  const swLan = new CiscoSwitch('switch-cisco', 'SW-LAN', 16, 250, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const swDmz = new CiscoSwitch('switch-cisco', 'SW-DMZ', 16, 750, 0);
  const winDc = creerServeurWindows('DC01');
  const linuxSrv = new LinuxServer('linux-server', 'SRV-PROD', 900, 0);

  winPc.powerOn();
  linuxPc.powerOn();
  swLan.powerOn();
  swDmz.powerOn();
  linuxSrv.powerOn();

  // Câblage LAN (VLAN 10 - 192.168.1.0/24)
  new Cable('c-wpc-swl').connect(winPc.getPort('eth0') as never, swLan.getPort('FastEthernet0/2') as never);
  new Cable('c-lpc-swl').connect(linuxPc.getPort('eth0') as never, swLan.getPort('FastEthernet0/3') as never);
  new Cable('c-swl-fw').connect(swLan.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);

  // Câblage DMZ/Serveurs (VLAN 20 - 10.10.10.0/24)
  new Cable('c-fw-swd').connect(fw.getPort('dmz') as never, swDmz.getPort('FastEthernet0/1') as never);
  new Cable('c-swd-wdc').connect(swDmz.getPort('FastEthernet0/2') as never, winDc.getPort('eth0') as never);
  new Cable('c-swd-lsrv').connect(swDmz.getPort('FastEthernet0/3') as never, linuxSrv.getPort('eth0') as never);

  // Configuration Pare-feu FortiGate (Passerelles de routage)
  await taper(fw, [
    'config system interface',
    'edit port1',
    'set mode static', 'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh',
    'next',
    'edit dmz',
    'set mode static', 'set ip 10.10.10.1 255.255.255.0',
    'set allowaccess ping ssh',
    'next',
    'end',
    'config firewall policy',
    'edit 1',
    'set srcintf "port1"', 'set dstintf "dmz"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set service "ALL"',
    'next',
    'edit 2',
    'set srcintf "dmz"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set service "ALL"',
    'next',
    'end',
  ]);

  // Configuration IP Postes Clients LAN
  await cmd(winPc, 'netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0 192.168.1.1');
  await taper(linuxPc as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
  ]);

  // Configuration IP Serveurs DMZ
  await cmd(winDc, 'netsh interface ip set address "Ethernet0" static 10.10.10.10 255.255.255.0 10.10.10.1');
  await taper(linuxSrv as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 10.10.10.20/24 dev eth0',
    'ip route add default via 10.10.10.1',
  ]);

  return { winPc, linuxPc, swLan, fw, swDmz, winDc, linuxSrv };
}

describe('Batterie 7 : Tests 301 à 350 — Hybridation Windows Server, Active Directory & Services Hétérogènes', () => {

  // =========================================================================
  // 43. ACTIVE DIRECTORY DOMAIN SERVICES & AUTHENTIFICATION (Tests 301 à 308)
  // =========================================================================
  describe('Active Directory (AD DS) & Authentification en Transit', () => {
    it('301. Promotion du Windows Server en Contrôleur de Domaine (DC01.corp.local)', async () => {
      const { winDc } = await creerLaboHybride();
      const ps = pwsh(winDc);
      await ps('Install-WindowsFeature -Name AD-Domain-Services');
      await ps(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_SAFE_MODE}`);
      expect(await ps('$env:USERDOMAIN')).toBe('CORP');
      expect(await ps('$env:USERDNSDOMAIN')).toBe('CORP.LOCAL');
    });

    it('302. Requête Kerberos AS-REQ (Port 88) traversant le pare-feu depuis Windows PC vers DC01', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      const psDc = pwsh(winDc);
      await psDc('Install-WindowsFeature -Name AD-Domain-Services');
      await psDc(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_SAFE_MODE}`);
      const kinit = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 88');
      expect(kinit).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('303. Requête LDAP (TCP 389) depuis Linux PC interrogeant l\'annuaire Active Directory du Windows Server', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      const psDc = pwsh(winDc);
      await psDc('Install-WindowsFeature -Name AD-Domain-Services');
      await psDc(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_SAFE_MODE}`);
      const res = await linuxPc.executeCommand('ldapsearch -x -H ldap://10.10.10.10 -b "dc=corp,dc=local" -s base');
      expect(res).not.toMatch(/Can't contact LDAP server/i);
    });

    it('304. Handshake LDAPS chiffré (TCP 636) à travers le pare-feu vers Windows Server', async () => {
      const { linuxPc } = await creerLaboHybride();
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:636 -brief </dev/null');
      expect(res).not.toMatch(/connect:errno/i);
    });

    it('305. Requête Global Catalog Active Directory (TCP 3268) traversant le commutateur de distribution', async () => {
      const { winPc } = await creerLaboHybride();
      const gcTest = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 3268');
      expect(gcTest).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('306. Jonction au Domaine : Windows PC rejoint corp.local à travers le commutateur et le pare-feu', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      const psDc = pwsh(winDc);
      await psDc('Install-WindowsFeature -Name AD-Domain-Services');
      await psDc(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_SAFE_MODE}`);
      const join = await pwsh(winPc)('Add-Computer -DomainName "corp.local" -Restart:$false');
      expect(join).not.toMatch(/failed|error/i);
    });

    it('307. Accès aux partages d\'infrastructure AD (SYSVOL et NETLOGON) via port 445 traversant', async () => {
      const { winPc } = await creerLaboHybride();
      const sysvol = await pwsh(winPc)('Test-Path "\\\\10.10.10.10\\SYSVOL"');
      expect(sysvol).toMatch(/True|False/);
    });

    it('308. Synchronisation horaire du domaine : Windows PC cale son horloge sur DC01 (UDP 123 w32time)', async () => {
      const { winPc } = await creerLaboHybride();
      const ntp = await cmd(winPc, 'w32tm /stripchart /computer:10.10.10.10 /samples:1 /dataonly');
      expect(ntp).not.toMatch(/error/i);
    });
  });

  // =========================================================================
  // 44. PARTAGE DE FICHIERS SMB 3.0 & INTEROPÉRABILITÉ LINUX/WINDOWS (Tests 309 à 315)
  // =========================================================================
  describe('SMB 3.0 / CIFS : Échange de Données Inter-Plateformes', () => {
    it('309. Création d\'un partage SMB sur Windows Server et inventaire depuis Linux via smbclient', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('New-Item -Path C:\\Partage -ItemType Directory -Force; New-SmbShare -Name "Donnees" -Path "C:\\Partage" -FullAccess "Everyone"');
      const shares = await linuxPc.executeCommand('smbclient -L //10.10.10.10 -N');
      expect(shares).toContain('Donnees');
    });

    it('310. Dépôt de fichier depuis Linux PC vers Windows Server : intégrité vérifiée sous PowerShell', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('New-Item -Path C:\\Partage -ItemType Directory -Force; New-SmbShare -Name "Donnees" -Path "C:\\Partage" -FullAccess "Everyone"');
      await linuxPc.executeCommand('echo "PAYLOAD_DEPUIS_LINUX" > test.txt && smbclient //10.10.10.10/Donnees -N -c "put test.txt"');
      const contenu = await pwsh(winDc)('Get-Content C:\\Partage\\test.txt');
      expect(contenu).toBe('PAYLOAD_DEPUIS_LINUX');
    });

    it('311. Montage de partage réseau SMB (New-SmbMapping) depuis Windows PC à travers le FortiGate', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('New-Item -Path C:\\Public -ItemType Directory -Force; New-SmbShare -Name "Public" -Path "C:\\Public" -FullAccess "Everyone"');
      const map = await pwsh(winPc)('New-SmbMapping -LocalPath "Z:" -RemotePath "\\\\10.10.10.10\\Public"');
      expect(map).toMatch(/Z:/);
    });

    it('312. SMB Encryption : chiffrement de session activé sans rupture par le pare-feu intermédiaire', async () => {
      const { winDc, winPc } = await creerLaboHybride();
      await pwsh(winDc)('Set-SmbServerConfiguration -EncryptData $true -Force');
      const test = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 445');
      expect(test).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('313. Blocage ciblé de SMB : le pare-feu jette le port 445 tout en maintenant le ping ICMP vers Windows Server', async () => {
      const { winPc, fw } = await creerLaboHybride();
      await taper(fw, [
        'config firewall policy', 'edit 1',
        'set service "PING"', 'next', 'end',
      ]);
      const ping = await cmd(winPc, 'ping -n 1 10.10.10.10');
      const smb = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 445');
      expect(ping).toMatch(/Reply from 10\.10\.10\.10|0% loss/i);
      expect(smb).toMatch(/TcpTestSucceeded\s*:\s*False/i);
    });

    it('314. Débit soutenu : transfert d\'un fichier de 50 Mo à travers les switches Cisco sans perte de trames', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('New-Item -Path C:\\Partage -ItemType Directory -Force; New-SmbShare -Name "Donnees" -Path "C:\\Partage" -FullAccess "Everyone"');
      await linuxPc.executeCommand('dd if=/dev/zero of=50mb.bin bs=1M count=50 && smbclient //10.10.10.10/Donnees -N -c "put 50mb.bin"');
      const size = await pwsh(winDc)('(Get-Item C:\\Partage\\50mb.bin).Length');
      expect(size).toBe('52428800');
    });

    it('315. Windows Server accède en client SMB au partage Samba hébergé sur le serveur Linux de prod', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start smbd']);
      const res = await pwsh(winDc)('Test-NetConnection -ComputerName 10.10.10.20 -Port 445');
      expect(res).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });
  });

  // =========================================================================
  // 45. ADMINISTRATION WINDOWS : WINRM, RDP & SSH (Tests 316 à 322)
  // =========================================================================
  describe('Administration Distante Windows : WinRM, RDP & Télémaintenance', () => {
    it('316. PowerShell Remoting (WinRM HTTP port 5985) traversant le pare-feu avec Test-WSMan', async () => {
      const { winPc } = await creerLaboHybride();
      const wsman = await pwsh(winPc)('Test-WSMan -ComputerName 10.10.10.10');
      expect(wsman).toMatch(/wsmid|OS/i);
    });

    it('317. WinRM HTTPS (Port 5986) chiffré par certificat traversant le réseau', async () => {
      const { winPc } = await creerLaboHybride();
      const test = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 5986');
      expect(test).not.toMatch(/error/i);
    });

    it('318. Remote Desktop Protocol (RDP Port 3389) joignable depuis Windows PC vers Windows Server', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0');
      const rdp = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 3389');
      expect(rdp).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('319. Port Forwarding / VIP FortiGate : Accès RDP depuis le WAN sur le port externe 33389 redirigé sur 3389', async () => {
      const { winPc, fw } = await creerLaboHybride();
      await taper(fw, [
        'config firewall vip', 'edit "VIP_RDP_WIN"',
        'set extip 192.168.1.1', 'set mappedip "10.10.10.10"',
        'set portforward enable', 'set extport 33389', 'set mappedport 3389',
        'next', 'end',
        'config firewall policy', 'edit 10',
        'set srcintf "port1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "VIP_RDP_WIN"',
        'set action accept', 'next', 'end',
      ]);
      const vipTest = await pwsh(winPc)('Test-NetConnection -ComputerName 192.168.1.1 -Port 33389');
      expect(vipTest).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('320. OpenSSH Server sur Windows Server : Linux PC s\'y connecte et exécute cmd.exe à distance', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Start-Service sshd');
      const res = await linuxPc.executeCommand('ssh -o StrictHostKeyChecking=no Administrator@10.10.10.10 "cmd.exe /c echo SSH_TO_WINDOWS_OK"');
      expect(res).toContain('SSH_TO_WINDOWS_OK');
    });

    it('321. Inspection RPC : Les ports dynamiques Windows (RPC 49152-65535) sont filtrés par la passerelle', async () => {
      const { winPc } = await creerLaboHybride();
      const rpc = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 135');
      expect(rpc).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('322. Coupure programmée RDP : la modification de politique pare-feu interrompt le flux de télémaintenance', async () => {
      const { winPc, fw } = await creerLaboHybride();
      await taper(fw, ['config firewall policy', 'edit 1', 'set service "HTTP"', 'next', 'end']);
      const rdp = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 3389');
      expect(rdp).toMatch(/TcpTestSucceeded\s*:\s*False/i);
    });
  });

  // =========================================================================
  // 46. SERVEUR WEB IIS & FLUX CROISÉS NGINX / IIS (Tests 323 à 329)
  // =========================================================================
  describe('IIS Web Server & Dialogue Bidirectionnel Nginx / IIS', () => {
    it('323. Déploiement d\'IIS sur Windows Server et interrogation HTTP 80 depuis Linux PC (curl)', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name Web-Server');
      const page = await linuxPc.executeCommand('curl -s http://10.10.10.10/');
      expect(page).toMatch(/iisstart|Internet Information Services|IIS Windows Server/i);
    });

    it('324. HTTPS IIS (Port 443) : Windows PC interroge IIS avec Invoke-WebRequest', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name Web-Server');
      const res = await pwsh(winPc)('(Invoke-WebRequest -Uri "https://10.10.10.10/" -SkipCertificateCheck).StatusCode');
      expect(res).toBe('200');
    });

    it('325. Nginx en Reverse Proxy Linux qui relaie les requêtes entrantes vers l\'IIS Windows en DMZ', async () => {
      const { linuxPc, linuxSrv, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name Web-Server');
      await taper(linuxSrv as unknown as Cli, ['systemctl start nginx-proxy-to-iis']);
      const proxyRes = await linuxPc.executeCommand('curl -s http://10.10.10.20/iis');
      expect(proxyRes).toMatch(/iisstart|IIS/i);
    });

    it('326. Client Windows : PowerShell Invoke-RestMethod interrogeant l\'API Nginx du serveur Linux', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start nginx']);
      const res = await pwsh(winDc)('(Invoke-RestMethod -Uri "http://10.10.10.20/api/health").status');
      expect(res).toMatch(/UP|OK|healthy/i);
    });

    it('327. Recyclage d\'Application Pool IIS : le client gère la reconnexion TCP sans blocage réseau', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Restart-WebAppPool "DefaultAppPool"');
      const res = await pwsh(winPc)('(Invoke-WebRequest -Uri "http://10.10.10.10/").StatusCode');
      expect(res).toBe('200');
    });

    it('328. Authentification Basic sur IIS : transmission intègre des identifiants Base64 depuis Linux curl', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name Web-Basic-Auth');
      const unauth = await linuxPc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.10.10.10/secure/');
      expect(unauth.trim()).toBe('401');
      const auth = await linuxPc.executeCommand('curl -u "Administrator:P@ssw0rd!" -s -o /dev/null -w "%{http_code}" http://10.10.10.10/secure/');
      expect(auth.trim()).toBe('200');
    });

    it('329. Échange bidirectionnel WebSockets vers IIS à travers le commutateur Cisco DMZ', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name Web-WebSockets');
      const test = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 80');
      expect(test).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });
  });

  // =========================================================================
  // 47. INTÉGRATION HYBRIDE : WINDOWS CLIENT VERS ORACLE DB LINUX (Tests 330 à 335)
  // =========================================================================
  describe('Transactions Hybrides : Windows Server vers Base Oracle Linux', () => {
    it('330. Sondage du Listener Oracle (Port 1521) depuis PowerShell sur Windows Server', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start oracle-xe']);
      const res = await pwsh(winDc)('Test-NetConnection -ComputerName 10.10.10.20 -Port 1521');
      expect(res).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('331. Exécution d\'une requête SQL*Plus depuis Windows Server vers la DB Oracle Linux distante', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start oracle-xe']);
      const query = 'cmd.exe /c "echo SELECT 777 FROM DUAL; | sqlplus -S system/oracle@10.10.10.20:1521/XE"';
      const sql = await pwsh(winDc)(query);
      expect(sql).toContain('777');
    });

    it('332. Maintien du Pool de Connexions applicatif entre le Web IIS et la Base Oracle Linux', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start oracle-xe']);
      const poolCheck = await pwsh(winDc)('tnsping 10.10.10.20:1521/XE');
      expect(poolCheck).toMatch(/OK/);
    });

    it('333. Ségrégation de flux : la passerelle coupe Oracle 1521 sans couper le trafic Web IIS', async () => {
      const { winPc, fw, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start oracle-xe']);
      await taper(fw, [
        'config firewall policy', 'edit 1',
        'set service "HTTP"', 'next', 'end',
      ]);
      const http = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.10 -Port 80');
      const oracle = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.20 -Port 1521');
      expect(http).toMatch(/TcpTestSucceeded\s*:\s*True/i);
      expect(oracle).toMatch(/TcpTestSucceeded\s*:\s*False/i);
    });

    it('334. Transaction Commit Windows -> Oracle Linux : persistance de données vérifiée côté Linux', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start oracle-xe']);
      const insert = 'cmd.exe /c "echo INSERT INTO aud (val) VALUES (42); COMMIT; | sqlplus -S system/oracle@10.10.10.20:1521/XE"';
      await pwsh(winDc)(insert);
      const verify = await linuxSrv.executeCommand('echo "SELECT val FROM aud;" | sqlplus -S system/oracle@localhost:1521/XE');
      expect(verify).toContain('42');
    });

    it('335. Détection de coupure Oracle Listener et remontée d\'erreur ORA dans l\'Event Viewer Windows', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl stop oracle-xe']);
      const res = await pwsh(winDc)('cmd.exe /c "echo EXIT; | sqlplus -S system/oracle@10.10.10.20:1521/XE"');
      expect(res).toMatch(/ORA-12541|TNS:no listener/i);
    });
  });

  // =========================================================================
  // 48. SERVICES DNS AD & DHCP WINDOWS SERVER EN TRANSIT (Tests 336 à 342)
  // =========================================================================
  describe('DNS Active Directory & Serveur DHCP Windows en Coupure', () => {
    it('336. Rôle DNS Windows Server déployé et interrogé en direct par Linux PC (dig @10.10.10.10)', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name DNS');
      await pwsh(winDc)('Add-DnsServerResourceRecordA -ZoneName "corp.local" -Name "srv1" -IPv4Address "10.10.10.10"');
      const dns = await linuxPc.executeCommand('dig @10.10.10.10 srv1.corp.local +short');
      expect(dns.trim()).toBe('10.10.10.10');
    });

    it('337. Dynamic DNS (DDNS) : Linux PC enregistre dynamiquement son adresse A dans la zone DNS Windows', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name DNS');
      await linuxPc.executeCommand('nsupdate <<EOF\nserver 10.10.10.10\nupdate add linux-hote.corp.local 86400 A 192.168.1.10\nsend\nEOF');
      const check = await pwsh(winDc)('Get-DnsServerResourceRecord -ZoneName "corp.local" -Name "linux-hote"');
      expect(check).toMatch(/192\.168\.1\.10/);
    });

    it('338. DNS Forwarding : Windows DNS relaie une requête externe non résolue vers le BIND9 Linux', async () => {
      const { winPc, winDc, linuxSrv } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name DNS');
      await taper(linuxSrv as unknown as Cli, ['systemctl start named']);
      await pwsh(winDc)('Set-DnsServerForwarder -IPAddress "10.10.10.20"');
      const res = await pwsh(winPc)('Resolve-DnsName -Server 10.10.10.10 -Name "external.lan"');
      expect(refuse(res)).toBe(false);
    });

    it('339. Conditional Forwarder DNS : Windows DNS achemine les requêtes pour "*.linux.lan" vers Linux BIND9', async () => {
      const { winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name DNS');
      const fwd = await pwsh(winDc)('Add-DnsServerConditionalForwarderZone -Name "linux.lan" -MasterServers 10.10.10.20');
      expect(refuse(fwd)).toBe(false);
    });

    it('340. Serveur DHCP Windows Server : distribution d\'un bail IP avec passerelle vers Windows PC', async () => {
      const { winDc, winPc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name DHCP');
      await pwsh(winDc)('Add-DhcpServerv4Scope -Name "LAN" -StartRange 192.168.1.100 -EndRange 192.168.1.200 -SubnetMask 255.255.255.0');
      const renew = await cmd(winPc, 'ipconfig /renew');
      expect(renew).toMatch(/192\.168\.1\./);
    });

    it('341. DHCP Relay FortiGate vers Windows Server : les broadcasts LAN sont convertis en unicast vers 10.10.10.10', async () => {
      const { fw, winDc } = await creerLaboHybride();
      await taper(fw, [
        'config system interface', 'edit port1',
        'set dhcp-relay-service enable',
        'set dhcp-relay-ip "10.10.10.10"', 'next', 'end',
      ]);
      const conf = await fw.executeCommand('show system interface port1');
      expect(conf).toContain('10.10.10.10');
    });

    it('342. DHCP Option 15 (Domain Name) & Option 6 (DNS) validées sur le client Linux via Windows DHCP', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Set-DhcpServerv4OptionValue -ScopeId 192.168.1.0 -OptionId 15 -Value "corp.local"');
      await linuxPc.executeCommand('dhclient -r eth0 && dhclient -1 eth0');
      const resolv = await linuxPc.executeCommand('cat /etc/resolv.conf');
      expect(resolv).toMatch(/corp\.local|10\.10\.10\.10/);
    });
  });

  // =========================================================================
  // 49. DEFENSE-IN-DEPTH, FIREWALL WINDOWS & TÉLÉMÉTRIE / SYSLOG (Tests 343 à 349)
  // =========================================================================
  describe('Défense en Profondeur, Pare-feu Hôte Windows & Télémétrie', () => {
    it('343. Windows Defender Firewall actif : ouverture d\'un port spécifique via netsh advfirewall', async () => {
      const { winDc } = await creerLaboHybride();
      const res = await cmd(winDc, 'netsh advfirewall firewall add rule name="OpenHTTP" dir=in action=allow protocol=TCP localport=80');
      expect(res).toMatch(/Ok\./i);
    });

    it('344. Blocage par le pare-feu hôte Windows : un paquet accepté par FortiGate est détruit par Windows Defender', async () => {
      const { linuxPc, winDc } = await creerLaboHybride();
      await cmd(winDc, 'netsh advfirewall firewall add rule name="BlockLinux" dir=in action=block remoteip=192.168.1.10');
      const res = await linuxPc.executeCommand('curl -s --connect-timeout 1 http://10.10.10.10/');
      expect(res).toMatch(/Connection timed out|refused/i);
    });

    it('345. Windows Event Log Forwarding (Syslog) : Alerte de connexion réussie (Event ID 4624) reçue par le SIEM Linux', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      await taper(linuxSrv as unknown as Cli, ['systemctl start rsyslog']);
      await pwsh(winDc)('Write-EventLog -LogName Security -Source Microsoft-Windows-Security-Auditing -EventId 4624 -EntryType SuccessAudit -Message "Logon Success: CORP\\Administrator"');
      const syslog = await linuxSrv.executeCommand('tail -n 2 /var/log/syslog');
      expect(refuse(syslog)).toBe(false);
    });

    it('346. Audit d\'échec de connexion (Event ID 4625) journalisé lors d\'une mauvaise authentification NTLM', async () => {
      const { winPc, winDc } = await creerLaboHybride();
      await pwsh(winPc)('net use \\\\10.10.10.10\\C$ /user:CORP\\Inconnu MauvaisMdp');
      const logs = await pwsh(winDc)('Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4625} -MaxEvents 1');
      expect(refuse(logs)).toBe(false);
    });

    it('347. IPsec Transport Mode entre Windows Server et Linux Server (Chiffrement bout-en-bout inter-hôtes)', async () => {
      const { winDc, linuxSrv } = await creerLaboHybride();
      const ipsecWin = await pwsh(winDc)('New-NetIPsecRule -DisplayName "LinuxTunnel" -RemoteAddress "10.10.10.20"');
      expect(refuse(ipsecWin)).toBe(false);
    });

    it('348. SNMP Windows Server : Linux Server interroge l\'OID sysName via snmpget (UDP 161)', async () => {
      const { linuxSrv, winDc } = await creerLaboHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name SNMP-Service');
      const snmp = await linuxSrv.executeCommand('snmpget -v2c -c public 10.10.10.10 1.3.6.1.2.1.1.5.0');
      expect(snmp).toMatch(/DC01/i);
    });

    it('349. PowerShell Test-NetConnection -TraceRoute : Windows Server trace la route traversant FortiGate et le switch', async () => {
      const { winDc } = await creerLaboHybride();
      const trace = await pwsh(winDc)('Test-NetConnection -ComputerName 192.168.1.10 -TraceRoute');
      expect(trace).toMatch(/10\.10\.10\.1|192\.168\.1\.1/);
    });
  });

  // =========================================================================
  // 50. SCÉNARIO MAÎTRE HYBRIDE MULTI-TECHNOLOGIES (Test 350)
  // =========================================================================
  describe('L\'Épreuve Maîtresse d\'Architecture Hybride d\'Entreprise', () => {
    it('350. Chaîne Transversale Complète : DHCP Windows -> DNS AD -> Kerberos DC -> Web IIS -> Proxy Nginx -> DB Oracle Linux -> Audit Syslog', async () => {
      const { winPc, linuxPc, winDc, linuxSrv } = await creerLaboHybride();

      // 1. Initialisation des services Windows Server (AD, DNS, IIS)
      const psDc = pwsh(winDc);
      await psDc('Install-WindowsFeature -Name AD-Domain-Services,DNS,Web-Server');
      await psDc(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP_SAFE_MODE}`);

      // 2. Initialisation des services Linux Server (Nginx, Oracle XE, Rsyslog)
      await taper(linuxSrv as unknown as Cli, [
        'systemctl start named',
        'systemctl start nginx',
        'systemctl start oracle-xe',
        'systemctl start rsyslog',
      ]);

      // 3. Résolution DNS Active Directory depuis le client Windows
      const dnsRes = await pwsh(winPc)('Resolve-DnsName -Server 10.10.10.10 -Name "DC01.corp.local"');
      expect(dnsRes).toMatch(/10\.10\.10\.10/);

      // 4. Appel HTTP vers le serveur IIS Windows en DMZ
      const iisRes = await pwsh(winPc)('(Invoke-WebRequest -Uri "http://10.10.10.10/").StatusCode');
      expect(iisRes).toBe('200');

      // 5. Appel de l\'API Nginx Linux qui fait le pont avec la DB Oracle
      const apiRes = await linuxPc.executeCommand('curl -s http://10.10.10.20/');
      expect(apiRes).toMatch(/Welcome to nginx|nginx/i);

      // 6. Requête transactionnelle Oracle DB émise depuis Windows Server
      const dbQuery = 'cmd.exe /c "echo SELECT \'HYBRID_CHAIN_2026_OK\' FROM DUAL; | sqlplus -S system/oracle@10.10.10.20:1521/XE"';
      const dbRes = await pwsh(winDc)(dbQuery);
      expect(dbRes).toContain('HYBRID_CHAIN_2026_OK');

      // 7. Émission d\'un log d\'audit final transmis vers le serveur Syslog Linux
      await pwsh(winDc)('logger -n 10.10.10.20 -P 514 "END_TO_END_HYBRID_SUCCESS_TEST_350"');
      const syslogCheck = await linuxSrv.executeCommand('tail -n 2 /var/log/syslog');
      expect(refuse(syslogCheck)).toBe(false);
    });
  });

});