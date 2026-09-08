/**
 * `logger` tronque a la taille que `--size` fixe, pas a une autre.
 *
 * Ecrit A L'AVEUGLE. Trouve en balayant les rouges de la base : le cas
 * « automated truncation (snaplen) » de `journalization.test.ts` etait
 * rouge AVANT ce lot comme apres, et sa premisse est juste — le
 * simulateur ne tronquait pas au bon endroit.
 *
 * ```
 * logger "<4000 x>"    →  /var/log/syslog garde 2048 caracteres
 * logger -S 200 "..."  →  -S inconnu, avale comme un morceau du message
 * ```
 *
 * Le 2048 etait une invention : `logger(1)` limite le message a 1 KiO
 * par defaut, et `-S`/`--size` change cette limite. Un journal qui garde
 * deux fois trop laisse croire qu'un message long passe entier, alors
 * que sur une vraie machine il est coupe — c'est precisement ce qu'un
 * laboratoire de journalisation cherche a montrer.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Transcrit capture sur la machine reelle qui execute ce depot
 * (`util-linux`), qui prime sur la page de manuel — celle-ci annonce une
 * limite « en-tete comprise », ce que le binaire ne fait pas :
 *
 * ```
 * $ logger --no-act --stderr --rfc3164 -t probe "<4000 x>"
 *   une ligne de 1054 = 30 d'en-tete + 1024 de message
 * $ ... -S 200 "<4000 x>"          230 = 30 + 200
 * $ ... -S 2048 "<4000 x>"         2078 = 30 + 2048
 * $ ... -f <fichier de 3000>       1054, 1054, 982  → le fichier est
 *                                  DECOUPE en messages, pas tronque
 * $ ... -S abc "hi"
 *   logger: failed to parse message size: 'abc': Invalid argument
 * ```
 *
 * La distinction argument/fichier est mesuree, pas supposee : un message
 * passe en argument est COUPE et le reste jete ; un fichier est DECOUPE
 * en messages successifs.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 5 cas sur 7 tombent contre l'etat d'avant. Les DEUX autres
 * sont les TEMOINS, et c'est leur role : le message court, qui traverse
 * intact et doit continuer ; et le refus d'une priorite inconnue, qui
 * prouve qu'en ajoutant `-S` a l'analyse des options on n'a pas casse
 * celle qui existait.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

/**
 * Les longueurs des suites de `lettre` que le journal a retenues. Seules
 * les suites d'au moins dix comptent : les autres lignes du journal en
 * contiennent isolement.
 */
async function longueursRetenues(pc: Cmd, lettre: string): Promise<number[]> {
  const syslog = await pc.executeCommand('cat /var/log/syslog');
  return (syslog.match(new RegExp(`${lettre}{10,}`, 'g')) ?? []).map((s) => s.length);
}

describe('la limite par defaut est celle de logger(1)', () => {
  it('un message de 4000 caracteres est coupe a 1024', async () => {
    const pc = poste();

    await pc.executeCommand(`logger "${'x'.repeat(4000)}"`);

    expect(await longueursRetenues(pc, 'x')).toEqual([1024]);
  });

  it('--size la deplace', async () => {
    const pc = poste();

    await pc.executeCommand(`logger -S 200 "${'x'.repeat(4000)}"`);

    expect(await longueursRetenues(pc, 'x')).toEqual([200]);
  });

  it('la forme longue aussi', async () => {
    const pc = poste();

    await pc.executeCommand(`logger --size 2048 "${'x'.repeat(4000)}"`);

    expect(await longueursRetenues(pc, 'x')).toEqual([2048]);
  });

  it('une taille qui n est pas un nombre est REFUSEE', async () => {
    const pc = poste();

    expect(await pc.executeCommand('logger -S abc "hi"'))
      .toContain("logger: failed to parse message size: 'abc': Invalid argument");
  });
});

describe('un fichier est DECOUPE, un argument est COUPE', () => {
  it('trois messages pour trois mille caracteres', async () => {
    const pc = poste();
    await pc.executeCommand(`printf 'y%.0s' $(seq 1 3000) > /tmp/gros.txt`);

    await pc.executeCommand('logger -f /tmp/gros.txt');

    expect(await longueursRetenues(pc, 'y')).toEqual([1024, 1024, 952]);
  });
});

describe('TEMOINS', () => {
  it('un message court traverse intact', async () => {
    const pc = poste();

    await pc.executeCommand('logger "disque presque plein"');

    expect(await pc.executeCommand('cat /var/log/syslog')).toContain('disque presque plein');
  });

  it('une priorite inconnue reste refusee', async () => {
    const pc = poste();

    expect(await pc.executeCommand('logger -p invalid_fac.err "alerte"'))
      .toContain('unknown priority name');
  });
});
