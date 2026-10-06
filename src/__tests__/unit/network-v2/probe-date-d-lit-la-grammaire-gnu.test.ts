/**
 * `date -d` ne lisait que `now`, `today`, `yesterday`, `tomorrow`, `@N`, « N unite [ago] » et ce
 * que `Date.parse` de JavaScript veut bien accepter. Machine posee au mardi 2026-10-06 18:21:17
 * UTC : `+1 day`, `next friday`, `last monday`, `next month`, `now + 3 days`, `12:00 tomorrow`,
 * `5pm`... rendaient `date: invalid date`, et `today` / `yesterday` / `tomorrow` tombaient a
 * MINUIT alors que GNU date garde l'heure courante (`date -d tomorrow` = demain a la meme heure).
 *
 * `core/time/GnuDateInput` porte maintenant la grammaire « Date input formats » de coreutils
 * (heure, date calendaire, jour de semaine et ordinaux, decalages relatifs, `ago`, fuseaux
 * `UTC`/`EST`/`+0200`). Les attendus ci-dessous ne sont PAS deduits du manuel : les 80 formes du
 * banc ont ete confrontees, a la meme seconde, au `date -u -d` GNU de la machine de mesure, avec
 * zero ecart apres retrait de `noon` et `midnight` (mots de `at`, que `date` refuse : l'analyseur
 * les refuse aussi).
 *
 * Discriminee contre l'etat d'avant : 31 des 54 cas tombent. Les 23 qui passent des deux cotes sont
 * les formes que l'ancien lecteur savait deja (`now`, `2 hours ago`, `1 week`, les dates ISO, `@86400`,
 * `Jan 5 2027 10:30`...) et les refus qu'il faisait deja : temoins et non-regression.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["now", "2026-10-06 18:21:17"],
  ["today", "2026-10-06 18:21:17"],
  ["tomorrow", "2026-10-07 18:21:17"],
  ["yesterday", "2026-10-05 18:21:17"],
  ["+1 day", "2026-10-07 18:21:17"],
  ["-2 hours", "2026-10-06 16:21:17"],
  ["2 hours ago", "2026-10-06 16:21:17"],
  ["now + 3 days", "2026-10-09 18:21:17"],
  ["1 week", "2026-10-13 18:21:17"],
  ["3 days ago", "2026-10-03 18:21:17"],
  ["next friday", "2026-10-09 00:00:00"],
  ["last friday", "2026-10-02 00:00:00"],
  ["friday", "2026-10-09 00:00:00"],
  ["tuesday", "2026-10-06 00:00:00"],
  ["next tuesday", "2026-10-13 00:00:00"],
  ["last monday", "2026-10-05 00:00:00"],
  ["this friday", "2026-10-09 00:00:00"],
  ["next month", "2026-11-06 18:21:17"],
  ["last year", "2025-10-06 18:21:17"],
  ["next fortnight", "2026-10-20 18:21:17"],
  ["12:00 tomorrow", "2026-10-07 12:00:00"],
  ["tomorrow 12:00", "2026-10-07 12:00:00"],
  ["10:30", "2026-10-06 10:30:00"],
  ["10:30pm", "2026-10-06 22:30:00"],
  ["5pm", "2026-10-06 17:00:00"],
  ["2026-10-06", "2026-10-06 00:00:00"],
  ["2026-10-06 10:30:15", "2026-10-06 10:30:15"],
  ["2026-10-06T10:30:15Z", "2026-10-06 10:30:15"],
  ["2026-10-06 10:30 +0200", "2026-10-06 08:30:00"],
  ["20261006", "2026-10-06 00:00:00"],
  ["10/06/2026", "2026-10-06 00:00:00"],
  ["Jan 5 2027 10:30", "2027-01-05 10:30:00"],
  ["5 Jan 2027", "2027-01-05 00:00:00"],
  ["January 5, 2027", "2027-01-05 00:00:00"],
  ["Tue Oct 6 18:21:17 UTC 2026", "2026-10-06 18:21:17"],
  ["Tue, 06 Oct 2026 18:21:17 GMT", "2026-10-06 18:21:17"],
  ["@86400", "1970-01-02 00:00:00"],
  ["2027-01-31 +1 month", "2027-03-03 00:00:00"],
  ["1 day ago 2 hours", "2026-10-05 20:21:17"],
  ["2 weeks", "2026-10-20 18:21:17"],
  ["1 month ago", "2026-09-06 18:21:17"],
  ["sunday 14:00", "2026-10-11 14:00:00"],
  ["first monday", "2026-10-12 00:00:00"],
  ["3pm yesterday", "2026-10-05 15:00:00"],
  ["2026-12-25 EST", "2026-12-25 05:00:00"],
  ["2026-07-01 10:00 PDT", "2026-07-01 17:00:00"]
];

const REFUSED = ['garbage', 'next', 'a b', '2026-02-30', '2026-10-06 25:00', 'noon', 'midnight'];

let server: LinuxServer;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); Logger.reset();
  installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
  server = new LinuxServer('linux-server', 'S1');
  await server.executeCommand('date -s "2026-10-06 18:21:17"');
});

afterEach(() => { __resetSimulationClock(); });

describe('date -d reads the GNU date input grammar', () => {
  it.each(CASES)('%s', async (spec, expected) => {
    const out = await server.executeCommand(`date -d "${spec}" "+%F %T"`);
    expect(out.trim()).toBe(expected);
  });

  it.each(REFUSED)('refuses %s like GNU date', async (spec) => {
    const out = await server.executeCommand(`date -d "${spec}"`);
    expect(out.trim()).toBe(`date: invalid date '${spec}'`);
  });

  it('reads the date in the zone of the machine', async () => {
    await server.executeCommand('timedatectl set-timezone Asia/Tokyo');
    const out = await server.executeCommand('date -d "tomorrow 10:30" "+%F %T %Z"');
    expect(out.trim()).toBe('2026-10-08 10:30:00 JST');
  });
});
