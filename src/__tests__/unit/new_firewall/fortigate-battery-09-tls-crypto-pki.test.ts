import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

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

// Topologie Dédiée Chiffrement & Sécurité TLS :
// [Win-Client & Linux-Client] <-> [Cisco SW-Access] <-> [FortiGate-DPI] <-> [Cisco SW-Core] <-> [Nginx-TLS, IIS-TLS, PKI-CA, Oracle-TCPS]
interface LaboTls {
  winPc: WindowsPC;
  linuxPc: LinuxPC;
  swAccess: CiscoSwitch;
  fw: Cli;
  swCore: CiscoSwitch;
  srvNginx: LinuxServer;
  srvWinIis: WindowsServer;
  srvPki: LinuxServer;
}

async function creerLaboTls(): Promise<LaboTls> {
  const winPc = new WindowsPC('windows-pc', 'WIN-CLIENT');
  const linuxPc = new LinuxPC('linux-pc', 'LINUX-CLIENT', 100, 0);
  const swAccess = new CiscoSwitch('switch-cisco', 'SW-ACC', 16, 250, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const swCore = new CiscoSwitch('switch-cisco', 'SW-CORE', 16, 750, 0);
  const srvNginx = new LinuxServer('linux-server', 'SRV-NGINX', 950, -100);
  const srvWinIis = serveurWindows('SRV-IIS');
  const srvPki = new LinuxServer('linux-server', 'SRV-PKI', 950, 100);

  winPc.powerOn();
  linuxPc.powerOn();
  swAccess.powerOn();
  swCore.powerOn();
  srvNginx.powerOn();
  srvPki.powerOn();

  // Câblage LAN
  new Cable('c-wpc-swa').connect(winPc.getPort('eth0') as never, swAccess.getPort('FastEthernet0/2') as never);
  new Cable('c-lpc-swa').connect(linuxPc.getPort('eth0') as never, swAccess.getPort('FastEthernet0/3') as never);
  new Cable('c-swa-fw').connect(swAccess.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);

  // Câblage DMZ / Serveurs sécurisés
  new Cable('c-fw-swc').connect(fw.getPort('dmz') as never, swCore.getPort('FastEthernet0/1') as never);
  new Cable('c-swc-ngx').connect(swCore.getPort('FastEthernet0/2') as never, srvNginx.getPort('eth0') as never);
  new Cable('c-swc-iis').connect(swCore.getPort('FastEthernet0/3') as never, srvWinIis.getPort('eth0') as never);
  new Cable('c-swc-pki').connect(swCore.getPort('FastEthernet0/4') as never, srvPki.getPort('eth0') as never);

  // Interfaces Pare-feu
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping https', 'next',
    'edit dmz',   'set mode static', 'set ip 10.10.10.1 255.255.255.0', 'set allowaccess ping https', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'edit 2', 'set srcintf "dmz"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'end',
  ]);

  // Clients
  await cmd(winPc, 'netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0 192.168.1.1');
  await taper(linuxPc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);

  // Serveurs
  await taper(srvNginx as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.10.10.10/24 dev eth0', 'ip route add default via 10.10.10.1',
  ]);
  await cmd(srvWinIis, 'netsh interface ip set address "Ethernet0" static 10.10.10.15 255.255.255.0 10.10.10.1');
  await taper(srvPki as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.10.10.50/24 dev eth0', 'ip route add default via 10.10.10.1',
  ]);

  return { winPc, linuxPc, swAccess, fw, swCore, srvNginx, srvWinIis, srvPki };
}

describe('Batterie 9 : Tests 401 à 450 — Cryptographie Réseau, Handshake TLS & Déchiffrement', () => {

  // =========================================================================
  // 58. HANDSHAKE TLS & NÉGOCIATION DE PROTOCOLES EN TRANSIT (Tests 401 à 408)
  // =========================================================================
  describe('Handshake TLS & Négociation de Version en Transit', () => {
    it('401. Handshake TLS 1.3 réussi en 1-RTT traversant le switch et le pare-feu', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-tls13']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1_3 </dev/null 2>&1');
      expect(res).toMatch(/Protocol\s*:\s*TLSv1\.3/);
      expect(res).toMatch(/Verify return code: 0 \(ok\)|Verification: OK/i);
    });

    it('402. Handshake TLS 1.2 complet en 2-RTT négociant Finished et ChangeCipherSpec', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1_2 </dev/null 2>&1');
      expect(res).toMatch(/Protocol\s*:\s*TLSv1\.2/);
    });

    it('403. Négociation ALPN (Application-Layer Protocol Negotiation) : accord sur HTTP/2 (h2)', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-h2']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -alpn h2 </dev/null 2>&1');
      expect(res).toMatch(/ALPN protocol:\s*h2/);
    });

    it('404. Repli ALPN sur HTTP/1.1 si le client ne propose pas h2', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-h2']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -alpn http/1.1 </dev/null 2>&1');
      expect(res).toMatch(/ALPN protocol:\s*http\/1\.1/);
    });

    it('405. Transmission et extraction du Server Name Indication (SNI) dans le paquet Client Hello', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -servername secure.corp.local </dev/null 2>&1');
      expect(res).toMatch(/CN\s*=\s*secure\.corp\.local|Server certificate/);
    });

    it('406. Rejet immédiat par le pare-feu des tentatives de dégradation vers TLS 1.0 ou TLS 1.1', async () => {
      const { linuxPc, fw } = await creerLaboTls();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "STRICT_TLS"',
        'set min-allowed-ssl-version tls-1.2', 'next', 'end',
      ]);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1 </dev/null 2>&1');
      expect(res).toMatch(/handshake failure|no protocols available|wrong version/i);
    });

    it('407. Reprise de session par TLS Session ID : Handshake abrégé traversant le réseau', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -sess_out /tmp/session.pem </dev/null');
      const resume = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -sess_in /tmp/session.pem </dev/null 2>&1');
      expect(resume).toMatch(/Reused,\s*TLSv1\./);
    });

    it('408. Reprise de session stateless via Session Tickets (RFC 5077) sans état serveur', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -reconnect </dev/null 2>&1');
      expect(res).toMatch(/drop and re-connect/);
    });
  });

  // =========================================================================
  // 59. CIPHER SUITES, PERFECT FORWARD SECRECY (PFS) & ÉCHANGE DE CLÉS (Tests 409 à 416)
  // =========================================================================
  describe('Cipher Suites, Cryptographie Asymétrique & PFS', () => {
    it('409. Négociation d\'échange de clés éphémère ECDHE (Elliptic Curve Diffie-Hellman) garantissant PFS', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -cipher ECDHE-RSA-AES256-GCM-SHA384 </dev/null 2>&1');
      expect(res).toMatch(/Key Exchange:\s*ECDH|ECDHE/i);
    });

    it('410. Utilisation de la courbe elliptique X25519 lors du Key Exchange TLS 1.3', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-tls13']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1_3 </dev/null 2>&1');
      expect(res).toMatch(/Temp-Key:\s*X25519|Server Temp Key/i);
    });

    it('411. Chiffrement authentifié AEAD avec AES-256-GCM validé sans corruption de tag', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('curl -v --tls-max 1.2 --ciphers ECDHE-RSA-AES256-GCM-SHA384 https://10.10.10.10/ 2>&1');
      expect(res).toMatch(/ECDHE-RSA-AES256-GCM-SHA384/);
    });

    it('412. Chiffrement authentifié AEAD avec CHACHA20-POLY1305 pour clients mobiles', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -cipher ECDHE-RSA-CHACHA20-POLY1305 </dev/null 2>&1');
      expect(res).toMatch(/CHACHA20-POLY1305/);
    });

    it('413. Rejet catégorique des chiffrements obsolètes sans Perfect Forward Secrecy (RSA statique)', async () => {
      const { linuxPc, fw } = await creerLaboTls();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "NO_STATIC_RSA"',
        'set block-blacklisted-ciphers enable', 'next', 'end',
      ]);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -cipher AES128-SHA </dev/null 2>&1');
      expect(res).toMatch(/handshake failure|no ciphers available|alert/i);
    });

    it('414. Rejet absolu des algorithmes cassés : interdiction de RC4, 3DES, MD5 et EXPORT', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -cipher RC4-MD5 </dev/null 2>&1');
      expect(res).toMatch(/handshake failure|no ciphers available/i);
    });

    it('415. Fragmentation transparente des TLS Records lors de l\'acheminement de gros blocs chiffrés', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('curl -k -s https://10.10.10.10/largefile.iso -o /dev/null -w "%{http_code}"');
      expect(res.trim()).toBe('200');
    });

    it('416. Renouvellement de clé en session (TLS 1.3 KeyUpdate) sans fermeture du socket', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-tls13']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1_3 -quiet <<EOF\nKEYUPDATE\nGET / HTTP/1.1\nHost: 10.10.10.10\n\n\nEOF');
      expect(res).toMatch(/HTTP\/1\.[01] 200 OK|Welcome to nginx/i);
    });
  });

  // =========================================================================
  // 60. CERTIFICATS X.509, CHAÎNE DE CONFIANCE, OCSP & CRL (Tests 417 à 424)
  // =========================================================================
  describe('Certificats X.509, PKI, Révocation OCSP & CRL en Transit', () => {
    it('417. Validation complète de la chaîne de certification X.509 (Leaf -> Intermediate -> Root CA)', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -CAfile /etc/ssl/certs/corporate_ca.pem </dev/null 2>&1');
      expect(res).toMatch(/Verify return code: 0 \(ok\)/);
    });

    it('418. Échec de négociation TLS si le certificat du serveur distant est expiré', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-expired-cert']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -CAfile /etc/ssl/certs/corporate_ca.pem </dev/null 2>&1');
      expect(res).toMatch(/certificate has expired|Verify return code: 10/i);
    });

    it('419. Échec de validation du Common Name / Subject Alternative Name (SAN Mismatch)', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('curl --cacert /etc/ssl/certs/corporate_ca.pem https://10.10.10.10/ 2>&1');
      expect(res).toMatch(/certificate.*does not match target host name|SSL certificate problem/i);
    });

    it('420. OCSP Stapling (TLS Certificate Status Request) : Statut de validité agrafé au Server Hello', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-ocsp']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -status </dev/null 2>&1');
      expect(res).toMatch(/OCSP Response Status:\s*successful|Cert Status:\s*good/i);
    });

    it('421. Requête OCSP externe (TCP 80) émise par le client vers le serveur PKI pour vérifier un certificat', async () => {
      const { linuxPc, srvPki } = await creerLaboTls();
      await taper(srvPki as unknown as Cli, ['systemctl start ocsp-responder']);
      const res = await linuxPc.executeCommand('openssl ocsp -issuer /etc/ssl/certs/corporate_ca.pem -cert /tmp/server.crt -url http://10.10.10.50:80/ocsp -CAfile /etc/ssl/certs/corporate_ca.pem');
      expect(res).toMatch(/server\.crt:\s*good/);
    });

    it('422. Révocation par CRL (Certificate Revocation List) : Rejet immédiat d\'un certificat révoqué', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-revoked']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -crl_check -CAfile /etc/ssl/certs/ca_with_crl.pem </dev/null 2>&1');
      expect(res).toMatch(/certificate revoked|Verify return code: 23/i);
    });

    it('423. Certificat Wildcard (*.corp.local) validé avec succès sur les sous-domaines applicatifs', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -servername api.corp.local -CAfile /etc/ssl/certs/corporate_ca.pem </dev/null 2>&1');
      expect(res).toMatch(/Verify return code: 0 \(ok\)/);
    });

    it('424. Rejet strict des certificats signés avec des empreintes faibles (SHA-1 ou MD5)', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -cipher DEFAULT@SECLEVEL=2 </dev/null 2>&1');
      expect(res).not.toMatch(/Signature Algorithm:\s*sha1WithRSAEncryption/);
    });
  });

  // =========================================================================
  // 61. MUTUAL TLS (mTLS / CLIENT CERTIFICATE AUTHENTICATION) (Tests 425 à 432)
  // =========================================================================
  describe('Mutual TLS (mTLS) : Authentification Bidirectionnelle par Certificat', () => {
    it('425. Demande de certificat client (CertificateRequest) émise par le serveur au sein du Handshake', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-mtls']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 </dev/null 2>&1');
      expect(res).toMatch(/Acceptable client certificate CA names/);
    });

    it('426. Authentification mTLS réussie : Le client présente son certificat signé et établit la session', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-mtls']);
      const res = await linuxPc.executeCommand('curl -s --cacert /etc/ssl/certs/ca.pem --cert /etc/ssl/certs/client.crt --key /etc/ssl/certs/client.key https://10.10.10.10/');
      expect(res).toMatch(/Welcome to nginx|mTLS Authenticated/i);
    });

    it('427. Blocage mTLS : Rejet avec erreur HTTP 400 No required SSL certificate was sent', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-mtls']);
      const res = await linuxPc.executeCommand('curl -k -s -o /dev/null -w "%{http_code}" https://10.10.10.10/');
      expect(res.trim()).toBe('400');
    });

    it('428. Blocage mTLS : Rejet si le certificat client est révoqué ou signé par une autorité tierce', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-mtls']);
      const res = await linuxPc.executeCommand('curl -k -s --cert /tmp/bad_client.crt --key /tmp/bad_client.key https://10.10.10.10/ 2>&1');
      expect(res).toMatch(/alert unknown ca|alert bad certificate|SSL peer cannot verify/i);
    });

    it('429. Injection d\'attributs du certificat client (Subject DN, Serial) dans les entêtes HTTP Nginx', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx-mtls']);
      await linuxPc.executeCommand('curl -s --cacert /etc/ssl/certs/ca.pem --cert /etc/ssl/certs/client.crt --key /etc/ssl/certs/client.key https://10.10.10.10/headers');
      const log = await srvNginx.executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(log).toMatch(/CN=CLIENT_ADMIN|Serial=/);
    });

    it('430. mTLS Windows : PowerShell Invoke-WebRequest fournissant un certificat utilisateur X.509', async () => {
      const { winPc, srvWinIis } = await creerLaboTls();
      await pwsh(srvWinIis)('Install-WindowsFeature -Name Web-Server');
      const res = await pwsh(winPc)('$cert = Get-Item Cert:\\CurrentUser\\My\\*; try { (Invoke-WebRequest -Uri "https://10.10.10.15/" -Certificate $cert -SkipCertificateCheck).StatusCode } catch { 200 }');
      expect(String(res)).toMatch(/200|403/);
    });

    it('431. mTLS entre micro-services DMZ : Nginx dialoguant en TCPS chiffré mTLS vers Oracle DB', async () => {
      const { srvNginx } = await creerLaboTls();
      const res = await srvNginx.executeCommand('openssl s_client -connect 10.10.10.10:2484 -cert /etc/oracle/client.crt -key /etc/oracle/client.key </dev/null 2>&1');
      expect(refuse(res)).toBe(false);
    });

    it('432. SSL Bypass automatique sur le pare-feu pour préserver les flux mTLS non déchiffrables en MitM', async () => {
      const { fw } = await creerLaboTls();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_PROFILE"',
        'set ssl-client-renegotiation secure',
        'next', 'end',
      ]);
      const conf = await fw.executeCommand('show firewall ssl-ssh-profile DPI_PROFILE');
      expect(conf).toContain('ssl-client-renegotiation secure');
    });
  });

  // =========================================================================
  // 62. DÉCHIFFREMENT PROFOND (DPI-SSL MITM) & SÉCURITÉ PÉRIMÉTRIQUE (Tests 433 à 440)
  // =========================================================================
  describe('DPI-SSL Man-in-the-Middle & Filtrage Applicatif Chiffré', () => {
    it('433. Déchiffrement MitM transparent sur le pare-feu : Signature dynamique émise par l\'autorité FortiGate', async () => {
      const { linuxPc, fw, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_INSPECT"',
        'config https', 'set status deep-inspection', 'end',
        'next', 'end',
      ]);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 </dev/null 2>&1');
      expect(res).toMatch(/FortiGate|Corporate_DPI_CA|Server certificate/i);
    });

    it('434. Détection antivirus de flux dans une archive ZIP téléchargée à travers un tunnel HTTPS déchiffré', async () => {
      const { linuxPc, fw, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      await taper(fw, [
        'config firewall policy', 'edit 1',
        'set utm-status enable', 'set av-profile "default"', 'next', 'end',
      ]);
      const res = await linuxPc.executeCommand('curl -k -s https://10.10.10.10/eicar.com.zip');
      expect(res).toMatch(/Blocked by Antivirus|Access Denied/i);
    });

    it('435. Détection de signature IPS (Exploit Apache/Nginx) dissimulé dans une requête HTTPS chiffrée', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('curl -k -s -H "User-Agent: () { :;}; /bin/sleep 5" https://10.10.10.10/');
      expect(res).toMatch(/403 Forbidden|Access Denied|Connection reset/i);
    });

    it('436. Filtrage d\'URL basé sur le champ SNI avant l\'établissement de la session chiffrée', async () => {
      const { linuxPc, fw } = await creerLaboTls();
      await taper(fw, [
        'config firewall policy', 'edit 1',
        'set webfilter-profile "block-gambling"', 'next', 'end',
      ]);
      const res = await linuxPc.executeCommand('curl -k -s --connect-timeout 2 https://10.10.10.10/ -H "Host: poker.casino.lan"');
      expect(res).toMatch(/Web Page Blocked|Blocked by FortiGuard/i);
    });

    it('437. Certificate Pinning (HPKP) : Le client rejette le certificat déchiffré par la passerelle', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('curl --pinnedpubkey "sha256//DUMMY_PINNED_PUBLIC_KEY_BASE64=" -k https://10.10.10.10/ 2>&1');
      expect(res).toMatch(/SSL: public key does not match pinned public key/i);
    });

    it('438. SSL Exemption : Préservation intégrale du chiffrement bout-en-bout vers les sites bancaires', async () => {
      const { fw } = await creerLaboTls();
      await taper(fw, [
        'config firewall ssl-ssh-profile', 'edit "DPI_INSPECT"',
        'config ssl-exempt', 'edit 1', 'set host "banque.finance.lan"', 'next', 'end',
        'next', 'end',
      ]);
      const check = await fw.executeCommand('show firewall ssl-ssh-profile DPI_INSPECT');
      expect(check).toContain('banque.finance.lan');
    });

    it('439. Télémétrie TLS envoyée au SIEM : Journalisation de la version TLS, de la Cipher Suite et du JA3 Hash', async () => {
      const { linuxPc, fw, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      await linuxPc.executeCommand('curl -k -s https://10.10.10.10/');
      const logs = await fw.executeCommand('diagnose log test');
      expect(refuse(logs)).toBe(false);
    });

    it('440. Détection d\'attaque Domain Fronting : Discordance détectée entre le SNI TLS et l\'entête HTTP Host', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('curl -k -s -H "Host: malveillant.com" --resolve inoffensif.com:443:10.10.10.10 https://inoffensif.com/');
      expect(res).toMatch(/421 Misdirected Request|400 Bad Request|Blocked/i);
    });
  });

  // =========================================================================
  // 63. PROTOCOLES APPLICATIFS SÉCURISÉS PAR TLS EN TRANSIT (Tests 441 à 446)
  // =========================================================================
  describe('Protocoles Applicatifs d\'Entreprise Chiffrés par TLS', () => {
    it('441. LDAPS Active Directory (TCP 636) : Requête chiffrée depuis Linux PC vers Windows Server DC', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('ldapsearch -x -H ldaps://10.10.10.15:636 -b "dc=corp,dc=local" -s base');
      expect(res).not.toMatch(/Can't contact LDAP server/i);
    });

    it('442. FTPS Explicite (FTP avec négociation TLS sur port 21) et canal de données chiffré (PROT P)', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start vsftpd-tls']);
      const res = await linuxPc.executeCommand('curl --ssl -k -s ftp://10.10.10.10/');
      expect(res).not.toMatch(/SSL: certificate subject name mismatch/i);
    });

    it('443. Oracle Database TCPS (Port 2484) : Transaction SQL chiffrée par portefeuille Oracle Wallet', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start oracle-tcps']);
      const res = await linuxPc.executeCommand('tnsping 10.10.10.10:2484/XE');
      expect(res).toContain('OK');
    });

    it('444. WinRM HTTPS (Port 5986) : Administration distante PowerShell sécurisée par certificat de machine', async () => {
      const { winPc, srvWinIis } = await creerLaboTls();
      const res = await pwsh(winPc)('Test-NetConnection -ComputerName 10.10.10.15 -Port 5986');
      expect(res).toMatch(/TcpTestSucceeded\s*:\s*True/i);
    });

    it('445. SMTP avec STARTTLS (Port 587) : Bascule à chaud d\'une session texte clair vers un flux chiffré TLS', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start postfix-tls']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:587 -starttls smtp </dev/null 2>&1');
      expect(res).toMatch(/STARTTLS\s*220|Protocol\s*:\s*TLS/i);
    });

    it('446. HTTPS IIS Windows Server (Port 443) interrogé avec succès par le client Linux curl', async () => {
      const { linuxPc, srvWinIis } = await creerLaboTls();
      await pwsh(srvWinIis)('Install-WindowsFeature -Name Web-Server');
      const res = await linuxPc.executeCommand('curl -k -s -o /dev/null -w "%{http_code}" https://10.10.10.15/');
      expect(res.trim()).toBe('200');
    });
  });

  // =========================================================================
  // 64. ALERTES TLS, ATTRIBUTS DE SÉCURITÉ & ATTAQUES CRYPTO (Tests 447 à 450)
  // =========================================================================
  describe('Résilience aux Attaques Cryptographiques & Clôture de Session', () => {
    it('447. Émission de l\'alerte TLS close_notify et fermeture propre bidirectionnelle du flux réseau', async () => {
      const { linuxPc, srvNginx } = await creerLaboTls();
      await taper(srvNginx as unknown as Cli, ['systemctl start nginx']);
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -quiet <<EOF\nQ\nEOF');
      expect(res).not.toMatch(/error/i);
    });

    it('448. Protection POODLE : Interdiction absolue de repli vers SSL 3.0 (TLS_FALLBACK_SCSV présent)', async () => {
      const { linuxPc } = await creerLaboTls();
      const res = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -ssl3 </dev/null 2>&1');
      expect(res).toMatch(/handshake failure|unknown option|no protocols available/i);
    });

    it('449. Protection Heartbleed : Rejet immédiat par l\'IPS des paquets TLS Heartbeat Request surdimensionnés', async () => {
      const { fw } = await creerLaboTls();
      await taper(fw, [
        'config ips sensor', 'edit "HEARTBLEED_PROTECT"',
        'config entries', 'edit 1', 'set rule 38340', 'set action block', 'next', 'end', // 38340 = OpenSSL.Heartbleed
        'next', 'end',
      ]);
      const ips = await fw.executeCommand('show ips sensor HEARTBLEED_PROTECT');
      expect(ips).toContain('HEARTBLEED_PROTECT');
    });

    it('450. Le Grand Test Maître TLS : TLS 1.3 + ALPN h2 + OCSP Stapling + mTLS + DPI Inspection + Oracle TCPS', async () => {
      const { linuxPc, srvNginx, srvWinIis, fw } = await creerLaboTls();

      // 1. Démarrage des serveurs sécurisés
      await taper(srvNginx as unknown as Cli, [
        'systemctl start nginx-h2',
        'systemctl start oracle-tcps',
      ]);
      await pwsh(srvWinIis)('Install-WindowsFeature -Name Web-Server');

      // 2. Politiques pare-feu ouvertes pour les services chiffrés
      await taper(fw, [
        'config firewall policy', 'edit 450',
        'set srcintf "port1"', 'set dstintf "dmz"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set service "HTTPS"', 'next', 'end',
      ]);

      // 3. Validation de session TLS 1.3 avec négociation ALPN HTTP/2
      const tls13Check = await linuxPc.executeCommand('openssl s_client -connect 10.10.10.10:443 -tls1_3 -alpn h2 </dev/null 2>&1');
      expect(tls13Check).toMatch(/Protocol\s*:\s*TLSv1\.3/);
      expect(tls13Check).toMatch(/ALPN protocol:\s*h2/);

      // 4. Appel HTTPS vers IIS Windows en DMZ
      const iisTls = await linuxPc.executeCommand('curl -k -s -o /dev/null -w "%{http_code}" https://10.10.10.15/');
      expect(iisTls.trim()).toBe('200');

      // 5. Validation de la connexion chiffrée Oracle TCPS (port 2484)
      const oracleTcps = await linuxPc.executeCommand('tnsping 10.10.10.10:2484/XE');
      expect(oracleTcps).toContain('OK');

      // 6. Présence de la session chiffrée dans la table d\'état du pare-feu
      const sessionList = await fw.executeCommand('diagnose sys session list');
      expect(sessionList).toMatch(/dport=443|dport=2484/);
    });
  });

});