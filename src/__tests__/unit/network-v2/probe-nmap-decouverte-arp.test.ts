/**
 * Un hote du MEME segment se decouvre par ARP, pas par ICMP.
 *
 * Ecrit A L'AVEUGLE. `discoverHost` ne connaissait que deux moyens — un
 * echo ICMP, puis une connexion TCP vers 80 et 443 — c'est-a-dire
 * exactement ce qu'un `nmap` NON PRIVILEGIE fait, et rien de ce qu'il
 * fait quand il peut ecrire sur le lien. Consequence mesurable : un hote
 * du meme segment qui jette l'ICMP et filtre tout le TCP est rendu
 * `down`, alors qu'il repond a l'ARP et qu'un vrai `nmap` le trouve.
 *
 * Reference : `nmap/nmap`. `targets.cc`, `refresh_hostbatch` —
 * `if (current_target->directlyConnected() && o.implicitARPPing)
 * { arpping(...); arpping_done = true; }`, et plus bas
 * `else if (!arpping_done) massping(...)` : l'ARP ne s'AJOUTE pas aux
 * sondes IP, il les REMPLACE. `arpping()` lui-meme confie le travail a
 * `ultra_scan(targets, NULL, PING_SCAN_ARP)` en IPv4 et a `PING_SCAN_ND`
 * en IPv6. `portreasons.cc:134` nomme les deux raisons — `arp-response`
 * et `nd-response`. `output.cc:1632` ecrit la ligne
 * `MAC Address: %02X:...:%02X (%s)`, et `nmap.cc:2339` la place APRES la
 * table des ports et AVANT `printosscanoutput`.
 *
 * Le point que le manuel tranche, et qui n'est pas devinable : cela vaut
 * MEME sous `-Pn`. « Nmap normally does ARP or IPv6 Neighbor Discovery
 * (ND) discovery of locally connected ethernet hosts, even if other host
 * discovery options such as -Pn or -PE are used. To disable this implicit
 * behavior, use the --disable-arp-ping option. » Donc une adresse locale
 * que personne ne porte ressort `down` sous `-Pn`, et `--disable-arp-ping`
 * la rend `up` — ce qui n'est pas une incoherence mais la difference
 * entre « j'ai demande sur le fil » et « je n'ai rien demande ».
 *
 * Le constructeur est `Unknown` et c'est DEMONTRABLE plutot que par
 * defaut : `MACPrefix2Corp` ne cherche que dans le fichier de prefixes
 * enregistres a l'IEEE, et toutes les adresses de ce simulateur portent
 * le bit local (`02:00:00:…`, RFC 7042 §2.1), donc aucune n'y figure ni
 * n'y figurera.
 *
 * Ce que la sonde a APPRIS, et qui a change le correctif : une premiere
 * version LISAIT le cache ARP apres avoir laisse `resolveArpSync` decider
 * s'il fallait demander. Deux cas l'ont refusee ensemble — la requete ne
 * partait plus sur le fil des que le cache etait chaud (l'attribution
 * d'adresse le remplit), et surtout un hote ETEINT du meme segment
 * ressortait `up`, le cache repondant pour une machine qui n'est plus la.
 * C'est le faux positif qu'un scanner ne doit jamais rendre. La requete
 * part donc TOUJOURS et c'est la REPONSE qui est lue, ce que fait un vrai
 * `nmap`, qui construit son paquet ARP et ne consulte aucun cache.
 *
 * Discrimination : 9 cas tombent avant correctif, mesures en retirant
 * ENSEMBLE les sept fichiers touches. Les 5 qui passent des deux cotes
 * sont nommes plutot que laisses a decouvrir : les deux TEMOINS ordinaires
 * (le balayage qui trouve le port ouvert, l'hote derriere un routeur — ce
 * dernier n'ayant jamais eu de ligne MAC puisqu'aucune n'existait) ; le
 * TEMOIN de l'hote eteint, qui etait deja `down` par le silence de l'ICMP
 * et du TCP, et dont tout l'interet est d'etre reste `down` APRES ; et les
 * deux cas de `--disable-arp-ping`, que l'analyseur ignorait, si bien que
 * leur resultat etait le bon pour la mauvaise raison — ils gardent
 * desormais l'option elle-meme.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
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

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
    'ip -6 addr add 2001:db8::1/64 dev eth0');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0',
    'ip -6 addr add 2001:db8::2/64 dev eth0');
  await taper(cible, 'sudo systemctl start ssh');

  return { sw, scanner, cible };
}

async function faireTaire(cible: Cmd) {
  await taper(cible,
    'sudo iptables -A INPUT -p icmp -j DROP',
    'sudo iptables -A INPUT -p tcp -j DROP');
}

describe('la decouverte d un hote LOCAL passe par le lien', () => {
  it('un hote qui jette ICMP et filtre tout le TCP est quand meme `up`', async () => {
    const { scanner, cible } = await segment();
    await faireTaire(cible);

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toMatch(/Host is up/);
    expect(sortie).not.toMatch(/Host seems down/);
  });

  it('la RAISON de la decouverte est la reponse ARP', async () => {
    const { scanner, cible } = await segment();
    await faireTaire(cible);

    const sortie = await taper(scanner, 'nmap -sn --reason 10.0.0.2');

    expect(sortie).toContain('arp-response');
  });

  it('la ligne MAC Address porte l adresse REELLE de la cible', async () => {
    const { scanner, cible } = await segment();
    const attendue = (cible as unknown as { getPort(n: string): { getMAC(): MACAddress } })
      .getPort('eth0').getMAC().toString().toUpperCase();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain(`MAC Address: ${attendue} (Unknown)`);
  });

  it('la ligne MAC vient APRES la table des ports', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    const table = sortie.indexOf('22/tcp');
    const mac = sortie.indexOf('MAC Address:');
    expect(table).toBeGreaterThan(-1);
    expect(mac).toBeGreaterThan(table);
  });

  it('la requete ARP part vraiment sur le fil', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'sudo tcpdump -i eth0 -w /tmp/arp.pcap &');

    await taper(scanner, 'nmap -sn 10.0.0.2');

    const vu = await taper(scanner, 'sudo tcpdump -r /tmp/arp.pcap -nn');
    expect(vu).toMatch(/ARP, Request who-has 10\.0\.0\.2 tell 10\.0\.0\.1/);
  });

  it('aucun echo ICMP n est emis quand l ARP a repondu', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/noicmp.pcap &');

    await taper(scanner, 'nmap -sn 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/noicmp.pcap -nn');
    expect(vu).not.toMatch(/ICMP echo request/);
  });
});

describe('l ARP se fait MEME sous -Pn', () => {
  it('une adresse locale que personne ne porte ressort `down`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -p 22 10.0.0.77');

    expect(sortie).toMatch(/Host seems down/);
  });

  it('`--disable-arp-ping` rend a `-Pn` son sens litteral', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --disable-arp-ping -p 22 10.0.0.77');

    expect(sortie).toMatch(/Host is up/);
  });

  it('`--disable-arp-ping` supprime aussi la ligne MAC Address', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --disable-arp-ping -p 22 10.0.0.2');

    expect(sortie).not.toContain('MAC Address:');
  });
});

describe('IPv6 : la decouverte de voisin remplace l ARP', () => {
  it('la raison rendue est `nd-response`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -6 -sn --reason 2001:db8::2');

    expect(sortie).toContain('nd-response');
  });
});

describe('une seule mise en oeuvre, deux plateformes', () => {
  it('Windows decouvre son voisin par ARP lui aussi', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    const scanner = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
    new Cable('c1').connect(scanner.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(cible.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    scanner.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    scanner.powerOn(); cible.powerOn();
    await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
    await faireTaire(cible);

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toMatch(/Host is up/);
    expect(sortie).toContain('MAC Address:');
  });
});

describe('les temoins', () => {
  it('TEMOIN: un hote DERRIERE un routeur n a pas de ligne MAC Address', async () => {
    const routeur = new CiscoRouter('R1', 100, 0);
    const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
    const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
    routeur.powerOn(); scanner.powerOn(); cible.powerOn();
    new Cable('c1').connect(scanner.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
    new Cable('c2').connect(cible.getPort('eth0')!, routeur.getPort('GigabitEthernet0/1')!);
    await taper(routeur, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.254 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.1.254 255.255.255.0', 'no shutdown', 'exit',
      'end');
    await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
      'ip route add default via 10.0.0.254');
    await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.1.1/24 dev eth0',
      'ip route add default via 10.0.1.254');
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -p 22 10.0.1.1');

    expect(sortie).toMatch(/Host is up/);
    expect(sortie).not.toContain('MAC Address:');
  });

  it('TEMOIN: le balayage ordinaire trouve toujours le port ouvert', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('TEMOIN: un hote ETEINT du meme segment reste `down`', async () => {
    const { scanner, cible } = await segment();
    (cible as unknown as { powerOff(): void }).powerOff();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toMatch(/Host seems down/);
  });
});
