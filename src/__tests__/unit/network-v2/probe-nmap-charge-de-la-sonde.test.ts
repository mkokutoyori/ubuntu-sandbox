/**
 * Une sonde peut porter une CHARGE, et la charge est sur le fil.
 *
 * Ecrit A L'AVEUGLE. Les trois options de charge (`--data`,
 * `--data-string`, `--data-length`) etaient refusees comme non
 * implantees. Elles n'ont d'interet que si les octets partent pour de
 * bon : une charge qui ne quitterait pas la machine ne traverserait
 * aucun filtre, ne ferait grossir aucun paquet et n'apprendrait rien.
 * L'observable est donc la CAPTURE sur la cible, pas le rapport.
 *
 * ── Les trois options ───────────────────────────────────────────────
 *
 * `nmap.cc:821` `--data <hex>` : `utils.cc:430` accepte `0xAABB`,
 * `\xAA\xBB` ou `AABB` nu, exige des chiffres hexadecimaux en nombre
 * PAIR, et refuse le vide — sinon « Invalid hex string specified ».
 *
 * `nmap.cc:836` `--data-string <texte>` : les octets du texte, tels
 * quels.
 *
 * `nmap.cc:846` `--data-length <n>` : n octets ALEATOIRES. La borne est
 * `MAX_PAYLOAD_ALLOWED` (`nmap.h:254` = 65535-60-40 = 65435), et
 * au-dela de 1400 un avertissement — pas un refus — annonce que le
 * paquet peut ne pas passer.
 *
 * Les trois posent `raw_scan_options`, donc un balayage CONNECTE les
 * accepte, avertit et ne les honore pas ; et elles s'excluent l'une
 * l'autre : « Can't use the --data option(s) multiple times, or
 * together. »
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : tous les cas tombent contre l'etat d'avant, ou les trois
 * options sont refusees avant tout balayage. Le TEMOIN — le balayage
 * sans charge, dont la capture montre `length 0` — doit passer des deux
 * cotes.
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

/** La capture de la CIBLE pendant un balayage, plus le rapport rendu. */
async function captureDuBalayage(
  commande: string, options: { filtre?: string; lecture?: string } = {},
): Promise<{ capture: string; rapport: string }> {
  const { scanner, cible } = await segment();
  const filtre = options.filtre ?? 'tcp port 22';
  await taper(cible, `tcpdump -nn -i eth0 ${filtre} -w charge.pcap &`);
  const rapport = await taper(scanner, commande);
  const capture = await taper(cible,
    `tcpdump -r charge.pcap -nn ${options.lecture ?? ''}`);
  return { capture, rapport };
}

/** La longueur que tcpdump annonce sur la sonde ALLER. */
function longueurDeLaSonde(capture: string): number {
  const m = /10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[S\][^\n]*length (\d+)/
    .exec(capture);
  return m === null ? -1 : Number(m[1]);
}

describe('--data-length pose des octets aleatoires', () => {
  it('la sonde grossit de ce qu on lui demande', async () => {
    const { capture, rapport } = await captureDuBalayage(
      'nmap -Pn -sS --data-length 25 -p 22 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(longueurDeLaSonde(capture)).toBe(25);
  });

  it('une longueur hors bornes est un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --data-length 70000 -p 22 10.0.0.2');

    expect(sortie).toContain('data-length must be between 0 and 65435');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('au-dela de 1400 c est un avertissement, pas un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --data-length 1500 -p 22 10.0.0.2');

    expect(sortie).toContain(
      'WARNING: Payloads bigger than 1400 bytes may not be sent successfully.');
    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });
});

describe('--data-string pose le texte tel quel', () => {
  it('les octets du texte se retrouvent dans la capture', async () => {
    const { capture, rapport } = await captureDuBalayage(
      'nmap -Pn -sS --data-string SALUTLABO -p 22 10.0.0.2', { lecture: '-A' });

    expect(rapport).not.toContain('not implemented');
    expect(capture).toContain('SALUTLABO');
  });

  it('la longueur est celle du texte', async () => {
    const { capture } = await captureDuBalayage(
      'nmap -Pn -sS --data-string SALUTLABO -p 22 10.0.0.2');

    expect(longueurDeLaSonde(capture)).toBe(9);
  });
});

describe('--data pose des octets donnes en hexadecimal', () => {
  it('les trois ecritures du meme nombre donnent la meme charge', async () => {
    for (const spec of ['0xDEADBEEF', 'DEADBEEF', '\\xDE\\xAD\\xBE\\xEF']) {
      const { capture } = await captureDuBalayage(
        `nmap -Pn -sS --data ${spec} -p 22 10.0.0.2`);
      expect(longueurDeLaSonde(capture)).toBe(4);
    }
  });

  it('un nombre impair de chiffres est un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --data 0xABC -p 22 10.0.0.2');

    expect(sortie).toContain('Invalid hex string specified');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('un caractere qui n est pas hexadecimal est un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --data zorglub -p 22 10.0.0.2');

    expect(sortie).toContain('Invalid hex string specified');
  });
});

describe('les trois options ne se cumulent pas', () => {
  it('deux options de charge sont un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --data-length 10 --data-string SALUT -p 22 10.0.0.2');

    expect(sortie).toContain(
      "Can't use the --data option(s) multiple times, or together.");
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('la meme option deux fois aussi', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --data-length 10 --data-length 20 -p 22 10.0.0.2');

    expect(sortie).toContain(
      "Can't use the --data option(s) multiple times, or together.");
  });
});

describe('un balayage UDP porte la meme charge', () => {
  it('le datagramme grossit du texte donne', async () => {
    const { capture, rapport } = await captureDuBalayage(
      'nmap -Pn -sU --data-string SALUTLABO -p 53 10.0.0.2',
      { filtre: 'udp port 53', lecture: '-A' });

    expect(rapport).not.toContain('not implemented');
    expect(capture).toContain('SALUTLABO');
  });
});

describe('un balayage CONNECTE avertit et n honore pas', () => {
  it('la charge ne part pas, et nmap le dit', async () => {
    const { capture, rapport } = await captureDuBalayage(
      'nmap -Pn -sT --data-string SALUTLABO -p 22 10.0.0.2');

    expect(rapport).toContain(
      'You have specified some options that require raw socket access.');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(capture).not.toContain('SALUTLABO');
  });
});

describe('TEMOIN', () => {
  it('sans option, la sonde ne porte rien', async () => {
    const { capture } = await captureDuBalayage('nmap -Pn -sS -p 22 10.0.0.2');

    expect(longueurDeLaSonde(capture)).toBe(0);
  });
});
