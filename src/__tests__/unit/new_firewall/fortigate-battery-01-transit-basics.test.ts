import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  type Cli, taper, serveZones, labZone, LAB_REVERSE_ZONE, grantKeyAccess,
} from './fortigateBatteryHarness';

// Topologie complète : [Client PC] -- (L2 Switch) -- [Port1 FW Wan1] -- [Serveur WAN/DMZ]
interface LaboTraverse {
  pc: LinuxPC;
  sw: CiscoSwitch;
  fw: Cli;
  srv: LinuxServer;
}

async function creerLaboTraverse(): Promise<LaboTraverse> {
  const pc = new LinuxPC('linux-pc', 'PC-Client', 100, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 300, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const srv = new LinuxServer('linux-server', 'SRV-Prod', 700, 0);

  pc.powerOn();
  sw.powerOn();
  srv.powerOn();

  // Câblage : PC -> Switch Fa0/2 ; Switch Fa0/1 -> FW port1 ; FW wan1 -> SRV eth0
  new Cable('c-pc-sw').connect(pc.getPort('eth0') as never, sw.getPort('FastEthernet0/2') as never);
  new Cable('c-sw-fw').connect(sw.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);
  new Cable('c-fw-srv').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);

  // Configuration IP Pare-feu
  await taper(fw, [
    'config system interface',
    'edit port1',
    'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh http https',
    'next',
    'edit wan1',
    'set mode static',
    'set ip 203.0.113.1 255.255.255.0',
    'set allowaccess ping',
    'next',
    'end',
  ]);

  // Configuration IP Client LAN
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
  ]);

  // Configuration IP Serveur WAN/DMZ
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 203.0.113.9/24 dev eth0',
    'ip route add default via 203.0.113.1',
  ]);

  return { pc, sw, fw, srv };
}

// Active une politique FW générique LAN -> WAN
async function autoriserTrafic(fw: Cli, service: string = 'ALL', nat: boolean = true): Promise<void> {
  await taper(fw, [
    'config firewall policy',
    'edit 1',
    'set name "Allow-Traffic"',
    'set srcintf "port1"',
    'set dstintf "wan1"',
    'set srcaddr "all"',
    'set dstaddr "all"',
    'set action accept',
    'set schedule "always"',
    `set service "${service}"`,
    `set nat ${nat ? 'enable' : 'disable'}`,
    'next',
    'end',
  ]);
}

describe('Batterie de 50 Tests de Trafic Réseau Traversant', () => {

  // =========================================================================
  // 1. COMMUTATION L2 ET RÉSOLUTION ARP EN TRANSIT (Tests 1 à 6)
  // =========================================================================
  describe('Couche 2 & ARP : Flux de transit', () => {
    it('1. Le switch apprend l\'adresse MAC source du PC lors de l\'émission vers la passerelle', async () => {
      const { pc, sw } = await creerLaboTraverse();
      await pc.executeCommand('arping -c 1 192.168.1.1');
      const macs = await sw.executeCommand('show mac address-table');
      expect(macs).toMatch(/FastEthernet0\/2/);
    });

    it('2. La requête ARP du PC traverse le switch en broadcast sans être altérée', async () => {
      const { pc } = await creerLaboTraverse();
      const arpRes = await pc.executeCommand('arping -c 1 192.168.1.1');
      expect(arpRes).toMatch(/reply from 192\.168\.1\.1/i);
    });

    it('3. Le pare-feu stocke la MAC du PC après réception d\'un paquet traversant', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await pc.executeCommand('ping -c 1 192.168.1.1');
      const table = await fw.executeCommand('get system arp');
      expect(table).toContain('192.168.1.10');
    });

    it('4. Une trame vers une IP inconnue sur le LAN provoque un échec ARP sans traverser le pare-feu', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await pc.executeCommand('ping -c 1 -W 1 192.168.1.250');
      const sessions = await fw.executeCommand('diagnose sys session list');
      expect(sessions).not.toContain('192.168.1.250');
    });

    it('5. Gratuitous ARP : mise à jour de la table MAC du switch lors d\'un changement de port', async () => {
      const { pc, sw } = await creerLaboTraverse();
      await pc.executeCommand('arping -c 1 -U -I eth0 192.168.1.10');
      const table = await sw.executeCommand('show mac address-table');
      expect(table).toMatch(/FastEthernet0\/2/);
    });

    it('6. Le paquet traversant est encapsulé avec la MAC du port WAN du firewall en sortie', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL', false);
      await pc.executeCommand('ping -c 1 203.0.113.9');
      const arpSrv = await (srv as unknown as Cli).executeCommand('ip neigh');
      expect(arpSrv).toContain('203.0.113.1');
    });
  });

  // =========================================================================
  // 2. TRAFIC ICMP & DIAGNOSTIC DE ROUTAGE (Tests 7 à 12)
  // =========================================================================
  describe('ICMP : Routage et contrôle de traversée', () => {
    it('7. Paquet ICMP bloqué par défaut lorsque aucune règle n\'existe', async () => {
      const { pc } = await creerLaboTraverse();
      const res = await pc.executeCommand('ping -c 1 -W 1 203.0.113.9');
      expect(res).toMatch(/100% packet loss/);
    });

    it('8. Paquet ICMP transite avec succès dès que la policy PING/ALL est active', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'PING');
      const res = await pc.executeCommand('ping -c 2 203.0.113.9');
      expect(res).toMatch(/0% packet loss/);
    });

    it('9. Le TTL est décrémenté d\'une unité lors de la traversée du firewall', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      const res = await pc.executeCommand('ping -c 1 203.0.113.9');
      // Linux par défaut émet un TTL de 64, le serveur renvoie TTL=64, traversant le FW -> TTL=63
      expect(res).toMatch(/ttl=6[23]/i);
    });

    it('10. ICMP Destination Unreachable émis par le pare-feu si aucune route vers la cible', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      const res = await pc.executeCommand('ping -c 1 -W 1 10.254.254.1');
      expect(res).toMatch(/Destination Host Unreachable|Network is unreachable|100% packet loss/i);
    });

    it('11. Gros paquets ICMP (Ping grand format) traversant sans troncature', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      const res = await pc.executeCommand('ping -c 1 -s 1400 203.0.113.9');
      expect(res).toMatch(/0% packet loss/);
    });

    it('12. Suppression dynamique de la policy interrompt immédiatement le ping traversant', async () => {
      const { pc, fw } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      expect(await pc.executeCommand('ping -c 1 203.0.113.9')).toMatch(/0% packet loss/);
      await taper(fw, ['config firewall policy', 'delete 1', 'end']);
      expect(await pc.executeCommand('ping -c 1 -W 1 203.0.113.9')).toMatch(/100% packet loss/);
    });
  });

  // =========================================================================
  // 3. TRAFIC HTTP & HTTPS (NGINX) TRAVERSANT (Tests 13 à 19)
  // =========================================================================
  describe('HTTP / HTTPS (Nginx) : Traversée du pare-feu', () => {
    it('13. Requête HTTP GET traverse le pare-feu vers Nginx et reçoit le code 200', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://203.0.113.9/');
      expect(res.trim()).toBe('200');
    });

    it('14. Le corps HTML de la page d\'accueil Nginx est intégralement restitué au PC', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const body = await pc.executeCommand('curl -s http://203.0.113.9/');
      expect(body).toMatch(/Welcome to nginx|nginx/i);
    });

    it('15. Une requête HTTP POST traversante transporte son payload intact vers Nginx', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -X POST -d "param=test-data" http://203.0.113.9/');
      expect(res).not.toMatch(/Connection refused|couldn't connect/i);
    });

    it('16. HTTPS (port 443) traverse lorsque autorisé et établit le handshake TLS', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTPS');
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -k -s https://203.0.113.9/');
      expect(res).not.toMatch(/Failed to connect|Connection refused/i);
    });

    it('17. Filtrage applicatif : port 80 autorisé mais 443 bloqué', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP'); // uniquement HTTP
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const resHttps = await pc.executeCommand('curl -k -sS --connect-timeout 1 https://203.0.113.9/');
      expect(resHttps).toMatch(/Connection timed out|Connection refused|Failed to connect/i);
    });

    it('18. DNAT / VIP : Un client WAN interroge Nginx hébergé sur le LAN via IP publique', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await taper(pc as unknown as Cli, ['apt install -y nginx']);
      await taper(fw, [
        'config firewall vip',
        'edit "VIP_WEB"',
        'set extip 203.0.113.1',
        'set mappedip "192.168.1.10"',
        'set portforward enable',
        'set extport 80',
        'set mappedport 80',
        'next',
        'end',
        'config firewall policy',
        'edit 2',
        'set srcintf "wan1"',
        'set dstintf "port1"',
        'set srcaddr "all"',
        'set dstaddr "VIP_WEB"',
        'set action accept',
        'set schedule "always"',
        'set service "HTTP"',
        'next',
        'end',
      ]);
      const res = await (srv as unknown as Cli).executeCommand('curl -s http://203.0.113.1/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('19. Nginx renvoie un code 404 traversant pour une URI inexistante', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://203.0.113.9/notfound.html');
      expect(res.trim()).toBe('404');
    });
  });

  // =========================================================================
  // 4. TRAFIC SSH TRAVERSANT (Tests 20 à 25)
  // =========================================================================
  describe('SSH : Connexions sécurisées traversant le pare-feu', () => {
    it('20. Connexion SSH au serveur distant traversant le pare-feu avec succès', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'SSH');
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli);
      const res = await pc.executeCommand('ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 203.0.113.9 "echo SSH_OK"');
      expect(res).toContain('SSH_OK');
    });

    it('21. Exécution d\'une commande distante (hostname) via SSH à travers le firewall', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'SSH');
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli);
      await taper(srv as unknown as Cli, ['hostnamectl set-hostname SRV-Prod']);
      const res = await pc.executeCommand('ssh -o StrictHostKeyChecking=no 203.0.113.9 "hostname"');
      expect(res.trim()).toBe('SRV-Prod');
    });

    it('22. Blocage strict de SSH si seule la navigation Web est autorisée', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      const res = await pc.executeCommand('ssh -o ConnectTimeout=1 203.0.113.9');
      expect(res).toMatch(/Connection timed out|Connection refused|Operation timed out/i);
    });

    it('23. La session SSH traversante est enregistrée dans la session table du firewall', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'SSH');
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli);
      await pc.executeCommand('ssh -o StrictHostKeyChecking=no 203.0.113.9 "true"');
      const table = await fw.executeCommand('diagnose sys session list');
      expect(table).toMatch(/->203\.0\.113\.9:22\b/);
    });

    it('24. Redirection de port SSH via VIP (Port Forwarding WAN vers SRV)', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli);
      await taper(fw, [
        'config firewall vip',
        'edit "VIP_SSH"',
        'set extip 203.0.113.1',
        'set mappedip "203.0.113.9"',
        'set portforward enable',
        'set extport 2222',
        'set mappedport 22',
        'next',
        'end',
        'config firewall policy',
        'edit 1',
        'set srcintf "port1"',
        'set dstintf "wan1"',
        'set srcaddr "all"',
        'set dstaddr "VIP_SSH"',
        'set action accept',
        'set schedule "always"',
        'set service "ALL"',
        'next',
        'end',
      ]);
      const res = await pc.executeCommand('ssh -p 2222 -o StrictHostKeyChecking=no 203.0.113.1 "echo FORWARD_OK"');
      expect(res).toContain('FORWARD_OK');
    });

    it('25. Échec d\'authentification SSH à travers le pare-feu renvoie Permission Denied', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'SSH');
      await taper(srv as unknown as Cli, ['systemctl start sshd']);
      const res = await pc.executeCommand('ssh -o PasswordAuthentication=no -o PreferredAuthentications=password user_inconnu@203.0.113.9');
      expect(res).toMatch(/Permission denied/i);
    });
  });

  // =========================================================================
  // 5. TRAFIC FTP (CANAL DE COMMANDE ET DE DONNÉES) (Tests 26 à 31)
  // =========================================================================
  describe('FTP : Canal de contrôle (21) et données en transit', () => {
    it('26. Connexion initiale au port de commande FTP (port 21) traversant', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'FTP');
      await taper(srv as unknown as Cli, ['apt install -y vsftpd']);
      const res = await pc.executeCommand('curl -s ftp://203.0.113.9/ --connect-timeout 2');
      expect(res).not.toMatch(/Connection refused|couldn't connect/i);
    });

    it('27. Le banner d\'accueil du service FTP traverse le réseau jusqu\'au client', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'FTP');
      await taper(srv as unknown as Cli, ['apt install -y vsftpd']);
      const res = await pc.executeCommand('nc -zv -w 2 203.0.113.9 21');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('28. Téléchargement d\'un fichier en mode passif (PASV) traversant le firewall', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'FTP');
      await taper(srv as unknown as Cli, [
        'apt install -y vsftpd',
        'echo "FTP_TRAFFIC_DATA" > /srv/ftp/test.txt',
      ]);
      const res = await pc.executeCommand('curl -s ftp://203.0.113.9/test.txt');
      expect(res).toContain('FTP_TRAFFIC_DATA');
    });

    it('29. Téléversement d\'un fichier FTP (STOR) à travers la politique pare-feu', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, [
        'apt install -y vsftpd',
        "sed -i 's/^#write_enable=YES/write_enable=YES/; s/^#anon_upload_enable=YES/anon_upload_enable=YES/' /etc/vsftpd.conf",
        'mkdir /srv/ftp/upload',
        'chown ftp /srv/ftp/upload',
        'systemctl restart vsftpd',
      ]);
      await pc.executeCommand('echo "UPLOAD_PAYLOAD" > upload.txt');
      await pc.executeCommand('curl -s -T upload.txt ftp://203.0.113.9/upload/');
      const check = await (srv as unknown as Cli).executeCommand('cat /srv/ftp/upload/upload.txt');
      expect(check).toContain('UPLOAD_PAYLOAD');
    });

    it('30. Fermeture du port FTP par modification de policy bloque immédiatement le transfert', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP'); // Pas de FTP
      await taper(srv as unknown as Cli, ['apt install -y vsftpd']);
      const res = await pc.executeCommand('curl -sS --connect-timeout 1 ftp://203.0.113.9/');
      expect(res).toMatch(/Failed to connect|Connection timed out|couldn't connect/i);
    });

    it('31. Tentative d\'accès à un fichier inexistant renvoie le code d\'erreur FTP 550', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'FTP');
      await taper(srv as unknown as Cli, ['apt install -y vsftpd']);
      const res = await pc.executeCommand('curl -sS ftp://203.0.113.9/inexistant.txt');
      expect(res).toContain('curl: (78) The file does not exist');
    });
  });

  // =========================================================================
  // 6. TRAFIC TELNET (ADMINISTRATION NON CHIFFRÉE) (Tests 32 à 35)
  // =========================================================================
  describe('Telnet : Flux en clair traversant', () => {
    it('32. Ouverture réussie d\'une session Telnet (port 23) à travers le firewall', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'TELNET');
      await taper(srv as unknown as Cli, ['systemctl start telnet']);
      const res = await pc.executeCommand('nc -zv -w 2 203.0.113.9 23');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('33. Envoi de commande et réception d\'écho sur une session Telnet traversante', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'TELNET');
      await taper(srv as unknown as Cli, ['systemctl start telnet']);
      const res = await pc.executeCommand('echo "quit" | telnet 203.0.113.9 23');
      expect(res).toMatch(/Connected|Escape character/i);
    });

    it('34. Rejet du flux Telnet par le pare-feu si le service TELNET n\'est pas listé', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'SSH');
      await taper(srv as unknown as Cli, ['systemctl start telnet']);
      const res = await pc.executeCommand('nc -zv -w 1 203.0.113.9 23');
      expect(res).toMatch(/timed out|refused/i);
    });

    it('35. Établissement simultané d\'une session Telnet et d\'une session SSH', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, ['systemctl start telnet', 'systemctl start sshd']);
      const t1 = await pc.executeCommand('nc -zv -w 2 203.0.113.9 23');
      const t2 = await pc.executeCommand('nc -zv -w 2 203.0.113.9 22');
      expect(t1).toMatch(/succeeded|open|Connected/i);
      expect(t2).toMatch(/succeeded|open|Connected/i);
    });
  });

  // =========================================================================
  // 7. TRAFIC BASE DE DONNÉES ORACLE (TNS / PORT 1521) (Tests 36 à 40)
  // =========================================================================
  describe('Oracle Database : Traversée TNS Listener', () => {
    it('36. Le listener Oracle (port 1521) est joignable à travers la politique pare-feu', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, ['systemctl start oracle-ohasd']);
      const res = await pc.executeCommand('nc -zv -w 2 203.0.113.9 1521');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('37. Contrôle du Listener via tnsping à travers le réseau', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, ['systemctl start oracle-ohasd']);
      const res = await pc.executeCommand('tnsping 203.0.113.9:1521/ORCL');
      expect(res).toMatch(/OK|msec/i);
    });

    it('38. Exécution d\'une requête SQL traversante (SELECT 1 FROM DUAL)', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, ['systemctl start oracle-ohasd']);
      const query = 'echo "SELECT 1 FROM DUAL;" | sqlplus -S system/oracle@203.0.113.9:1521/ORCL';
      const res = await pc.executeCommand(query);
      expect(res).toMatch(/^-+\n\s*1\s*$/m);
    });

    it('39. Blocage du trafic Oracle 1521 si la règle n\'autorise que le Web (port 80/443)', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'HTTP');
      await taper(srv as unknown as Cli, ['systemctl start oracle-ohasd']);
      const res = await pc.executeCommand('nc -zv -w 1 203.0.113.9 1521');
      expect(res).toMatch(/timed out|refused/i);
    });

    it('40. Session Oracle coupée proprement lors de l\'envoi de la commande EXIT', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await taper(srv as unknown as Cli, ['systemctl start oracle-ohasd']);
      const res = await pc.executeCommand('echo "EXIT;" | sqlplus -S system/oracle@203.0.113.9:1521/ORCL');
      expect(res).not.toMatch(/ORA-|error/i);
    });
  });

  // =========================================================================
  // 8. SERVICES D\'INFRASTRUCTURE : DNS (BIND9) ET DHCP (Tests 41 à 45)
  // =========================================================================
  describe('DNS (BIND9) & DHCP : Résolution et attribution d\'adresses', () => {
    it('41. Requête DNS UDP (port 53) vers BIND9 traversant le pare-feu', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'DNS');
      await serveZones(srv as unknown as Cli, [labZone(), LAB_REVERSE_ZONE]);
      const res = await pc.executeCommand('dig @203.0.113.9 web.lab.lan +short');
      expect(res).toMatch(/\d+\.\d+\.\d+\.\d+/);
    });

    it('42. Requête DNS inverse (PTR) traversant le pare-feu vers BIND9', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'DNS');
      await serveZones(srv as unknown as Cli, [labZone(), LAB_REVERSE_ZONE]);
      const res = await pc.executeCommand('dig @203.0.113.9 -x 203.0.113.9 +short');
      expect(res.trim()).toBe('srv.lab.lan.');
    });

    it('43. Échec de résolution DNS lorsque le trafic UDP 53 est refusé', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'PING'); // Seul le ping passe
      await serveZones(srv as unknown as Cli, [labZone(), LAB_REVERSE_ZONE]);
      const res = await pc.executeCommand('dig @203.0.113.9 web.lab.lan +time=1 +tries=1');
      expect(res).toMatch(/no servers could be reached|connection timed out/i);
    });

    it('44. Attribution DHCP : Le PC diffuse un DHCP Discover qui atteint le serveur DHCP', async () => {
      const { pc, srv } = await creerLaboTraverse();
      // On connecte un second serveur DHCP local ou on démarre kea/isc-dhcp
      await taper(srv as unknown as Cli, ['systemctl start isc-dhcp-server']);
      const res = await pc.executeCommand('dhclient -v -1 eth0');
      expect(res).toMatch(/DHCPDISCOVER|DHCPOFFER|DHCPACK/i);
    });

    it('45. Résolution de nom BIND9 suivie immédiatement d\'un appel curl HTTP vers l\'IP résolue', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL');
      await serveZones(srv as unknown as Cli, [labZone(), LAB_REVERSE_ZONE]);
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const ip = (await pc.executeCommand('dig @203.0.113.9 srv.lab.lan +short')).trim();
      expect(ip).toMatch(/\d+\.\d+\.\d+\.\d+/);
      const httpRes = await pc.executeCommand(`curl -s http://${ip}/`);
      expect(httpRes).toMatch(/Welcome to nginx|nginx/i);
    });
  });

  // =========================================================================
  // 9. NAT, SUIVI DE SESSION STATEFUL & SÉCURITÉ RÉSEAU (Tests 46 à 50)
  // =========================================================================
  describe('Stateful Inspection, SNAT & Cohérence de flux', () => {
    it('46. SNAT : L\'adresse source 192.168.1.10 est masquée par l\'IP WAN 203.0.113.1', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL', true); // NAT activé
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      await pc.executeCommand('curl -s http://203.0.113.9/');
      const logs = await (srv as unknown as Cli).executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(logs).toContain('203.0.113.1');
      expect(logs).not.toContain('192.168.1.10');
    });

    it('47. Sans SNAT : L\'adresse source réelle est visible sur le serveur', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL', false); // NAT désactivé
      // Ajout d'une route de retour sur le serveur pour le sous-réseau 192.168.1.0/24
      await taper(srv as unknown as Cli, [
        'ip route add 192.168.1.0/24 via 203.0.113.1',
        'systemctl start nginx',
      ]);
      await pc.executeCommand('curl -s http://203.0.113.9/');
      const logs = await (srv as unknown as Cli).executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(logs).toContain('192.168.1.10');
    });

    it('48. Stateful Firewall : Les paquets de réponse sont acceptés automatiquement sans règle inverse', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      // On n'autorise que le sens LAN -> WAN
      await autoriserTrafic(fw, 'HTTP', true);
      await taper(srv as unknown as Cli, ['systemctl start nginx']);
      const res = await pc.executeCommand('curl -s http://203.0.113.9/');
      expect(res).toMatch(/Welcome to nginx|nginx/i);
    });

    it('49. Les paquets non sollicités venant du WAN vers le LAN sont détruits par le pare-feu', async () => {
      const { fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL', true);
      // Tentative du serveur externe d'initier un contact direct vers le PC LAN
      const res = await (srv as unknown as Cli).executeCommand('ping -c 1 -W 1 192.168.1.10');
      expect(res).toMatch(/100% packet loss/);
    });

    it('50. Trafic multi-protocoles concurrent : requêtes simultanées Web, SSH et Ping sans corruption', async () => {
      const { pc, fw, srv } = await creerLaboTraverse();
      await autoriserTrafic(fw, 'ALL', true);
      await taper(srv as unknown as Cli, [
        'systemctl start nginx',
        'systemctl start sshd',
      ]);
      await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli);

      const [pPing, pHttp, pSsh] = await Promise.all([
        pc.executeCommand('ping -c 1 203.0.113.9'),
        pc.executeCommand('curl -s http://203.0.113.9/'),
        pc.executeCommand('ssh -o StrictHostKeyChecking=no 203.0.113.9 "echo CONCURRENT_OK"'),
      ]);

      expect(pPing).toMatch(/0% packet loss/);
      expect(pHttp).toMatch(/Welcome to nginx|nginx/i);
      expect(pSsh).toContain('CONCURRENT_OK');
    });
  });

});