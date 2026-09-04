/**
 * `-oX` ecrit le XML de nmap, et « Not shown » nomme le protocole et la
 * raison.
 *
 * Ecrit A L'AVEUGLE. Le point de depart est un defaut MESURE et non une
 * option manquante : `-oA <base>` promet TROIS fichiers sur une vraie
 * machine — `nmap.cc:918` ecrit `%s.nmap`, `%s.gnmap` ET `%s.xml` — et ce
 * simulateur n'en ecrivait que deux, sans un mot. Le XML est de surcroit
 * le seul format que les consommateurs machine lisent.
 *
 * ── La forme, relevee dans `xml.cc` et `output.cc` ──────────────────
 *
 * `xml_start_document` (`xml.cc:323`) ecrit la declaration puis
 * `<!DOCTYPE nmaprun>`. Aucun ecrivain de `xml.cc` n'INDENTE : les
 * retours a la ligne sont ceux que `xml_newline()` pose, et rien
 * d'autre — donc `<host …><status …/>` tient sur une seule ligne, comme
 * `<port …><state …/><service …/></port>`.
 *
 * L'element racine porte `scanner`, `args`, `start`, `startstr`,
 * `version` et `xmloutputversion` (`nmap.cc:2002`), cette derniere valant
 * `1.05` (`nmap.h:135`). Un commentaire la precede, du meme texte que
 * l'en-tete `#` de la sortie normale.
 *
 * `<scaninfo>` (`output.cc:1153`) dit le TYPE du balayage — `connect`,
 * `syn`, `udp`… — son protocole, le nombre de services et la LISTE des
 * ports en plages compactes (`output.cc:1082`).
 *
 * `<status>` porte `state`, `reason` et `reason_ttl`
 * (`output.cc:1258`) — les trois TOUJOURS, `--reason` ne gouvernant que
 * la sortie humaine. `<address addrtype="ipv4">` precede l'adresse de
 * couche lien (`addrtype="mac"`), elle-meme en MAJUSCULES (`%02X`), et
 * `<hostnames>` parait des que l'hote est vivant, meme vide.
 *
 * `<times srtt rttvar to>` est en MICROSECONDES : `write_host_status`
 * imprime `to.srtt / 1000000.0` pour obtenir des secondes.
 *
 * ── Ce que le XML a revele dans la sortie NORMALE ───────────────────
 *
 * `<extraports>` exige `<extrareasons reason count proto ports>`, donc la
 * RAISON et le PROTOCOLE de chaque port replie — que ce simulateur
 * jetait. La meme donnee alimente la ligne humaine, et `output.cc:594`
 * l'ecrit `%d %s %s %s%s (%s)`, c'est-a-dire
 * `994 closed tcp ports (reset)` : ce depot rendait `994 closed ports`,
 * sans protocole ni raison — la seule moitie qui DIAGNOSTIQUE, un port
 * silencieux et un port qui repond RST n'ayant pas la meme cause.
 *
 * ── La feuille de style ────────────────────────────────────────────
 *
 * `XSLStyleSheet()` (`NmapOps.cc:618`) cherche `nmap.xsl` sur le disque
 * et, faute de le trouver, rend l'URL RELATIVE `nmap.xsl` — « It won't
 * work, but it gives a clue that there is an nmap.xsl somewhere ». Aucune
 * image de ce simulateur ne porte ce fichier, donc c'est exactement cette
 * branche-la qui s'applique. `--no-stylesheet` supprime l'instruction et
 * `--webxml` la pointe vers `https://svn.nmap.org/nmap/docs/nmap.xsl`.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : tous les cas de la famille `-oX` tombent contre l'etat
 * d'avant (l'option y est refusee avant tout balayage), ainsi que les
 * deux cas de la ligne « Not shown ». Le cas de non-regression de `-oN`
 * est un TEMOIN et doit passer des deux cotes.
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

describe('le fichier XML existe et porte la forme de nmap', () => {
  it('la declaration, le DOCTYPE et la racine', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 22,80 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    const lignes = xml.split('\n');
    expect(lignes[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(lignes[1]).toBe('<!DOCTYPE nmaprun>');
    expect(xml).toMatch(/<nmaprun scanner="nmap" args="nmap -Pn -oX sortie\.xml -p 22,80 10\.0\.0\.2" start="\d+" startstr="[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}" version="7\.94" xmloutputversion="1\.05">/);
    expect(xml.trimEnd().endsWith('</nmaprun>')).toBe(true);
  });

  it('le commentaire d en-tete reprend la ligne de commande', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toMatch(
      /^<!-- Nmap 7\.94 scan initiated .* as: nmap -Pn -oX sortie\.xml -p 22 10\.0\.0\.2 -->$/m);
  });

  it('la feuille de style est l URL relative que nmap emet faute de fichier', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml.split('\n')[2]).toBe('<?xml-stylesheet href="nmap.xsl" type="text/xsl"?>');
  });

  it('--no-stylesheet la supprime et --webxml la pointe chez nmap.org', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn --no-stylesheet -oX sans.xml -p 22 10.0.0.2');
    await taper(scanner, 'nmap -Pn --webxml -oX web.xml -p 22 10.0.0.2');

    expect(await taper(scanner, 'cat sans.xml')).not.toContain('xml-stylesheet');
    expect(await taper(scanner, 'cat web.xml')).toContain(
      '<?xml-stylesheet href="https://svn.nmap.org/nmap/docs/nmap.xsl" type="text/xsl"?>');
  });
});

describe('le XML decrit le balayage et l hote', () => {
  it('scaninfo nomme le type, le protocole et la liste des ports', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 20-22,80 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toContain(
      '<scaninfo type="connect" protocol="tcp" numservices="4" services="20-22,80"/>');
  });

  it('un balayage SYN et un balayage UDP se nomment par leur type', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -sS -oX syn.xml -p 22 10.0.0.2');
    await taper(scanner, 'nmap -Pn -sU -oX udp.xml -p 53 10.0.0.2');

    expect(await taper(scanner, 'cat syn.xml')).toContain('<scaninfo type="syn" protocol="tcp"');
    expect(await taper(scanner, 'cat udp.xml')).toContain('<scaninfo type="udp" protocol="udp"');
  });

  it('l etat de l hote porte toujours sa raison et son TTL', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toMatch(/<host starttime="\d+" endtime="\d+"><status state="up" reason="\S+" reason_ttl="\d+"\/>/);
    expect(xml).toContain('<address addr="10.0.0.2" addrtype="ipv4"/>');
    expect(xml).toMatch(/<address addr="([0-9A-F]{2}:){5}[0-9A-F]{2}" addrtype="mac"\/>/);
  });

  it('un port ouvert porte son etat et son service sur la meme ligne', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    // `xml_start_tag("ports")` n'est suivi d'AUCUN retour a la ligne, donc
    // le premier port tient sur la meme ligne que l'ouverture.
    expect(xml).toMatch(
      /^<ports><port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="\d+"\/><service name="ssh" method="table" conf="3"\/><\/port>$/m);
  });

  it('l identification de version passe la methode a probed', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -sV -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toMatch(/<service name="ssh"[^>]*method="probed" conf="10"\/>/);
  });

  it('les temps sont en microsecondes', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    const m = /<times srtt="(\d+)" rttvar="(\d+)" to="(\d+)"\/>/.exec(xml);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![3])).toBeGreaterThanOrEqual(Number(m![1]));
  });

  it('runstats compte les hotes et clot le document', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oX sortie.xml -p 22 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toMatch(/<runstats><finished time="\d+" timestr="[^"]+" summary="Nmap done at [^"]+; 1 IP address \(1 host up\) scanned in [\d.]+ seconds" elapsed="[\d.]+" exit="success"\/><hosts up="1" down="0" total="1"\/>/);
  });
});

describe('les ports replies gardent leur raison', () => {
  it('la ligne humaine nomme le protocole et la raison', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -p 1-100 10.0.0.2');

    expect(sortie).toMatch(/^Not shown: \d+ closed tcp ports \(reset\)$/m);
  });

  it('un seul port replie se dit au singulier', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --open -p 22,81 10.0.0.2');

    expect(sortie).toMatch(/^Not shown: 1 closed tcp port \(reset\)$/m);
  });

  it('extraports et extrareasons portent le compte et la liste', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn --open -oX sortie.xml -p 22,81,82 10.0.0.2');
    const xml = await taper(scanner, 'cat sortie.xml');

    expect(xml).toContain('<extraports state="closed" count="2">');
    expect(xml).toContain(
      '<extrareasons reason="reset" count="2" proto="tcp" ports="81-82"/>');
    expect(xml).toContain('</extraports>');
  });
});

describe('les trois fichiers de -oA', () => {
  it('-oA ecrit le XML en plus du normal et du greppable', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oA balayage -p 22 10.0.0.2');
    const liste = await taper(scanner, 'ls');

    expect(liste).toContain('balayage.nmap');
    expect(liste).toContain('balayage.gnmap');
    expect(liste).toContain('balayage.xml');
  });

  it('-oN reste ce qu il etait', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -Pn -oN normal.txt -p 22 10.0.0.2');
    const normal = await taper(scanner, 'cat normal.txt');

    expect(normal).toContain('Nmap scan report for 10.0.0.2');
    expect(normal).toMatch(/^22\/tcp\s+open\s+ssh$/m);
  });
});

describe('un hote mort et un nom resolu', () => {
  it('un hote qui ne repond pas est down et ne porte aucun port', async () => {
    const { scanner } = await segment();

    await taper(scanner, 'nmap -oX mort.xml -p 22 10.0.0.44');
    const xml = await taper(scanner, 'cat mort.xml');

    expect(xml).toMatch(/<status state="down" reason="no-response" reason_ttl="0"\/>/);
    expect(xml).not.toContain('<ports>');
    expect(xml).toContain('<hosts up="0" down="1" total="1"/>');
  });

  it('un nom tape par l operateur parait comme hostname de type user', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'sudo sh -c "echo 10.0.0.2 cible.lab >> /etc/hosts"');

    await taper(scanner, 'nmap -Pn -oX nomme.xml -p 22 cible.lab');
    const xml = await taper(scanner, 'cat nomme.xml');

    // `write_xml_initial_hostinfo` ecrit les DEUX noms sans les comparer
    // — le nom tape et le nom resolu — chacun sur sa ligne. C'est la
    // ligne `rDNS record for` de la sortie humaine qui, elle, ne parait
    // que lorsqu'ils different.
    expect(xml).toContain('<hostnames>\n'
      + '<hostname name="cible.lab" type="user"/>\n'
      + '<hostname name="cible.lab" type="PTR"/>\n'
      + '</hostnames>');
  });
});
