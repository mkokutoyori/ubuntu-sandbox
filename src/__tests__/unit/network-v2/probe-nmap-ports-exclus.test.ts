/**
 * Un port se RETIRE du balayage, et la table des sondes en retire
 * d'autres pour son propre compte.
 *
 * Ecrit A L'AVEUGLE. `--exclude-ports` et `--allports` etaient toutes
 * deux refusees comme non implantees. Ce sont DEUX exclusions
 * differentes, et les confondre serait le defaut a ne pas commettre.
 *
 * ── `--exclude-ports` retire du BALAYAGE ────────────────────────────
 *
 * `nmap.cc:1709` appelle `removepts(o.exclude_portlist, &ports)` apres
 * toute la selection de ports, donc l'exclusion s'applique quelle que
 * soit la facon dont les ports ont ete choisis (`-p`, `-F`,
 * `--top-ports`). La grammaire est celle de `-p`, prefixes `T:`/`U:`
 * compris. Deux occurrences sont un refus (`nmap.cc:980`) : « Only 1
 * --exclude-ports option allowed, separate multiple ranges with
 * commas. »
 *
 * ── `--allports` ne retire rien, il ANNULE ──────────────────────────
 *
 * L'exclusion qu'il annule n'est PAS celle de l'operateur : c'est la
 * directive `Exclude` de `nmap-service-probes` (ligne 29,
 * `Exclude T:9100-9107`), c'est-a-dire les ports que la table des
 * sondes demande de ne JAMAIS soumettre a la detection de version —
 * historiquement les imprimantes, qu'une sonde HTTP fait imprimer des
 * pages de charabia. `service_scan.cc:1444` et `:2809` sont les deux
 * points ou `override_excludeports` court-circuite cette liste.
 *
 * La consequence a retenir : `--allports` ne fait revenir aucun port
 * qu'`--exclude-ports` a retire, et `--exclude-ports` ne dispense
 * d'aucune detection de version. Les deux options ne se croisent nulle
 * part.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 6 des 9 cas tombent contre l'etat d'avant. Les TROIS qui
 * passent des deux cotes sont nommes plutot que laisses a decouvrir. Le
 * TEMOIN — le balayage sans exclusion, qui voit ses deux ports — et le
 * cas du port 9200, qui garde la detection de version posee par le lot
 * precedent et prouve que la nouvelle exclusion ne mord que sur la
 * plage des imprimantes. Le troisieme, « l'exclusion s'applique aussi a
 * un choix par -F », passait avant pour une raison qui ne prouve
 * RIEN : l'option entiere etait refusee, donc aucun port n'etait rendu
 * et l'assertion negative etait vraie a vide.
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
  await taper(cible, 'sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo systemctl start ssh');

  return { scanner, cible };
}

/** Le serveur HTTP de la cible, sur le port demande. */
async function servirHttpSur(cible: Cmd, port: number): Promise<void> {
  const conf = '/etc/nginx/sites-available/default';
  await taper(cible,
    `echo "server {" > ${conf}`,
    `echo "    listen ${port};" >> ${conf}`,
    `echo "    root /var/www/html;" >> ${conf}`,
    `echo "    index index.html;" >> ${conf}`,
    `echo "}" >> ${conf}`,
    'sudo systemctl start nginx');
}

/** Les ports que le rapport enumere. */
function portsRendus(rapport: string): number[] {
  return [...rapport.matchAll(/^(\d+)\/tcp\s/gm)].map((m) => Number(m[1]));
}

function versionDe(rapport: string, port: number): string {
  const ligne = new RegExp(
    `^${port}/tcp[ \\t]+\\S+[ \\t]+\\S+[ \\t]*(.*)$`, 'm').exec(rapport);
  return ligne === null ? '<absent>' : ligne[1].trim();
}

describe('--exclude-ports retire du balayage', () => {
  it('un port nomme n est pas balaye', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner,
      'nmap -Pn --exclude-ports 22 -p 22,80 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(portsRendus(rapport)).toEqual([80]);
  });

  it('une plage aussi, prefixe de protocole compris', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner,
      'nmap -Pn --exclude-ports T:20-25 -p 21,22,23,80 10.0.0.2');

    expect(portsRendus(rapport)).toEqual([80]);
  });

  it('l exclusion s applique aussi a un choix par -F', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner, 'nmap -Pn -F --exclude-ports 22 10.0.0.2');

    expect(portsRendus(rapport)).not.toContain(22);
  });

  it('deux occurrences sont un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn --exclude-ports 22 --exclude-ports 80 -p 22,80 10.0.0.2');

    expect(sortie).toContain('Only 1 --exclude-ports option allowed,'
      + ' separate multiple ranges with commas.');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('--allports annule l exclusion de la TABLE DES SONDES', () => {
  it('un port de la plage des imprimantes n est pas version-scanne', async () => {
    const { scanner, cible } = await segment();
    await servirHttpSur(cible, 9100);

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 9100 10.0.0.2');

    expect(rapport).toMatch(/9100\/tcp\s+open/);
    expect(versionDe(rapport, 9100)).toBe('');
  });

  it('--allports le fait sonder quand meme', async () => {
    const { scanner, cible } = await segment();
    await servirHttpSur(cible, 9100);

    const rapport = await taper(scanner, 'nmap -Pn -sV --allports -p 9100 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(versionDe(rapport, 9100)).toBe('nginx 1.24.0');
  });

  it('un port hors de la plage reste sonde sans --allports', async () => {
    const { scanner, cible } = await segment();
    await servirHttpSur(cible, 9200);

    const rapport = await taper(scanner, 'nmap -Pn -sV -p 9200 10.0.0.2');

    expect(versionDe(rapport, 9200)).toBe('nginx 1.24.0');
  });

  it('--allports ne fait pas revenir un port retire par --exclude-ports', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner,
      'nmap -Pn --allports --exclude-ports 22 -p 22,80 10.0.0.2');

    expect(portsRendus(rapport)).toEqual([80]);
  });
});

describe('TEMOIN', () => {
  it('sans exclusion, les deux ports sont balayes', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner, 'nmap -Pn -p 22,80 10.0.0.2');

    expect(portsRendus(rapport)).toEqual([22, 80]);
  });
});
