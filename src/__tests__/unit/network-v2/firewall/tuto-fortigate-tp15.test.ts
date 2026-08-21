import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy', 'edit 1',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function serveurHttps(srvDmz: LinuxServer): Promise<void> {
  await taper(srvDmz, [
    'mkdir -p /etc/nginx/ssl',
    'openssl req -x509 -newkey rsa:2048 -nodes -days 365'
      + ' -subj "/CN=srv.lab.local" -addext "subjectAltName=DNS:srv.lab.local"'
      + ' -keyout /etc/nginx/ssl/srv.key -out /etc/nginx/ssl/srv.crt',
  ]);
  await srvDmz.executeCommand(
    'printf "server {\\n listen 443 ssl;\\n ssl_certificate /etc/nginx/ssl/srv.crt;\\n'
    + ' ssl_certificate_key /etc/nginx/ssl/srv.key;\\n}\\n" > /etc/nginx/sites-available/ssl.conf');
  await taper(srvDmz, [
    'ln -s /etc/nginx/sites-available/ssl.conf /etc/nginx/sites-enabled/ssl.conf',
    'systemctl reload nginx',
  ]);
}

describe('TP 15 — activer l\'inspection profonde proprement', () => {
  it('etape 1 : l\'AC d\'usine Fortinet_CA_SSL EXISTE sur le pare-feu', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config vpn certificate local']);
    const vu = await fgt.executeCommand('show');
    await fgt.executeCommand('end');

    expect(vu).toContain('Fortinet_CA_SSL');
  });

  it('etape 2 : l\'AC se LIT, et le transfert TFTP part vers le serveur',
    async () => {
      const { fgt } = await laboratoire();

      const pem = await fgt.executeCommand('show vpn certificate local Fortinet_CA_SSL');
      expect(pem).toContain('BEGIN CERTIFICATE');

      const vu = await fgt.executeCommand(
        'execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer 192.168.10.10');
      expect(vu).not.toMatch(/Unknown action|command parse error|no UDP socket layer/i);

      const absent = await fgt.executeCommand(
        'execute vpn certificate local export tftp Absent fortinet_ca.cer 192.168.10.10');
      expect(absent).toMatch(/does not exist/i);
    });

  it('etape 3 : le PC installe l\'AC dans son magasin systeme', async () => {
    const { pcLan } = await laboratoire();
    await pcLan.executeCommand(
      'printf "%s\\n" "-----BEGIN CERTIFICATE-----" > /usr/local/share/ca-certificates/fortinet_ca.crt');
    const vu = await pcLan.executeCommand('sudo update-ca-certificates');

    expect(vu).not.toMatch(/command not found/i);
    expect(vu).toMatch(/certificate/i);
  });

  it('etape 4 : un profil d\'inspection PROFONDE se declare', async () => {
    const { fgt } = await laboratoire();
    const sorties = await taper(fgt, [
      'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
      'set comment "Inspection profonde du laboratoire"',
      'config https', 'set ports 443', 'set status deep-inspection', 'end',
      'set server-cert-mode re-sign',
      'set caname "Fortinet_CA_SSL"',
      'set untrusted-caname "Fortinet_CA_Untrusted"',
      'next', 'end',
    ]);
    propre(sorties);

    const conf = await fgt.executeCommand('show firewall ssl-ssh-profile Deep-Lab');
    expect(conf).toContain('set status deep-inspection');
    expect(conf).toContain('set server-cert-mode re-sign');
    expect(conf).toContain('set caname "Fortinet_CA_SSL"');
  });

  it('etape 5 : une exemption par categorie FortiGuard se declare', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
      'config https', 'set status deep-inspection', 'end', 'next', 'end',
    ]);
    const sorties = await taper(fgt, [
      'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
      'config ssl-exempt', 'edit 1',
      'set type fortiguard-category', 'set fortiguard-category 31',
      'next', 'end', 'next', 'end',
    ]);
    propre(sorties);

    const conf = await fgt.executeCommand('show firewall ssl-ssh-profile Deep-Lab');
    expect(conf).toContain('set type fortiguard-category');
    expect(conf).toContain('set fortiguard-category 31');
  });

  it('etape 6 : le profil s\'attache a la politique', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
      'config https', 'set status deep-inspection', 'end', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
    ]);

    const conf = await fgt.executeCommand('show firewall policy 1');
    expect(conf).toContain('set ssl-ssh-profile "Deep-Lab"');
  });

  it('etape 7 : le certificat presente au client est EMIS par le pare-feu', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await serveurHttps(srvDmz);
    await taper(fgt, [
      'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
      'config https', 'set status deep-inspection', 'end',
      'set server-cert-mode re-sign', 'set caname "Fortinet_CA_SSL"',
      'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
    ]);

    const vu = await pcLan.executeCommand(
      'openssl s_client -connect 192.168.20.10:443 -servername srv.lab.local');

    expect(vu).toMatch(/i:.*Fortinet/i);
    expect(vu).toMatch(/s:.*srv\.lab\.local/i);
  });

  it('etape 7 : SANS inspection profonde, le certificat reste celui du serveur', async () => {
    const { pcLan, srvDmz } = await laboratoire();
    await serveurHttps(srvDmz);

    const vu = await pcLan.executeCommand(
      'openssl s_client -connect 192.168.20.10:443 -servername srv.lab.local');

    expect(vu).toMatch(/s:.*srv\.lab\.local/i);
    expect(vu).not.toMatch(/i:.*Fortinet/i);
  });

  it('etape 9 : un client qui ne connait pas l\'AC REFUSE le certificat substitue',
    async () => {
      const { fgt, pcLan, srvDmz } = await laboratoire();
      await serveurHttps(srvDmz);
      await taper(fgt, [
        'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
        'config https', 'set status deep-inspection', 'end',
        'set server-cert-mode re-sign', 'set caname "Fortinet_CA_SSL"',
        'next', 'end',
        'config firewall policy', 'edit 1',
        'set utm-status enable', 'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
      ]);

      const vu = await pcLan.executeCommand('curl https://192.168.20.10/');
      expect(vu).toMatch(/certificate|unable to get local issuer|self.signed/i);
    });

  it('etape 3 puis 9 : le PC qui a installe l\'AC ACCEPTE le certificat substitue',
    async () => {
      const { fgt, pcLan, srvDmz } = await laboratoire();
      await serveurHttps(srvDmz);
      await taper(fgt, [
        'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
        'config https', 'set status deep-inspection', 'end',
        'set server-cert-mode re-sign', 'set caname "Fortinet_CA_SSL"',
        'next', 'end',
        'config firewall policy', 'edit 1',
        'set utm-status enable', 'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
      ]);

      const avant = await pcLan.executeCommand(
        'openssl s_client -connect 192.168.20.10:443');
      expect(avant).toMatch(/Verification error/i);

      const pem = await fgt.executeCommand(
        'show vpn certificate local Fortinet_CA_Untrusted');
      const armure = pem.split('\n')
        .map(ligne => ligne.trim().replace(/^set certificate "/, '').replace(/"$/, ''))
        .filter(ligne => ligne.length > 0 && !ligne.startsWith('config')
          && !ligne.startsWith('edit') && !ligne.startsWith('next')
          && !ligne.startsWith('end') && !ligne.startsWith('set '));
      const debut = armure.indexOf('-----BEGIN CERTIFICATE-----');
      const fin = armure.indexOf('-----END CERTIFICATE-----');
      expect(debut).toBeGreaterThanOrEqual(0);

      for (const ligne of armure.slice(debut, fin + 1)) {
        await pcLan.executeCommand(`echo '${ligne}' >> /tmp/fgt_ca.crt`);
      }
      await taper(pcLan, [
        'sudo cp /tmp/fgt_ca.crt /usr/local/share/ca-certificates/fortinet_ca.crt',
        'sudo update-ca-certificates',
      ]);

      const apres = await pcLan.executeCommand(
        'openssl s_client -connect 192.168.20.10:443');
      expect(apres).toContain('Verification: OK');
      expect(apres).toMatch(/i:.*Fortinet/i);
    });

  it('etape 5 : une exemption par ADRESSE laisse passer le certificat d\'origine',
    async () => {
      const { fgt, pcLan, srvDmz } = await laboratoire();
      await serveurHttps(srvDmz);
      await taper(fgt, [
        'config firewall address', 'edit "SRV-WEB"',
        'set subnet 192.168.20.10 255.255.255.255', 'next', 'end',
        'config firewall ssl-ssh-profile', 'edit "Deep-Lab"',
        'config https', 'set status deep-inspection', 'end',
        'set server-cert-mode re-sign', 'set caname "Fortinet_CA_SSL"',
        'config ssl-exempt', 'edit 1',
        'set type address', 'set address "SRV-WEB"', 'next', 'end',
        'next', 'end',
        'config firewall policy', 'edit 1',
        'set utm-status enable', 'set ssl-ssh-profile "Deep-Lab"', 'next', 'end',
      ]);

      const vu = await pcLan.executeCommand(
        'openssl s_client -connect 192.168.20.10:443');

      expect(vu).toMatch(/i:CN = srv\.lab\.local/);
      expect(vu).not.toMatch(/Fortinet/i);
    });

  it('etape 10 : `get system performance status` rend la charge', async () => {
    const { fgt } = await laboratoire();
    const vu = await fgt.executeCommand('get system performance status');

    expect(vu).not.toMatch(/Unknown action|command parse error/i);
    expect(vu).toMatch(/CPU states|Memory states/i);
  });

  it('etape 11 : on repasse au profil leger', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config firewall policy', 'edit 1',
      'set utm-status enable',
      'set ssl-ssh-profile "certificate-inspection"', 'next', 'end',
    ]);

    const conf = await fgt.executeCommand('show firewall policy 1');
    expect(conf).toContain('set ssl-ssh-profile "certificate-inspection"');
  });
});
