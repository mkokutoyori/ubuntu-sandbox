/**
 * `-sV` SONDE, il ne se contente pas d'ecouter.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un vrai nginx qui ecoute et
 * repond sur le port 80 est rapporte `80/tcp open http` avec la colonne
 * VERSION VIDE, parce que la detection de version ne lit que ce qu'un
 * service VOLONTAIRE — la salutation d'OpenSSH, de SMTP, de FTP. Toute
 * la famille des services qui attendent que le CLIENT parle d'abord —
 * HTTP en tete — est donc invisible a `-sV`, alors que le simulateur
 * fait tourner un vrai nginx et un vrai Apache.
 *
 * ── Ce que fait un vrai nmap ────────────────────────────────────────
 *
 * `nmap-service-probes` declare des SONDES, chacune avec sa charge, sa
 * raretee et la liste des ports pour lesquels elle est probable :
 * `Probe TCP NULL q||` (ligne 33) n'envoie rien et lit ce qui vient,
 * `Probe TCP GetRequest q|GET / HTTP/1.0\r\n\r\n|` (ligne 6423,
 * `rarity 1`) parle la premiere. Les reponses sont confrontees a des
 * lignes `match`, dont celles qui nous concernent :
 *
 *   ligne 7028  Server: nginx/([\d.]+)      → p/nginx/ v/$1/
 *   ligne 7027  Server: nginx               → p/nginx/
 *   ligne 10696 Server: Apache[/ ](\d…) (…) → p/Apache httpd/ v/$1/ i/$2/
 *   ligne 7034  Server: Microsoft-IIS/(…)   → p/Microsoft IIS httpd/ v/$1/
 *
 * ── L'ordre des sondes, et il n'est pas celui qu'on croit ───────────
 *
 * `service_scan.cc:1822` : la sonde NULL est essayee la PREMIERE et
 * SANS CONDITION pour TCP — ni raretee ni intensite ne la gouvernent.
 * Puis `:1843` essaie les sondes dont la liste `ports` contient le port,
 * la encore SANS regarder la raretee. Ce n'est qu'ensuite (`:1870`) que
 * les sondes restantes sont filtrees par `raretee <= intensite`.
 *
 * La consequence est la seule chose vraiment contre-intuitive ici :
 * `--version-intensity 0` ne desactive PAS la detection sur le port 80,
 * puisque 80 figure dans la liste de `GetRequest` ; elle la desactive
 * sur un port qui n'y figure pas, 9200 par exemple. Et elle ne
 * desactive jamais la lecture de la salutation.
 *
 * `--version-light` vaut 2 et `--version-all` vaut 9 (`nmap.cc:779`) ;
 * hors bornes, « version-intensity must be between 0 and 9 ».
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 9 des 11 cas tombent contre l'etat d'avant. Les DEUX qui
 * passent des deux cotes sont les TEMOINS, nommes ici plutot que
 * laisses a decouvrir — la salutation d'OpenSSH, que la sonde NULL lit
 * deja, et un port ferme, qui n'a jamais eu de version. Leur role est de
 * prouver que la lecture de la salutation n'a pas ete cassee en donnant
 * une seconde sonde a `-sV`.
 *
 * Limite ecrite plutot que tue : ce lot ne porte que DEUX sondes, NULL
 * et GetRequest, parce que ce sont les deux dont le simulateur sait
 * produire une reponse. `--version-light` et `--version-all` sont donc
 * acceptees et exactes, mais aucune paire d'intensites entre 1 et 9 ne
 * peut se distinguer par le comportement tant qu'aucune sonde de
 * raretee intermediaire n'existe.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
  scanner.powerOn(); cible.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(cible.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  await taper(scanner, 'sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up');
  await taper(cible, 'sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up');

  return { scanner, cible };
}

async function ecouteSur(cible: Cmd, port: number): Promise<void> {
  const conf = '/etc/nginx/sites-available/default';
  await taper(cible,
    `echo "server {" > ${conf}`,
    `echo "    listen ${port};" >> ${conf}`,
    `echo "    root /var/www/html;" >> ${conf}`,
    `echo "    index index.html;" >> ${conf}`,
    `echo "}" >> ${conf}`,
    'sudo systemctl start nginx');
}

/** La colonne VERSION de la ligne du port demande. */
function versionDe(rapport: string, port: number): string {
  const ligne = new RegExp(
    `^${port}/tcp[ \\t]+\\S+[ \\t]+\\S+[ \\t]*(.*)$`, 'm').exec(rapport);
  return ligne === null ? '<absent>' : ligne[1].trim();
}

describe('un serveur qui attend le client est enfin identifie', () => {
  it('nginx rend son produit et sa version', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start nginx');

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 80 10.0.0.2');

    expect(rapport).toMatch(/80\/tcp\s+open\s+http/);
    expect(versionDe(rapport, 80)).toBe('nginx 1.24.0');
  });

  it('Apache aussi, parentheses doublees comprises', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start apache2');

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 80 10.0.0.2');

    expect(versionDe(rapport, 80)).toBe('Apache httpd 2.4.52 ((Ubuntu))');
  });

  it('la sonde est SUR LE FIL, pas dans l objet du serveur', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start nginx',
      'tcpdump -nn -i eth0 tcp port 80 -w sv.pcap &');

    await taper(scanner, 'nmap -Pn -sV -p 80 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r sv.pcap -nn -A');

    expect(capture).toContain('GET / HTTP/1.0');
    expect(capture).toContain('Server: nginx/1.24.0');
  });
});

describe('l intensite gouverne les sondes qui ne visent pas ce port', () => {
  it('un port hors de la liste de GetRequest est sonde au defaut', async () => {
    const { scanner, cible } = await segment();
    await ecouteSur(cible, 9200);

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 9200 10.0.0.2');

    expect(versionDe(rapport, 9200)).toBe('nginx 1.24.0');
  });

  it('et ne l est plus a l intensite 0', async () => {
    const { scanner, cible } = await segment();
    await ecouteSur(cible, 9200);

    const rapport = await taper(scanner,
      'nmap -Pn -sV --version-intensity 0 -p 9200 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(rapport).toMatch(/9200\/tcp\s+open/);
    expect(versionDe(rapport, 9200)).toBe('');
  });

  it('le port 80, lui, reste sonde a l intensite 0', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start nginx');

    const rapport = await taper(scanner,
      'nmap -Pn -sV --version-intensity 0 -p 80 10.0.0.2');

    expect(versionDe(rapport, 80)).toBe('nginx 1.24.0');
  });

  it('--version-light vaut 2 et --version-all vaut 9', async () => {
    const { scanner, cible } = await segment();
    await ecouteSur(cible, 9200);

    const leger = await taper(scanner, 'nmap -Pn -sV --version-light -p 9200 10.0.0.2');
    const tout = await taper(scanner, 'nmap -Pn -sV --version-all -p 9200 10.0.0.2');

    expect(leger).not.toContain('not implemented');
    expect(versionDe(leger, 9200)).toBe('nginx 1.24.0');
    expect(versionDe(tout, 9200)).toBe('nginx 1.24.0');
  });

  it('une intensite hors bornes est un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sV --version-intensity 10 -p 80 10.0.0.2');

    expect(sortie).toContain('version-intensity must be between 0 and 9');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('la salutation se lit meme a l intensite 0', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const rapport = await taper(scanner,
      'nmap -Pn -sV --version-intensity 0 -p 22 10.0.0.2');

    expect(versionDe(rapport, 22)).toContain('OpenSSH');
  });
});

describe('TEMOINS', () => {
  it('la salutation d OpenSSH est lue comme avant', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 22 10.0.0.2');

    expect(versionDe(rapport, 22)).toContain('OpenSSH');
  });

  it('un port ferme n a pas de version', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 80 10.0.0.2');

    expect(rapport).toMatch(/80\/tcp\s+closed\s+http/);
    expect(versionDe(rapport, 80)).toBe('');
  });
});
