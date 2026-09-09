/**
 * Une machine a UN inventaire de processus, et ses vues le comptent
 * pareil.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un poste Linux neuf, puis la
 * MEME question a `top` et a `ps`.
 *
 * ```
 * top - 09:59:10 up 0 min,  1 user,  load average: 0.00, 0.00, 0.00
 * Tasks: 39 total,  0 running, 33 sleeping,  0 stopped,  0 zombie
 *     PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
 *       1 root       20    0    165M    12M     4M S   0.0   0.3   0:00.00 systemd
 *       2 root       20    0      0M     0M     4M S   0.0   0.0   0:00.00 [kthreadd]
 *
 * USER     PID   %CPU %MEM VSZ     RSS    TTY      STAT START    TIME     COMMAND
 * root         1  0.0  0.3  169000  13000 ?        S    09:59       00:00 /sbin/init
 * ```
 *
 * Trois defauts visibles d'un coup. `Tasks: 39 total` alors que
 * 0 + 33 + 0 + 0 = 33 : six taches manquent a l'appel, et la ligne se
 * contredit elle-meme. `VIRT`/`RES`/`SHR` sortent suffixees en `M` la
 * ou `top` compte en kibioctets, si bien qu'on ne peut plus les
 * rapprocher du `VSZ`/`RSS` de `ps` ; et un fil noyau, qui n'a NI
 * espace virtuel NI resident, se voit tout de meme attribuer `4M` de
 * memoire partagee. Enfin les colonnes de `ps aux` ne tombent pas sous
 * leur en-tete, et `TIME` s'ecrit `00:00` la ou `ps aux` ecrit `M:SS`.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * RELEVE sur le GNU/Linux qui execute ce depot, ce qui prime sur toute
 * documentation :
 *
 * ```
 * $ top -b -n 1 | head -8
 * Tasks:  81 total,   1 running,  79 sleeping,   0 stopped,   1 zombie
 *   PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
 *     1 root      20   0   26288   6312   3380 S   0.0   0.0   0:44.74 process_a+
 * $ ps aux | head -3
 * USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
 * root         1  0.0  0.0  26288  6312 ?        SLl  Sep08   0:44 /process_api …
 * root         2  0.0  0.0      0     0 ?        S    Sep08   0:00 [kthreadd]
 * $ ps -ef | head -2
 * UID        PID  PPID  C STIME TTY          TIME CMD
 * root         1     0  0 Sep08 ?        00:00:44 /process_api …
 * ```
 *
 * 1 + 79 + 0 + 1 = 81 : la ligne `Tasks` s'additionne exactement.
 * `VIRT`/`RES`/`SHR` valent 26288 / 6312 / 3380 — des KIBIOCTETS nus,
 * et ce sont les MEMES nombres que `VSZ`/`RSS` de `ps`. Un fil noyau
 * porte `0 0` partout. `ps aux` ecrit `TIME` en `M:SS` (`0:44`) et
 * `ps -ef` en `HH:MM:SS` (`00:00:44`).
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 7 cas sur 11 tombent contre l'etat d'avant. Les QUATRE
 * autres passent des deux cotes, et chacun a sa raison :
 *  - TEMOINS — « top rend la memoire que free compte » et « top rend la
 *    charge qu'uptime affiche » : deux vues deja d'accord, raccordees
 *    lors de correctifs precedents, qui prouvent que l'en-tete de `top`
 *    lit bien le modele de la machine et n'a pas ete deplace ;
 *  - DEJA JUSTE — « ps aux ecrit TIME en M:SS » : `00:00` satisfait
 *    `/^\d+:\d{2}$/` par accident, le zero de tete etant un chiffre
 *    comme un autre. Le cas est garde parce qu'il ne passe plus par
 *    accident : `ps aux` lit desormais la colonne `bsdtime`, distincte
 *    de `time`, et un processus d'une heure de calcul les separerait ;
 *  - DEJA JUSTE — « le processus initial porte l'etat que ps et top
 *    donnent tous deux » : `S` d'un cote, `S` de l'autre. Il devient
 *    discriminant des qu'un etat s'ecrit sur plusieurs lettres (`Ss`,
 *    `SLl`), puisque `top` n'en rend qu'une et `ps` la chaine entiere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Poste {
  return createDevice('linux-pc', 0, 0) as unknown as Poste;
}

async function top(pc: Poste): Promise<string> {
  return pc.executeCommand('top -b -n 1');
}

function colonnes(ligne: string): string[] {
  return ligne.trim().split(/\s+/);
}

/** La ligne de `top` decrivant le processus de PID donne. */
function ligneTop(sortie: string, pid: number): string[] {
  const at = sortie.split('\n').findIndex((l) => /^\s*PID\s+USER/.test(l));
  const ligne = sortie.split('\n').slice(at + 1)
    .find((l) => colonnes(l)[0] === String(pid)) ?? '';
  return colonnes(ligne);
}

/** La ligne de `ps aux` decrivant le processus de PID donne. */
function lignePs(sortie: string, pid: number): string[] {
  const ligne = sortie.split('\n').slice(1)
    .find((l) => colonnes(l)[1] === String(pid)) ?? '';
  return colonnes(ligne);
}

describe('top compte ses taches, et le compte se verifie', () => {
  it('la ligne Tasks s additionne', async () => {
    const pc = poste();

    const m = /Tasks:\s*(\d+) total,\s*(\d+) running,\s*(\d+) sleeping,\s*(\d+) stopped,\s*(\d+) zombie/
      .exec(await top(pc));
    const [total, running, sleeping, stopped, zombie] =
      (m ?? []).slice(1).map(Number);

    expect(total).toBeGreaterThan(10);
    expect(running + sleeping + stopped + zombie).toBe(total);
  });

  it('top compte autant de taches que ps en liste', async () => {
    const pc = poste();

    const total = Number(/Tasks:\s*(\d+) total/.exec(await top(pc))?.[1] ?? '0');
    const listees = (await pc.executeCommand('ps -e')).split('\n')
      .filter((l) => /^\s*\d+/.test(l)).length;

    expect(listees).toBe(total);
  });
});

describe('top et ps decrivent la meme memoire', () => {
  it('VIRT et RES de top sont les VSZ et RSS de ps', async () => {
    const pc = poste();

    const parTop = ligneTop(await top(pc), 1);
    const parPs = lignePs(await pc.executeCommand('ps aux'), 1);

    expect(parTop[4]).toBe(parPs[4]);
    expect(parTop[5]).toBe(parPs[5]);
  });

  it('les colonnes memoire de top sont des kibioctets nus', async () => {
    const pc = poste();

    const [, , , , virt, res, shr] = ligneTop(await top(pc), 1);

    for (const v of [virt, res, shr]) expect(v).toMatch(/^\d+$/);
    expect(Number(virt)).toBeGreaterThan(Number(res));
  });

  it('un fil noyau n occupe aucune memoire, pas meme partagee', async () => {
    const pc = poste();

    const parTop = ligneTop(await top(pc), 2);

    expect(parTop[11]).toContain('kthreadd');
    expect([parTop[4], parTop[5], parTop[6]]).toEqual(['0', '0', '0']);
  });
});

describe('ps ecrit ses colonnes comme le vrai', () => {
  it('ps aux aligne ses valeurs sous ses en-tetes', async () => {
    const pc = poste();

    const lignes = (await pc.executeCommand('ps aux')).split('\n');
    const finDeColonne = (l: string, nom: string) => l.indexOf(nom) + nom.length;

    for (const ligne of lignes.slice(1, 4)) {
      const pid = colonnes(ligne)[1];
      expect(ligne.indexOf(pid) + pid.length).toBe(finDeColonne(lignes[0], 'PID'));
    }
  });

  it('ps aux ecrit TIME en M:SS', async () => {
    const pc = poste();

    expect(lignePs(await pc.executeCommand('ps aux'), 1)[9]).toMatch(/^\d+:\d{2}$/);
  });

  it('ps -ef ecrit TIME en HH:MM:SS', async () => {
    const pc = poste();

    const ligne = (await pc.executeCommand('ps -ef')).split('\n')
      .find((l) => colonnes(l)[1] === '1') ?? '';

    expect(colonnes(ligne)[6]).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('le processus initial porte l etat que ps et top donnent tous deux', async () => {
    const pc = poste();

    const parPs = lignePs(await pc.executeCommand('ps aux'), 1)[7];
    const parTop = ligneTop(await top(pc), 1)[7];

    expect(parPs).toMatch(/^S/);
    expect(parPs.startsWith(parTop)).toBe(true);
  });
});

describe('TEMOINS', () => {
  it('top rend la memoire que free compte', async () => {
    const pc = poste();

    const parFree = /Mem:\s+(\d+)/.exec(await pc.executeCommand('free -m'))?.[1] ?? '<absent>';
    const parTop = /MiB Mem :\s*([\d.]+) total/.exec(await top(pc))?.[1] ?? '<absent>';

    expect(Number(parTop)).toBe(Number(parFree));
  });

  it('top rend la charge qu uptime affiche', async () => {
    const pc = poste();

    const parUptime = /load average: (.+)$/.exec((await pc.executeCommand('uptime')).trim())?.[1];
    const parTop = /load average: (.+)$/m.exec(await top(pc))?.[1]?.trim();

    expect(parTop).toBe(parUptime);
  });
});
