/**
 * `curl -w '%{time_appconnect}'` d'une connexion TLS mesure la fin de la poignee de main, pas la fin du connect TCP.
 * Mesure de depart (TODO.md [curl-writeout]) : sur un lien cable, https rendait time_appconnect == time_connect et
 * time_pretransfer prenait la date ou la poignee de main commence. Le vrai curl 8.5.0 ordonne
 * time_connect <= time_appconnect <= time_pretransfer <= time_starttransfer <= time_total, et rend time_appconnect = 0
 * pour une connexion en clair.
 * Corrige : HttpsClientSession date la fin de la poignee de main (simulationNowMs, qui avance avec les trames) et
 * CurlTransfer en tire appconnect et pretransfer.
 *
 * Discrimine par `git stash` sur src/network : 1 des 4 cas tombe avant (appconnect strictement apres connect).
 * TEMOINS : l'ordre croissant des cinq mesures, le 0 d'une connexion http et pretransfer >= appconnect > 0, qui valent
 * avant comme apres (avant, les deux valeurs etaient egales a time_connect).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<LinuxPC> {
  const srv = new LinuxServer('linux-server', 'S');
  srv.powerOn();
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0')!, pc.getPort('eth0')!);
  await srv.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/private/s.key -out /etc/ssl/certs/s.crt -days 90 -nodes -subj "/CN=10.0.0.1"');
  await srv.executeCommand(
    `sh -c 'printf "server {\\n listen 443 ssl;\\n root /var/www/html;\\n ssl_certificate /etc/ssl/certs/s.crt;\\n `
    + `ssl_certificate_key /etc/ssl/private/s.key;\\n}\\n" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return pc;
}

const timings = async (pc: LinuxPC, flags: string, url: string): Promise<number[]> => {
  const out = String(await pc.executeCommand(
    `curl -s ${flags} -o /dev/null -w '%{time_connect} %{time_appconnect} %{time_pretransfer} %{time_starttransfer} %{time_total}' ${url}`)).trim();
  return out.split(' ').map(Number);
};

describe('time_appconnect', () => {
  it('TEMOIN — les cinq mesures d une requete https croissent', async () => {
    const t = await timings(await lab(), '-k', 'https://10.0.0.1/');
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
  });

  it('la poignee de main TLS finit apres le connect TCP', async () => {
    const [connect, appconnect] = await timings(await lab(), '-k', 'https://10.0.0.1/');
    expect(appconnect).toBeGreaterThan(connect);
  });

  it('time_pretransfer n est pas anterieur a la fin de la poignee de main', async () => {
    const [, appconnect, pretransfer] = await timings(await lab(), '-k', 'https://10.0.0.1/');
    expect(pretransfer).toBeGreaterThanOrEqual(appconnect);
    expect(appconnect).toBeGreaterThan(0);
  });

  it('TEMOIN — une connexion http rend time_appconnect = 0', async () => {
    const [, appconnect] = await timings(await lab(), '', 'http://10.0.0.1/');
    expect(appconnect).toBe(0);
  });
});
