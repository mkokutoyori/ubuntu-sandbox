/**
 * Sonde — `ps` est le portage de procps-ng 4.0.4 (Ubuntu 24.04), pas une table maison.
 *
 * Mesure d'origine (corpus ps-procps-4.0.4.json, 5 labos et plus de 600 pas, enregistrés sur le vrai `ps` dans un espace de noms de pids
 * jetable puis rejoués par netcmds-oracle.test.ts) : l'ancien `ps` classait les options à la main, ne connaissait pas le repli BSD, les trois
 * syntaxes d'options, `--sort`, `--forest`, `-L`/`-T`, les formats `-o` à largeur propre, ni le message `error: ... Usage:` du vrai, et sa
 * colonne CMD donnait `-bash` là où le noyau donne `bash` (comm) et `ps -o args` `-bash`.
 *
 * Ces cas fixent les comportements qui se voient depuis un terminal, les valeurs exactes venant du corpus :
 *   ps -V                           ps from procps-ng 4.0.4
 *   ps -V -e                        « error: the option is exclusive: -V » puis le bloc Usage, rc 1
 *   ps -p abc / ps -p 0             « process ID list syntax error » / « process ID out of range », rc 1
 *   ps -C nosuch                    l'en-tête seul, rc 1
 *   ps / -o comm= / -o args=        CMD = bash (comm) ; args du shell de connexion = -bash
 *   ps aux                          tronqué à la largeur du terminal (80) ; ps auxww et un tube : sans limite
 *   renice 5 puis -o ni=,pri=       5 et 14 (pri = 39 - (20 + ni))
 *   ps --sort=-pid -o pid=          du plus grand pid au plus petit
 *
 * Discrimination `git stash` : 10 cas tombent avant le correctif — l'en-tête et les deux lignes du listing par défaut, `-V`, `-V -e`,
 * `-p abc`, `-p 0`, `-C nosuch`, comm / args du shell de connexion, la troncature de `ps aux` à 80 colonnes, `pri` après renice.
 *
 * Passent des deux côtés, et pourquoi :
 *  - « TEMOIN: ps lists the shell and itself » — prouve que la machine est saine.
 *  - « sorts with --sort », « selects by user with -u » et « draws the process tree with --forest » — NON-RÉGRESSION : l'ancien `ps` les
 *    connaissait déjà ; le portage les garde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function machine(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

const USAGE = "\n\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).";

describe('Probe — ps as procps-ng 4.0.4', () => {
  it('TEMOIN: ps lists the shell and itself', async () => {
    const listing = await machine().executeCommand('ps');
    expect(listing).toMatch(/bash/);
    expect(listing).toMatch(/\bps$/m);
  });

  it('the header of the default listing', async () => {
    expect((await machine().executeCommand('ps')).split('\n')[0]).toBe('    PID TTY          TIME CMD');
  });

  it('the default listing is the shell then ps, on its tty, with the time as hh:mm:ss', async () => {
    const rows = (await machine().executeCommand('ps')).split('\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\s*\d+ pts\/\d+\s+00:00:00 bash$/);
    expect(rows[1]).toMatch(/^\s*\d+ pts\/\d+\s+00:00:00 ps$/);
  });

  it('prints its version', async () => {
    expect(await machine().executeCommand('ps -V')).toBe('ps from procps-ng 4.0.4');
  });

  it('refuses -V with another option, with the usage block and rc 1', async () => {
    expect(await machine().executeCommand('ps -V -e; echo rc=$?')).toBe(`error: the option is exclusive: -V${USAGE}\nrc=1`);
  });

  it('refuses a process list that is not a list of numbers', async () => {
    expect(await machine().executeCommand('ps -p abc; echo rc=$?')).toBe(`error: process ID list syntax error${USAGE}\nrc=1`);
  });

  it('refuses process ID 0', async () => {
    expect(await machine().executeCommand('ps -p 0; echo rc=$?')).toBe(`error: process ID out of range${USAGE}\nrc=1`);
  });

  it('prints only the header and exits with 1 when -C matches nothing', async () => {
    expect(await machine().executeCommand('ps -C nosuch; echo rc=$?')).toBe('    PID TTY          TIME CMD\nrc=1');
  });

  it('gives the kernel name of the login shell in comm and the dashed name in args', async () => {
    const pc = machine();
    expect(await pc.executeCommand('ps -o comm= -p $$')).toBe('bash');
    expect(await pc.executeCommand('ps -o args= -p $$')).toBe('-bash');
  });

  it('truncates ps aux to the terminal width, but not ps auxww nor a pipe', async () => {
    const pc = machine();
    await pc.executeCommand('sleep 99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999 &');
    const longest = async (command: string): Promise<number> => Number(await pc.executeCommand(`${command} | awk '{ if (length($0) > m) m = length($0) } END { print m }'`));
    expect(await longest('ps aux')).toBeGreaterThan(80);
    const direct = (await pc.executeCommand('ps aux')).split('\n').reduce((widest, row) => Math.max(widest, row.length), 0);
    expect(direct).toBeLessThanOrEqual(80);
    expect((await pc.executeCommand('ps auxww')).split('\n').reduce((widest, row) => Math.max(widest, row.length), 0)).toBeGreaterThan(80);
  });

  it('reports nice and pri consistently after renice', async () => {
    const pc = machine();
    await pc.executeCommand('sleep 300 &');
    await pc.executeCommand('renice -n 5 -p $! > /dev/null');
    expect(await pc.executeCommand('ps -o ni=,pri= -p $!')).toMatch(/^\s*5\s+14$/);
  });

  it('sorts with --sort', async () => {
    const pids = (await machine().executeCommand('ps -e --sort=-pid -o pid=')).split('\n').map((row) => Number(row.trim()));
    expect(pids.length).toBeGreaterThan(5);
    expect(pids).toEqual([...pids].sort((a, b) => b - a));
  });

  it('selects by user with -u and shows the user column', async () => {
    const listing = await machine().executeCommand('ps -u root -o user=,comm= | head -n 3');
    expect(listing.split('\n').every((row) => row.startsWith('root'))).toBe(true);
  });

  it('draws the process tree with --forest', async () => {
    const tree = await machine().executeCommand('ps -e --forest -o pid=,args= | grep -c "\\\\_"');
    expect(Number(tree)).toBeGreaterThan(0);
  });
});
