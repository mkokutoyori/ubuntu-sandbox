/**
 * `nice` abaisse la commande, pas le shell qui la lance.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire :
 *
 * ```
 * $ nice                              0
 * $ nice -n 5 sleep 0
 * $ nice                              5      <-- le shell a change
 * $ ps -eo pid,ni,comm | grep bash    39  5 -bash
 * ```
 *
 * Une seule commande niceee a DEGRADE le shell, definitivement : tout ce
 * que l'operateur tape ensuite tourne a la priorite reduite, et rien ne
 * le lui dit. Le commentaire du code expliquait que « nice(1) fait
 * setpriority() sur lui-meme puis execve() » — c'est vrai, mais `nice`
 * est un ENFANT du shell : ce qu'il abaisse meurt avec la commande.
 * L'implementation appliquait l'abaissement a `currentPid ?? shellPid`,
 * donc au shell des qu'aucun enfant n'etait en cours.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Transcrit capture sur la machine reelle qui execute ce depot
 * (`coreutils 9.4`), ce qui prime sur toute documentation :
 *
 * ```
 * $ nice -n 5 sleep 0 ; nice          0        le shell ne bouge pas
 * $ nice -n 5 nice                    5        l'enfant, lui, est abaisse
 * $ nice nice                         10       l'ajustement par defaut
 * $ nice -n 3 nice -n 4 nice          7        les ajustements S'AJOUTENT
 * $ nice -n 5                         rc=125   « a command must be given »
 * $ nice -n abc true                  rc=125   « invalid adjustment 'abc' »
 * ```
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 6 cas sur 10 tombent contre l'etat d'avant. Les QUATRE
 * autres, et pourquoi :
 *
 *  - « nice -n 5 nice rend 5 » et « sans -n, l'ajustement vaut dix » —
 *    JUSTES POUR LA MAUVAISE RAISON avant le correctif. L'ancien code
 *    abaissait le SHELL puis le relisait, ce qui donnait par accident le
 *    bon chiffre ; c'est le cas voisin en cascade (3 puis 4 doivent
 *    donner 7) qui montre que le mecanisme etait faux. Ils restent, et
 *    passent desormais parce que l'enfant porte vraiment sa priorite.
 *  - les deux cas `renice` — TEMOINS. `renice` ecrit sur un processus
 *    DESIGNE, et doit continuer de le faire ; il prouve qu'en cessant
 *    d'ecrire sur le shell depuis `nice` on n'a pas rendu la commande
 *    voisine inoperante, ni leve son refus sur le PID 1.
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

/** La colonne NI de la ligne `-bash` de `ps`. */
async function niceDuShell(pc: Cmd): Promise<string> {
  const sortie = await pc.executeCommand('ps -eo pid,ni,comm');
  return sortie.split('\n').find((l) => l.includes('-bash'))?.trim().split(/\s+/)[1] ?? '<absent>';
}

describe('le shell garde sa priorite', () => {
  it('nice sans argument rend zero avant comme apres', async () => {
    const pc = poste();

    expect((await pc.executeCommand('nice')).trim()).toBe('0');
    await pc.executeCommand('nice -n 5 sleep 0');

    expect((await pc.executeCommand('nice')).trim()).toBe('0');
  });

  it('ps ne voit pas le shell degrade', async () => {
    const pc = poste();

    await pc.executeCommand('nice -n 5 sleep 0');

    expect(await niceDuShell(pc)).toBe('0');
  });

  it('deux commandes niceees ne s accumulent pas sur le shell', async () => {
    const pc = poste();

    await pc.executeCommand('nice -n 5 true');
    await pc.executeCommand('nice -n 7 true');

    expect((await pc.executeCommand('nice')).trim()).toBe('0');
  });
});

describe('la commande lancee, elle, est bien abaissee', () => {
  it('nice -n 5 nice rend 5', async () => {
    const pc = poste();

    expect((await pc.executeCommand('nice -n 5 nice')).trim()).toBe('5');
  });

  it('sans -n, l ajustement vaut dix', async () => {
    const pc = poste();

    expect((await pc.executeCommand('nice nice')).trim()).toBe('10');
  });

  it('les ajustements S AJOUTENT en cascade', async () => {
    const pc = poste();

    expect((await pc.executeCommand('nice -n 3 nice -n 4 nice')).trim()).toBe('7');
  });

  it('un processus lance en arriere-plan herite de la priorite', async () => {
    const pc = poste();

    await pc.executeCommand('nice -n 12 sleep 300 &');
    const ligne = (await pc.executeCommand('ps -eo pid,ni,comm'))
      .split('\n').find((l) => l.includes('sleep')) ?? '';

    expect(ligne.trim().split(/\s+/)[1]).toBe('12');
  });
});

describe('les deux refus de nice', () => {
  it('un ajustement sans commande est REFUSE', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('nice -n 5; echo rc=$?');

    expect(sortie).toContain('nice: a command must be given with an adjustment');
    expect(sortie).toContain("Try 'nice --help' for more information.");
    expect(sortie).toContain('rc=125');
  });

  it('un ajustement qui n est pas un nombre est REFUSE', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('nice -n abc true; echo rc=$?');

    expect(sortie).toContain("nice: invalid adjustment 'abc'");
    expect(sortie).toContain('rc=125');
  });
});

describe('TEMOIN', () => {
  it('renice ecrit toujours sur le processus qu on lui designe', async () => {
    const pc = poste();
    const shellPid = (await pc.executeCommand('ps -eo pid,ni,comm'))
      .split('\n').find((l) => l.includes('-bash'))?.trim().split(/\s+/)[0] ?? '0';

    await pc.executeCommand(`sudo renice -n 4 -p ${shellPid}`);

    expect(await niceDuShell(pc)).toBe('4');
  });

  it('renice sur le PID 1 reste refuse a un simple utilisateur', async () => {
    const pc = poste();

    expect(await pc.executeCommand('renice -n 3 -p 1')).toContain('Permission denied');
  });
});
