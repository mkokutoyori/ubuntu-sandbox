/**
 * Une machine Linux simulee porte SON fuseau (`timedatectl`, `/etc/timezone`, `TZ`). Or dix-sept
 * sorties lisaient les accesseurs locaux d'un `Date` JavaScript, c'est-a-dire le fuseau du
 * PROCESSUS — en production, celui du NAVIGATEUR de l'utilisateur : une machine en UTC montrait
 * `who`, `w`, `last`, `ls -l`, `ps` (STIME), `journalctl`, `/var/log/syslog`, `/var/log/auth.log`,
 * `atq`, `systemctl list-timers` a l'heure de Paris ou de New York, selon qui regardait.
 *
 * MESURE : la meme suite de 37 commandes, une machine en UTC, jouee sous `TZ=UTC` puis sous
 * `TZ=Pacific/Auckland` pour le processus (`process.env.TZ` se relit a l'execution) : 17 sorties
 * differaient. Les calculs etaient faux aussi, pas seulement le rendu : `OnCalendar=` et
 * `at midnight` s'evaluaient sur l'horloge murale du processus (`list-timers` annoncait
 * `apt-daily` a 17:00 au lieu de 06:00) et `list-timers` ecrivait un « UTC » en dur derriere une
 * heure locale.
 *
 * Corrige en passant le fuseau de la MACHINE (`executor.localZone()` : `TZ` de la commande, sinon
 * le fuseau systeme) a chaque formateur, via `formatLocalTime` — la seule ecriture de strftime —
 * au lieu de six copies de `getHours()`. Au passage : `TZ=Asia/Tokyo date` et `export TZ=...`
 * etaient ignores, `stat` rendait de l'ISO a `Z` au lieu de `2026-10-06 18:25:21.158000000 +0000`,
 * le syslog distant et `watch` lisaient l'heure globale et non celle de la machine.
 *
 * Discriminee contre l'etat d'avant (sources de `HEAD`, meme sonde) : 22 des 30 cas tombent. Les 8
 * qui passent des deux cotes sont NOMMES : `date`, `uptime`, `crontab -l`, `chage -l root`,
 * `timedatectl`, `loginctl list-sessions` et `at teatime` (16:00 tombe a la meme heure d'un
 * processus UTC ou decale quand la machine est en UTC) sont des temoins, ils prouvent que la
 * suite ne rend pas tout rouge ; « timedatectl reste l'autorite sur le fuseau de la machine » est
 * la non-regression.
 *
 * Le laboratoire fixe l'origine de l'horloge virtuelle (`SimulationClock({ originMs })`) : sans
 * elle, l'heure de demarrage de la machine suit l'heure REELLE de l'essai et deux jeux identiques
 * different d'une seconde.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ORIGINAL_TZ = process.env.TZ;

const COMMANDS = [
  'date', 'uptime', 'who', 'w', 'last -n 3 | head -2', 'lastlog | head -3', 'ls -l /etc/hostname /tmp', 'ps aux | head -3', 'ps -ef | head -3',
  'journalctl -n 4 --no-pager | tail -n 3', 'tail -2 /var/log/syslog', 'tail -2 /var/log/auth.log', 'chage -l root', 'crontab -l',
  'systemctl list-timers --all | grep -v tmpfiles', 'timedatectl', 'last reboot | head -1', 'ls -lt /var/log | head -2', 'loginctl list-sessions --no-pager',
  'echo "date" | at now + 1 minute', 'atq', 'echo "date" | at teatime', 'systemd-analyze calendar "*-*-* 06:00:00"',
];

interface Lab { readonly server: LinuxServer; readonly clock: SimulationClock }

async function lab(processZone: string, machineZone?: string): Promise<Lab> {
  process.env.TZ = processZone;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 6, 18, 25, 0) }));
  const server = new LinuxServer('linux-server', 'S1');
  if (machineZone !== undefined) await server.executeCommand(`timedatectl set-timezone ${machineZone}`);
  await clock.advance(3 * 3600_000 + 17 * 60_000);
  await server.executeCommand('echo "* * * * * date" | crontab -');
  await clock.advance(5 * 60_000);
  return { server, clock };
}

async function transcript(processZone: string, machineZone?: string): Promise<string[]> {
  const { server } = await lab(processZone, machineZone);
  const out: string[] = [];
  for (const command of COMMANDS) out.push(await server.executeCommand(command));
  return out;
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('a Linux machine prints its own time zone, not the one of the process', () => {
  it('witness: the transcript of a UTC machine is stable under a UTC process', async () => {
    const first = await transcript('UTC');
    const second = await transcript('UTC');
    expect(second).toEqual(first);
    expect(first[1]).toContain('21:47');
  });

  it.each(COMMANDS.map((command, index) => [command, index] as const))('%s', async (_command, index) => {
    const underUtc = (await transcript('UTC'))[index];
    const underAuckland = (await transcript('Pacific/Auckland'))[index];
    expect(underAuckland).toBe(underUtc);
  });

  it('prints the clock of a Tokyo machine in Tokyo time whatever the process zone', async () => {
    const underUtc = await transcript('UTC', 'Asia/Tokyo');
    const underNewYork = await transcript('America/New_York', 'Asia/Tokyo');
    expect(underNewYork).toEqual(underUtc);
    expect(underUtc[0]).toContain('JST');
    expect(underUtc[0]).toContain('Oct 07 06:');
    expect(underUtc[10]).toMatch(/^Oct {2}7 06:/m);
  });

  it('evaluates OnCalendar in the zone of the machine', async () => {
    const { server } = await lab('UTC', 'Asia/Tokyo');
    const listed = await server.executeCommand('systemctl list-timers --all');
    expect(listed).toMatch(/Wed 2026-10-07 18:00:00 JST\s+\S+\s+Wed 2026-10-07 06:00:00 JST\s+\S+\s+apt-daily\.timer/);
  });

  it('reads TZ from the command, then from the exported variable', async () => {
    const { server } = await lab('UTC');
    expect((await server.executeCommand('TZ=Asia/Tokyo date +%H:%Z')).trim()).toBe('06:JST');
    expect((await server.executeCommand('TZ=America/New_York date +%Z')).trim()).toBe('EDT');
    await server.executeCommand('export TZ=Asia/Tokyo');
    expect((await server.executeCommand('date +%Z')).trim()).toBe('JST');
    expect((await server.executeCommand('TZ=Nowhere/Land date +%Z')).trim()).toBe('UTC');
  });

  it('schedules at midnight at the next midnight of the machine zone', async () => {
    const { server } = await lab('UTC', 'Asia/Tokyo');
    const out = await server.executeCommand('echo "date" | at midnight');
    expect(out).toContain('job 1 at Thu Oct  8 00:00:00 2026');
  });

  it('prints stat times with the machine offset and the GNU layout', async () => {
    const { server } = await lab('Pacific/Auckland', 'Asia/Tokyo');
    const out = await server.executeCommand('stat /etc/hostname');
    expect(out).toMatch(/Modify: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} \+0900/);
  });

  it('keeps timedatectl as the authority on the machine zone', async () => {
    const { server } = await lab('Pacific/Auckland', 'Asia/Tokyo');
    expect(await server.executeCommand('timedatectl')).toContain('Time zone: Asia/Tokyo (JST, +0900)');
  });
});
