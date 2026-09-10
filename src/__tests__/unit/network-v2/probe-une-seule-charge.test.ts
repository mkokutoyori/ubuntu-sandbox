/**
 * Une machine a UNE charge, et `/proc` la porte.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire :
 *
 * ```
 * uptime               load average: 0.00, 0.01, 0.05
 * top -b -n 1          load average: 0.00, 0.00, 0.00
 * cat /proc/loadavg    No such file or directory
 * cat /proc/stat       No such file or directory
 * cat /proc/self/status  No such file or directory   (alors que
 *                        /proc/self -> 39 et /proc/39/status existe)
 * ```
 *
 * Trois defauts d'un coup.
 *
 * (1) `uptime` et `top` annoncent DEUX charges differentes pour la meme
 * machine au meme instant. Le `0.00, 0.01, 0.05` d'`uptime` est une
 * decoration ecrite en dur : rien ne brule de CPU dans ce simulateur, et
 * une machine oisive porte 0.00 0.00 0.00 — ce que `top` dit deja, et ce
 * que confirment son `%Cpu(s): 100.0 id` et le `id 100` de `vmstat`.
 *
 * (2) `/proc/loadavg` et `/proc/stat` n'existent pas, alors que ce sont
 * les fichiers d'ou `uptime`, `top` et `vmstat` TIRENT ces chiffres. Les
 * champs qui les composent sont pourtant connus : la table des processus
 * sait combien tournent, combien il y en a, et quel PID a ete alloue en
 * dernier.
 *
 * (3) `/proc/self` est un lien vers le PID du shell, mais
 * `/proc/self/status` ne resout pas quand `/proc/39/status` resout. Un
 * lien qui ne mene nulle part : c'est pourtant par `/proc/self` qu'un
 * script lit son propre processus.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Formats releves sur la machine reelle qui execute ce depot :
 *
 * ```
 * /proc/loadavg   0.48 0.24 0.10 1/106 1729
 * /proc/stat      cpu  109342 0 27569 477357 5395 0 2277 78 0 0
 *                 cpu0 ...
 *                 ctxt / btime / processes / procs_running / procs_blocked
 * ```
 *
 * ── La cause de (3), trouvee en cherchant ailleurs ─────────────────
 *
 * `/proc/self` EXISTE et pointe bien vers `39` ; c'est la RESOLUTION du
 * VFS qui etait fausse. La cible relative d'un lien intermediaire etait
 * lue depuis le lien lui-meme au lieu du repertoire qui le contient :
 * `/proc/self/status` cherchait `/proc/self/39/status`. Aucun chemin
 * traversant un lien relatif ne resolvait, `/proc/self` n'etant que le
 * cas qu'on remarque.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 9 cas sur 12 tombent contre l'etat d'avant. Les TROIS
 * autres sont les TEMOINS, et c'est leur role : `/proc/1/status` et
 * `/proc/uptime`, les deux entrees de `/proc` qui repondaient deja et
 * qui prouvent que la correction de resolution n'a pas casse les
 * chemins directs ; et l'accord `free` / `/proc/meminfo`, la projection
 * voisine dont `/proc/loadavg` et `/proc/stat` copient le mecanisme.
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

function chargeDe(sortie: string): string {
  return /load average: ([\d., ]+)/.exec(sortie)?.[1].trim() ?? '<absente>';
}

function champProc(sortie: string, nom: string): string {
  return new RegExp(`^${nom}\\s+(.*)$`, 'm').exec(sortie)?.[1].trim() ?? '<absent>';
}

describe('la charge est la meme partout', () => {
  it('uptime et top annoncent la meme', async () => {
    const pc = poste();

    const parUptime = chargeDe(await pc.executeCommand('uptime'));
    const parTop = chargeDe(await pc.executeCommand('top -b -n 1'));

    expect(parUptime).toBe(parTop);
  });

  it('et c est celle que /proc/loadavg porte', async () => {
    const pc = poste();

    const loadavg = (await pc.executeCommand('cat /proc/loadavg')).trim().split(/\s+/);

    expect(loadavg.slice(0, 3).join(', ')).toBe(chargeDe(await pc.executeCommand('uptime')));
  });

  it('une machine oisive porte zero, pas une decoration', async () => {
    const pc = poste();

    expect(chargeDe(await pc.executeCommand('uptime'))).toBe('0.00, 0.00, 0.00');
  });

  it('/proc/loadavg compte les processus que ps compte', async () => {
    const pc = poste();

    const champs = (await pc.executeCommand('cat /proc/loadavg')).trim().split(/\s+/);
    const [enCours, total] = champs[3].split('/').map(Number);
    // `ps -e` se compte lui-meme, `cat` aussi : les deux instants
    // different d'un processus transitoire, jamais plus.
    const lignes = (await pc.executeCommand('ps -e')).trim().split('\n').length - 1;

    expect(champs).toHaveLength(5);
    expect(enCours).toBeGreaterThanOrEqual(1);
    expect(Math.abs(total - lignes)).toBeLessThanOrEqual(1);
    expect(Number(champs[4])).toBeGreaterThan(0);
  });
});

describe('/proc/stat decrit une machine qui n a rien brule', () => {
  it('sa ligne cpu porte les dix compteurs du noyau', async () => {
    const pc = poste();

    const cpu = champProc(await pc.executeCommand('cat /proc/stat'), 'cpu').split(/\s+/);

    expect(cpu).toHaveLength(10);
    expect(Number(cpu[0])).toBe(0);
    expect(Number(cpu[2])).toBe(0);
  });

  it('il y a une ligne par processeur', async () => {
    const pc = poste();

    const stat = await pc.executeCommand('cat /proc/stat');
    const coeurs = Number((await pc.executeCommand('nproc')).trim());

    for (let i = 0; i < coeurs; i++) expect(stat).toMatch(new RegExp(`^cpu${i} `, 'm'));
  });

  it('ses compteurs de processus sont ceux de la table', async () => {
    const pc = poste();

    const stat = await pc.executeCommand('cat /proc/stat');
    const lignes = (await pc.executeCommand('ps -e')).trim().split('\n').length - 1;

    expect(Number(champProc(stat, 'procs_running'))).toBeGreaterThanOrEqual(1);
    expect(Number(champProc(stat, 'procs_blocked'))).toBe(0);
    expect(Number(champProc(stat, 'processes'))).toBeGreaterThanOrEqual(lignes - 1);
    expect(Number(champProc(stat, 'btime'))).toBeGreaterThan(0);
  });
});

describe('/proc/self mene au processus courant', () => {
  it('son status est celui du shell', async () => {
    const pc = poste();

    const parSelf = await pc.executeCommand('cat /proc/self/status');

    expect(parSelf).toMatch(/^Name:\t-bash$/m);
  });

  it('il dit la meme chose que /proc/$$/status', async () => {
    const pc = poste();

    const parSelf = await pc.executeCommand('cat /proc/self/status');
    const parPid = await pc.executeCommand('cat /proc/$$/status');

    expect(parSelf).toBe(parPid);
  });
});

describe('TEMOINS', () => {
  it('/proc/1/status nomme toujours systemd', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /proc/1/status')).toMatch(/^Name:\tsystemd$/m);
  });

  it('/proc/uptime repond toujours deux nombres', async () => {
    const pc = poste();

    expect((await pc.executeCommand('cat /proc/uptime')).trim()).toMatch(/^[\d.]+ [\d.]+$/);
  });

  it('free et /proc/meminfo s accordent encore', async () => {
    const pc = poste();

    const total = champProc(await pc.executeCommand('cat /proc/meminfo'), 'MemTotal:').split(/\s+/)[0];
    const parFree = (await pc.executeCommand('free -k')).split('\n')[1].trim().split(/\s+/)[1];

    expect(parFree).toBe(total);
  });
});
