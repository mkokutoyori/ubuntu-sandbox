/**
 * Un hote trouve vivant est NOMME, et le nom vient de la chaine NSS.
 *
 * Ecrit A L'AVEUGLE. `nmap 10.0.0.2` ne rendait que `Nmap scan report for
 * 10.0.0.2` : aucune resolution inverse n'etait tentee, `-R` etait dans
 * la ligne des options ignorees, et `-n` gouvernait seulement la
 * resolution DIRECTE d'un nom tape par l'operateur. Un vrai `nmap` fait
 * l'inverse par defaut — c'est `-n` qu'il faut ecrire pour l'en empecher.
 *
 * Reference : `docs/nmap.1`. `-n` « (No reverse DNS resolution) […] never
 * do reverse DNS resolution on the active IP addresses it finds » ; `-R`
 * « always do reverse DNS resolution on the target IP addresses. Normally
 * reverse DNS is only performed against responsive (online) hosts ».
 * `Target::NameIP` (`Target.cc:364`) donne la regle d'affichage : le nom
 * TAPE par l'operateur l'emporte, sinon le nom resolu, sinon l'adresse
 * nue ; et `output.cc:1408` ajoute une ligne `rDNS record for <ip>:
 * <nom>` quand les deux existent et different.
 *
 * Le DEUXIEME defaut est de la famille que ce depot referme sans cesse :
 * `traceroute` portait sa PROPRE resolution inverse, qui ne consultait
 * que la source `files` (`/etc/hosts`) par un `as unknown as` sur
 * l'executeur, en ignorant `/etc/nsswitch.conf` et donc le DNS. Une
 * machine nommait donc un routeur dans `traceroute` et pas dans `nmap`,
 * ou l'inverse selon l'endroit ou le nom etait ecrit. Il n'y a plus
 * qu'une resolution inverse, celle de la chaine NSS, que `getent hosts`
 * et `ping` lisent deja.
 *
 * Un TROISIEME defaut est sorti de la sonde : la resolution DIRECTE de
 * `nmap` ne consultait pas davantage le resolveur. `findHostByAddress`
 * couvre `/etc/hosts` et les noms d'equipement — la moitie LOCALE de
 * `getaddrinfo` — donc un nom que seul le DNS connait rendait
 * `Failed to resolve`. Il est desormais demande a la machine quand la
 * moitie locale n'a rien su dire.
 *
 * DEUX cas ont corrige mon laboratoire plutot que le produit, et le dire
 * evite de les compter pour des defauts. Le rapport d'un hote MORT n'est
 * rendu que HORS `-sn` — un balayage de decouverte ne liste que ce qu'il
 * a trouve — donc c'est `-p` qui montre ce que `-R` change. Et une ligne
 * de `/etc/hosts` porte les DEUX sens a la fois : la resolution inverse y
 * retrouve le nom tape, il n'y a donc rien a signaler, et la divergence
 * qui fait paraitre `rDNS record` est celle d'un enregistrement A et d'un
 * PTR qui ne s'accordent pas.
 *
 * Discrimination : 6 cas tombent avant correctif, mesures en retirant
 * ENSEMBLE les cinq fichiers touches, le nouveau module compris — sans
 * lui, `traceroute` ne compile pas et la mesure ne dit plus rien. Les 5
 * qui passent des deux cotes sont nommes : `-n` (qui ne resolvait deja
 * rien), le nom TAPE (rendu par l'en-tete depuis toujours), l'adresse nue
 * sans aucun nom, `traceroute` sur `/etc/hosts` — le TEMOIN de la moitie
 * qui marchait — et le balayage lui-meme.
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

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
  await taper(cible, 'sudo systemctl start ssh');

  return { sw, scanner, cible };
}

async function nommerDansHosts(scanner: Cmd, ip: string, nom: string) {
  await taper(scanner, `sudo sh -c 'echo "${ip} ${nom}" >> /etc/hosts'`);
}

async function servirPtr(cible: LinuxServer, arpa: string, nom: string) {
  cible.dnsService.parseConfig(`ptr-record=${arpa},${nom}`);
  cible.dnsService.start();
}

describe('un hote vivant est nomme par la resolution inverse', () => {
  it('le nom vient de /etc/hosts quand il y est', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.2', 'cible.lab');

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain('Nmap scan report for cible.lab (10.0.0.2)');
  });

  it('le nom vient du DNS quand /etc/hosts se tait', async () => {
    const { scanner, cible } = await segment();
    await servirPtr(cible, '2.0.0.10.in-addr.arpa', 'serveur.lab');
    await taper(scanner, 'sudo sh -c \'echo "nameserver 10.0.0.2" > /etc/resolv.conf\'');

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain('Nmap scan report for serveur.lab (10.0.0.2)');
  });

  it('`-n` interdit la resolution inverse', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.2', 'cible.lab');

    const sortie = await taper(scanner, 'nmap -n -p 22 10.0.0.2');

    expect(sortie).toContain('Nmap scan report for 10.0.0.2');
    expect(sortie).not.toContain('cible.lab');
  });

  // Le rapport d'un hote MORT n'est rendu que hors `-sn` — un balayage de
  // decouverte ne liste que ce qu'il a trouve — donc c'est `-p` qui montre
  // ici la difference que `-R` fait.
  it('un hote MORT n est pas resolu, sauf sous `-R`', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.77', 'fantome.lab');

    const sans = await taper(scanner, 'nmap -p 22 10.0.0.77');
    expect(sans).toContain('Nmap scan report for 10.0.0.77 [host down]');
    expect(sans).not.toContain('fantome.lab');

    const avec = await taper(scanner, 'nmap -R -p 22 10.0.0.77');
    expect(avec).toContain('Nmap scan report for fantome.lab (10.0.0.77) [host down]');
  });

  it('le nom TAPE par l operateur l emporte sur le nom resolu', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.2', 'cible.lab');

    const sortie = await taper(scanner, 'nmap -p 22 cible.lab');

    expect(sortie).toContain('Nmap scan report for cible.lab (10.0.0.2)');
  });

  // Le nom TAPE ne vient PAS de `/etc/hosts` ici, et c'est necessaire :
  // une ligne de `hosts` porte les deux sens a la fois, donc la resolution
  // inverse y retrouverait le meme nom et il n'y aurait rien a signaler.
  // La divergence reelle est celle d'un enregistrement A et d'un PTR qui
  // ne s'accordent pas.
  it('la ligne `rDNS record` parait quand les deux noms different', async () => {
    const { scanner, cible } = await segment();
    cible.dnsService.parseConfig('address=/tape.lab/10.0.0.2');
    await servirPtr(cible, '2.0.0.10.in-addr.arpa', 'resolu.lab');
    await taper(scanner, 'sudo sh -c \'echo "nameserver 10.0.0.2" > /etc/resolv.conf\'');

    const sortie = await taper(scanner, 'nmap -p 22 tape.lab');

    expect(sortie).toContain('Nmap scan report for tape.lab (10.0.0.2)');
    expect(sortie).toContain('rDNS record for 10.0.0.2: resolu.lab');
  });
});

describe('il n y a qu une resolution inverse dans le depot', () => {
  it('`traceroute` nomme un hote que seul le DNS connait', async () => {
    const { scanner, cible } = await segment();
    await servirPtr(cible, '2.0.0.10.in-addr.arpa', 'saut.lab');
    await taper(scanner, 'sudo sh -c \'echo "nameserver 10.0.0.2" > /etc/resolv.conf\'');

    const sortie = await taper(scanner, 'traceroute 10.0.0.2');

    expect(sortie).toContain('saut.lab');
  });

  it('TEMOIN: `traceroute` nomme toujours ce que /etc/hosts declare', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.2', 'parfichier.lab');

    const sortie = await taper(scanner, 'traceroute 10.0.0.2');

    expect(sortie).toContain('parfichier.lab');
  });

  it('TEMOIN: `getent hosts` repond le meme nom que nmap', async () => {
    const { scanner, cible } = await segment();
    await servirPtr(cible, '2.0.0.10.in-addr.arpa', 'accord.lab');
    await taper(scanner, 'sudo sh -c \'echo "nameserver 10.0.0.2" > /etc/resolv.conf\'');

    const getent = await taper(scanner, 'getent hosts 10.0.0.2');
    const nmap = await taper(scanner, 'nmap -sn 10.0.0.2');

    expect(getent).toContain('accord.lab');
    expect(nmap).toContain('accord.lab');
  });
});

describe('les temoins du balayage', () => {
  it('TEMOIN: sans aucun nom, l adresse nue reste rendue', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain('Nmap scan report for 10.0.0.2');
    expect(sortie).not.toContain('rDNS record');
  });

  it('TEMOIN: le balayage lui-meme n a pas change', async () => {
    const { scanner } = await segment();
    await nommerDansHosts(scanner, '10.0.0.2', 'cible.lab');

    const sortie = await taper(scanner, 'nmap -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });
});
