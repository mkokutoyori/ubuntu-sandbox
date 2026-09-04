/**
 * Une liste de controle qui REFUSE rend le port `filtered`, pas `closed`.
 *
 * Ecrit A L'AVEUGLE. Defaut mesure sur le TP 13 et inscrit au `TODO.md`
 * en attendant que le chantier `nmap`/ICMP libere les memes fichiers :
 * R1 porte `deny ip any any` en entree de Gi0/0, la sonde TCP vers 8080
 * ressort `8080/tcp closed`, et `Host is up` — donc la liste de controle
 * se lit comme un port ferme et non comme un filtre. Les deux ne se
 * diagnostiquent pas de la meme facon : « ferme » envoie demarrer un
 * service, « filtre » envoie lire une regle.
 *
 * La chaine ecrasait tout ICMP inatteignable en `refused`
 * (`TcpWireOutcome`), alors que le noyau distingue le code 3 (port
 * inatteignable, ECONNREFUSED) du code 13 (interdit par filtre, EACCES)
 * et que `scan_engine_connect.cc` en tire deux verdicts : `PORT_CLOSED`
 * pour le premier, `PORT_FILTERED` avec la raison `admin-prohibited`
 * pour le second. Le code 13 etait bien EMIS par `Router.sendICMPError` ;
 * c'est la traduction en issue de connexion qui le perdait.
 *
 * Discrimination : 2 cas tombent avant correctif. Les TEMOINS — un port
 * ferme ordinaire et un port ouvert — passent des deux cotes, et c'est
 * exactement leur role : le correctif ne doit pas transformer tout refus
 * en filtre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function maquette() {
  const routeur = new CiscoRouter('R1', 100, 0);
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
  routeur.powerOn(); scanner.powerOn(); cible.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(cible.getPort('eth0')!, routeur.getPort('GigabitEthernet0/1')!);

  await taper(routeur,
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.254 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.254 255.255.255.0', 'no shutdown', 'exit',
    'end');

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
    'ip route add default via 10.0.0.254');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.1.1/24 dev eth0',
    'ip route add default via 10.0.1.254');
  await taper(cible, 'sudo systemctl start ssh');

  return { routeur, scanner, cible };
}

async function refuserVers(routeur: Cmd, port: number) {
  await taper(routeur,
    'enable', 'configure terminal',
    `access-list 101 deny tcp any any eq ${port}`,
    'access-list 101 permit ip any any',
    'interface GigabitEthernet0/0', 'ip access-group 101 in', 'exit',
    'end');
}

describe('un refus de liste de controle est un FILTRE', () => {
  it('le port refuse est rendu `filtered`', async () => {
    const { routeur, scanner } = await maquette();
    await refuserVers(routeur, 22);

    const sortie = await taper(scanner, 'nmap -Pn -p 22 10.0.1.1');

    expect(sortie).toMatch(/22\/tcp\s+filtered/);
    expect(sortie).not.toMatch(/22\/tcp\s+closed/);
  });

  it('la RAISON rendue est celle du message ICMP recu', async () => {
    const { routeur, scanner } = await maquette();
    await refuserVers(routeur, 22);

    const sortie = await taper(scanner, 'nmap -Pn --reason -p 22 10.0.1.1');

    expect(sortie).toContain('admin-prohibited');
  });

  it('TEMOIN: un port sans service reste `closed`', async () => {
    const { scanner } = await maquette();

    const sortie = await taper(scanner, 'nmap -Pn -p 8888 10.0.1.1');

    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('TEMOIN: un port avec service reste `open`', async () => {
    const { scanner } = await maquette();

    const sortie = await taper(scanner, 'nmap -Pn -p 22 10.0.1.1');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });
});
