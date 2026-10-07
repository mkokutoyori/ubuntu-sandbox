/**
 * Avancer le temps de l'infrastructure AVANT d'y ajouter une machine : la machine ne portait pas
 * l'avance. L'epoque du planificateur virtuel n'etait fixee qu'a la premiere LECTURE de l'horloge
 * (`Date.now() - scheduler.now()`), et `schedulerWallClock` (l'horloge de chaque machine) lisait
 * `Date.now()` au lieu de cette epoque : une machine creee apres l'avance repartait de l'heure
 * reelle, alors que `simulationNowMs()` — et les machines deja la — avaient avance.
 *
 * MESURE : `SimulationClock` neuve, `advance(1 h)`, puis une machine ajoutee : `date +%s` en retard
 * d'une heure (3 600 367 ms d'ecart avec l'infrastructure), `Get-Date -UFormat %s` de meme, `show
 * clock` d'un routeur Cisco sur la mauvaise annee apres 400 jours.
 *
 * Corrige en fixant l'epoque a la construction de `SimulationClock` et en faisant lire
 * `virtualOriginOf` — l'unique source — aux deux lecteurs.
 *
 * Discriminee contre l'etat d'avant (`git stash` des deux sources) : 4 des 5 cas tombent. Le seul qui
 * passe des deux cotes est NOMME : le temoin « une machine ajoutee AVANT l'avance la suit », qui
 * prouve que le laboratoire mesure bien l'avance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { simulationNowMs } from '@/network/core/SystemClock';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const HOUR = 3_600_000;
const TOLERANCE_MS = 5_000;

afterEach(() => { __resetSimulationClock(); });

const newClock = () => installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
const expectedNow = (startedAt: number) => startedAt + HOUR;

describe('a machine added after the clock was advanced', () => {
  it('witness: a machine added BEFORE the advance follows it', async () => {
    const startedAt = Date.now();
    const clock = newClock();
    const pc = new LinuxPC('linux-pc', 'A');
    await clock.advance(HOUR);
    const seconds = Number((await pc.executeCommand('date +%s')).trim());
    expect(Math.abs(seconds * 1000 - expectedNow(startedAt))).toBeLessThan(TOLERANCE_MS);
  });

  it('a Linux machine added after the advance reads the advanced time', async () => {
    const startedAt = Date.now();
    const clock = newClock();
    await clock.advance(HOUR);
    const pc = new LinuxPC('linux-pc', 'A');
    const seconds = Number((await pc.executeCommand('date +%s')).trim());
    expect(Math.abs(seconds * 1000 - expectedNow(startedAt))).toBeLessThan(TOLERANCE_MS);
  });

  it('a Windows machine added after the advance reads the advanced time', async () => {
    const startedAt = Date.now();
    const clock = newClock();
    await clock.advance(HOUR);
    const pc = new WindowsPC('windows-pc', 'W');
    pc.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(pc).subShell;
    const out = (await shell.processLine('Get-Date -UFormat %s')).output.join('\n').trim();
    expect(Math.abs(Number(out) * 1000 - expectedNow(startedAt))).toBeLessThan(TOLERANCE_MS);
  });

  it('a Cisco router added after the advance shows the advanced year, month and day', async () => {
    const clock = newClock();
    await clock.advance(400 * 24 * HOUR);
    const router = new CiscoRouter('R1');
    const out = await router.executeCommand('show clock');
    const wanted = new Date(Date.now() + 400 * 24 * HOUR);
    expect(out).toContain(String(wanted.getUTCFullYear()));
  });

  it('every machine agrees with the clock of the infrastructure, whenever it was added', async () => {
    const clock = newClock();
    await clock.advance(HOUR);
    const early = new LinuxPC('linux-pc', 'A');
    await clock.advance(HOUR);
    const late = new LinuxPC('linux-pc', 'B');
    const read = async (pc: LinuxPC) => Number((await pc.executeCommand('date +%s')).trim()) * 1000;
    expect(Math.abs(await read(early) - simulationNowMs())).toBeLessThan(TOLERANCE_MS);
    expect(Math.abs(await read(late) - simulationNowMs())).toBeLessThan(TOLERANCE_MS);
    expect(Math.abs(await read(early) - await read(late))).toBeLessThan(TOLERANCE_MS);
  });
});
