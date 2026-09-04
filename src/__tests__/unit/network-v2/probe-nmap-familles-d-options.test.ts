/**
 * Une option inconnue ne se tait pas, et sa VALEUR n'est pas une cible.
 *
 * Ecrit A L'AVEUGLE. L'analyseur finit par `if (a.startsWith('-'))
 * continue;` : tout ce qu'il ne connait pas est jete EN SILENCE. Deux
 * consequences, dont la seconde n'est pas cosmetique.
 *
 * (1) `nmap -Z 10.0.0.2` balaye tranquillement alors qu'aucun `-Z`
 * n'existe, et `nmap --reason-only` de meme — cette derniere figurait
 * meme dans la ligne des options EXPLICITEMENT ignorees, alors que le
 * vrai `nmap` ne la connait pas : la table `long_options[]` de `nmap.cc`
 * (100 entrees, relevee et non rappelee) ne la contient pas.
 *
 * (2) Une option a VALEUR qu'on ignore laisse sa valeur derriere elle, et
 * la boucle range tout jeton sans tiret dans les CIBLES.
 * `nmap --max-rate 100 10.0.0.2` balaye donc `100` comme s'il s'agissait
 * d'une machine. C'est une option de temporisation qui fabrique une
 * cible.
 *
 * La reponse est celle que ce depot a deja retenue pour `curl`
 * (`docs/PRD-Curl.md`), et pour la meme raison : TROIS familles, pas
 * deux. Une option implantee agit ; une option que `nmap` connait et que
 * cette construction n'implante pas est refusee en NOMMANT le
 * simulateur, parce qu'aucun vrai `nmap` n'est jamais dans cette
 * situation et que lui repondre « inconnue » serait un second mensonge ;
 * une option qui n'existe nulle part recoit le message de `nmap`
 * lui-meme.
 *
 * Ce message est celui de `getopt_long` de la glibc, que `nmap.cc`
 * n'inhibe pas (`opterr` reste a 1), suivi de ce qu'ecrit son `case '?'`
 * ligne 1095 : `error("See the output of nmap -h for a summary of
 * options.")` puis `exit(-1)`.
 *
 * DEUX options restent acceptees et sans effet, et c'est un choix
 * defendu plutot qu'un oubli : `-T` ne regle que la vitesse et le
 * parallelisme, `-r` que l'ordre de tirage des ports. Ce simulateur livre
 * ses trames de facon synchrone et ne tire aucun ordre, donc leur effet
 * observable est DEJA atteint — les refuser dirait qu'il manque quelque
 * chose qui ne manque pas.
 *
 * Les deux listes de `NmapOptionTables.ts` ne disent DELIBEREMENT pas
 * lesquelles prennent une valeur : le refus etant immediat, cette valeur
 * n'est jamais atteinte, donc une telle colonne ne serait lue par
 * personne. Une premiere version l'avait ecrite, et c'etait exactement la
 * donnee inerte que ce depot refuse.
 *
 * `-h` et `-V` sont IMPLANTEES et non refusees, et la raison est dans le
 * message de refus lui-meme : il renvoie a `nmap -h`. Le laisser pointer
 * vers une option qui repondrait « non implantee » serait une impasse.
 * Les lignes `Platform:` et `Compiled with:` que `-V` affiche sur une
 * vraie machine decrivent une construction qui n'existe pas ici : elles
 * sont OMISES plutot qu'inventees.
 *
 * Discrimination : 8 cas tombent avant correctif. Les 5 qui passent des
 * deux cotes sont nommes — `-T` et `-r`, deja acceptes en silence et qui
 * doivent le rester ; les deux TEMOINS, dont c'est le role de montrer que
 * le refus n'a pas mange ce qui est valide ; et `-h`, qui passait pour
 * une raison qui ne prouve rien du mecanisme — l'option etait ignoree, il
 * ne restait donc aucune cible, et le chemin « pas de cible » rendait
 * deja l'usage.
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

describe('une option qui n existe PAS est refusee dans les mots de nmap', () => {
  it('une option courte inventee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Z 10.0.0.2');

    expect(sortie).toContain("nmap: invalid option -- 'Z'");
    expect(sortie).toContain('See the output of nmap -h for a summary of options.');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('une option longue inventee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --zorglub 10.0.0.2');

    expect(sortie).toContain("nmap: unrecognized option '--zorglub'");
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('`--reason-only` n existe pas davantage', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --reason-only -p 22 10.0.0.2');

    expect(sortie).toContain("nmap: unrecognized option '--reason-only'");
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('une option que nmap CONNAIT et que ce simulateur n implante pas', () => {
  it('est refusee en nommant le simulateur', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --osscan-guess -p 22 10.0.0.2');

    expect(sortie).toContain('nmap: option --osscan-guess: is not implemented in this simulator');
    expect(sortie).not.toContain("unrecognized option");
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('sa VALEUR ne devient jamais une cible', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --max-rate 100 10.0.0.2');

    expect(sortie).toContain('nmap: option --max-rate: is not implemented in this simulator');
    expect(sortie).not.toContain('Nmap scan report for 100');
  });

  it('une option courte a valeur non plus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -D 10.0.0.9 -p 22 10.0.0.2');

    expect(sortie).toContain('nmap: option -D: is not implemented in this simulator');
    expect(sortie).not.toContain('Nmap scan report for 10.0.0.9');
  });
});

describe('les options acceptees SANS effet le sont pour une raison', () => {
  it('`-T` ne regle qu une vitesse, et il n y en a pas a regler', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -T4 -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).not.toContain('not implemented');
  });

  it('`-r` ne regle qu un ordre de tirage, et rien n est tire', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -r -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });
});

describe('`-h` et `-V` repondent, puisque le refus renvoie a `-h`', () => {
  it('`-h` rend l usage sans rien balayer', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -h');

    expect(sortie).toContain('Usage: nmap [Scan Type(s)] [Options] {target specification}');
    expect(sortie).not.toContain('not implemented');
  });

  it('`-V` rend la ligne de version', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -V');

    expect(sortie).toContain('Nmap version 7.94 ( https://nmap.org )');
  });

  it('`--version` fait de meme, et `--help` aussi', async () => {
    const { scanner } = await segment();

    expect(await taper(scanner, 'nmap --version')).toContain('Nmap version 7.94');
    expect(await taper(scanner, 'nmap --help')).toContain('Usage: nmap');
  });
});

describe('les temoins', () => {
  it('TEMOIN: toutes les options implantees restent acceptees', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -sT -Pn -n -v --open --reason -p 22 --top-ports 5 10.0.0.2');

    expect(sortie).not.toContain('not implemented');
    expect(sortie).not.toContain('unrecognized');
    expect(sortie).toContain('Nmap scan report');
  });

  it('TEMOIN: une cible sans tiret reste une cible', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain('Nmap scan report for 10.0.0.2');
  });
});
