/**
 * `ssl_verify_client on` : le verificateur de certificats clients de nginx (et d'Apache, `SSLVerifyClient`) lisait l'heure
 * globale du simulateur : un serveur dont on avait pose l'horloge soixante jours plus tard acceptait toujours le certificat
 * client de trente jours. Deux causes. (1) `buildClientVerifier` construisait son CertificateVerifier sans horloge. (2) Plus
 * large : l'hote des services nginx et Apache (LinuxMachine) fournissait `simulationDate()` comme `now`, donc l'horloge de la
 * machine ne datait ni le verificateur, ni le client OCSP, ni les lignes du journal d'acces (`$time_local`). Corrige :
 * `buildClientVerifier` prend l'horloge de l'hote (`OcspWireDeps.now`) et les deux hotes lisent `executor.simulatedDate()`,
 * l'horloge de la machine.
 *
 * Discrimine par `git stash` sur src/network : 2 des 3 cas tombent avant (certificat client refuse, journal d'acces date). Le
 * TEMOIN (a l'heure, le certificat client est accepte) passe des deux cotes. Apache partage buildClientVerifier et la ligne
 * `now` corrigee mais n'a pas de sonde propre ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh, lab, ALICE } from './_httpsLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const DAY = 24 * 3600 * 1000;

const SERVER = `server {
  listen 443 ssl;
  server_name _;
  root /var/www/html;
  index index.nginx-debian.html;
  ssl_certificate ${PKI}/srv.crt;
  ssl_certificate_key ${PKI}/srv.key;
  ssl_verify_client on;
  ssl_client_certificate ${PKI}/ca.crt;
}
`;

async function up(srv: LinuxServer): Promise<void> {
  const text = SERVER.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  await sh(srv, `sh -c 'printf "${text}" > /etc/nginx/sites-available/default'`);
  await sh(srv, 'systemctl start nginx');
}

describe('nginx verifie le certificat client sur l horloge de sa machine', () => {
  it('TEMOIN — a l heure, le certificat client de trente jours est accepte', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    expect(await sh(srv, `curl -sS -k ${ALICE} https://127.0.0.1/`)).toContain('Welcome to nginx!');
  });

  it('un serveur avance de soixante jours refuse ce certificat client', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    await sh(srv, `date -s @${Math.floor((srv.getSystemClockMs() + 60 * DAY) / 1000)}`);
    expect(await sh(srv, `curl -sS -k ${ALICE} https://127.0.0.1/`)).toContain('400 The SSL certificate error');
  });

  it('le journal d acces porte la date de la machine apres date -s', async () => {
    const srv = machine(); await lab(srv); await up(srv);
    await sh(srv, `date -s @${Math.floor((srv.getSystemClockMs() + 60 * DAY) / 1000)}`);
    await sh(srv, `curl -sS -k ${ALICE} https://127.0.0.1/`);
    const stamp = (await sh(srv, 'date +%b/%Y')).trim();
    const month = stamp.slice(0, 3);
    expect(await sh(srv, 'cat /var/log/nginx/access.log')).toContain(`/${month}/`);
  });
});
