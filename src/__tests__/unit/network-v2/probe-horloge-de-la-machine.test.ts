/**
 * Une machine n'a qu'UNE horloge : celle de l'equipement (`Equipment.systemClock`), qui suit
 * l'ordonnanceur, le temps passe sur le fil (`PathClock`) et `date -s`. Les attentes (`sleep`,
 * `Start-Sleep`, les retransmissions DHCP) la font avancer.
 *
 * MESURE DE DEPART, LinuxPC et WindowsPC neufs, ordonnanceur virtuel ou reel :
 *  - `date` lisait `new Date()` : `sleep 5; date` ne bougeait pas, `scheduler.advance(60000)`
 *    non plus, et `date -s "2030-01-01 12:00:00"` imprimait l'heure courante sans rien changer ;
 *  - l'executeur Linux tenait SA PROPRE horloge (`HostClock` + `wallEpoch = Date.now()`) et
 *    WindowsPC une autre, figee a `new Date(2026, 5, 20)` : `Get-Date` rendait
 *    2026-06-20 00:00:00 pendant que `date /t` de cmd rendait la date reelle — deux vues de la
 *    meme machine qui se contredisent ;
 *  - `uptime` lisait `Date.now()` : `sleep 3600; uptime -p` rendait « up 0 minutes » ;
 *  - un client DHCP sans serveur n'emettait qu'UN DISCOVER (deux avec le basculement du drapeau),
 *    sans aucun delai, et `secs` valait toujours 0.
 * Corrige : une seule horloge de machine (`HostClockPort`), `date -s` pose l'horloge de la
 * machine (root seulement, interprete dans son fuseau), `sleep` / `timeout N sleep M` / `Start-
 * Sleep` la font avancer (`sleep 100 &` non), le calendrier de DISCOVER est celui de la
 * personnalite : dhclient 3, 6, 12, 15, 15, 9 s (initial-interval 3, backoff-cutoff 15, timeout
 * 60 de dhclient.c), Windows 4, 8, 16, 32 s (RFC 2131 §4.1, doublement de 4 s), `secs` porte le
 * temps ecoule.
 * Discriminee contre l'etat d'avant (`git checkout <commit precedent> -- src/network`) : 11 des 14 cas
 * tombent. Les trois qui passent des deux cotes sont NOMMES : « le labo repond a date » (temoin),
 * « un sleep en arriere-plan ne retient pas le shell » (rien n'attendait avant, rien n'attend apres :
 * non-regression) et « Start-Sleep fait avancer Get-Date » (la voie PowerShell avançait deja sa
 * propre horloge logique : non-regression, c'est le doublon qui disparait).
 * Les tests de planificateur Windows dont les horaires sont absolus posent l'horloge de leur machine
 * (`pinClock`) : l'horloge d'une machine est l'heure reelle, un test ne doit pas dependre de l'heure
 * a laquelle on le lance.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const nowMs = async (pc: LinuxPC): Promise<number> =>
  Number(String(await pc.executeCommand('date +%s%N')).trim()) / 1e6;

function pair() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const peer = new LinuxPC('linux-pc', 'PEER');
  new Cable('c').connect(pc.getPort('eth0')!, peer.getPort('eth0')!);
  return { pc, peer };
}

describe('the machine clock moves with what the machine waits for', () => {
  it('the lab answers date — WITNESS', async () => {
    const { pc } = pair();
    expect(await nowMs(pc)).toBeGreaterThan(1.7e12);
  });

  it('sleep 5 moves date by five seconds', async () => {
    const { pc } = pair();
    const before = await nowMs(pc);
    await pc.executeCommand('sleep 5');
    const gap = (await nowMs(pc)) - before;
    expect(gap).toBeGreaterThanOrEqual(5000);
    expect(gap).toBeLessThan(5200);
  });

  it('timeout 2 sleep 5 costs two seconds, not five', async () => {
    const { pc } = pair();
    const before = await nowMs(pc);
    await pc.executeCommand('timeout 2 sleep 5');
    const gap = (await nowMs(pc)) - before;
    expect(gap).toBeGreaterThanOrEqual(2000);
    expect(gap).toBeLessThan(2200);
  });

  it('a backgrounded sleep does not hold the shell', async () => {
    const { pc } = pair();
    const before = await nowMs(pc);
    await pc.executeCommand('sleep 100 &');
    expect((await nowMs(pc)) - before).toBeLessThan(1000);
  });

  it('advancing the virtual scheduler moves date', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const { pc } = pair();
    const before = await nowMs(pc);
    scheduler.advance(60_000);
    const gap = (await nowMs(pc)) - before;
    expect(gap).toBeGreaterThanOrEqual(60_000);
    expect(gap).toBeLessThan(60_200);
  });

  it('uptime counts the time the machine slept', async () => {
    const { pc } = pair();
    await pc.executeCommand('sleep 3600');
    expect(await pc.executeCommand('uptime -p')).toBe('up 1 hour');
  });

  it('root sets the clock with date -s and date reads it back', async () => {
    const { pc } = pair();
    await pc.executeCommand('sudo date -s "2030-01-01 12:00:00"');
    expect(await pc.executeCommand('date -u +"%F %H"')).toBe('2030-01-01 12');
  });

  it('a non-root user is refused and the clock stays', async () => {
    const { pc } = pair();
    const before = await nowMs(pc);
    const out = String(await pc.executeCommand('date -s "2031-01-01"'));
    expect(out).toContain('date: cannot set date: Operation not permitted');
    expect((await nowMs(pc)) - before).toBeLessThan(1000);
  });

  it('date -s reads its argument in the zone of the machine', async () => {
    const { pc } = pair();
    await pc.executeCommand('sudo timedatectl set-timezone Europe/Paris');
    await pc.executeCommand('sudo date -s "2030-07-01 12:00:00"');
    expect(await pc.executeCommand('date -u +%H')).toBe('10');
  });

  it('the Windows machine tells the same day in PowerShell and in cmd, the day of its own clock', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const ps = String(await pc.executeCommand('powershell -c "Get-Date -Format yyyy-MM-dd"')).trim();
    expect(ps).toBe(pc.simulatedDate().toISOString().slice(0, 10));
    const cmd = String(await pc.executeCommand('date /t')).trim();
    const [, month, day, year] = /(\d{2})\/(\d{2})\/(\d{4})$/.exec(cmd)!;
    expect(`${year}-${month}-${day}`).toBe(ps);
  });

  it('Start-Sleep moves Get-Date on the Windows machine', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = String(await pc.executeCommand(
      "powershell -c \"Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; Start-Sleep 5; Get-Date -Format 'yyyy-MM-dd HH:mm:ss'\"")).trim().split('\n');
    const seconds = (stamp: string) => Date.parse(`${stamp.replace(' ', 'T')}Z`) / 1000;
    const gap = seconds(out[1]) - seconds(out[0]);
    expect(gap).toBeGreaterThanOrEqual(5);
    expect(gap).toBeLessThanOrEqual(6);
  });
});

describe('an unanswered DHCP client retransmits on its own calendar', () => {
  const discoverTimes = async (pc: LinuxPC, run: () => Promise<unknown>): Promise<{ at: number; secs: number }[]> => {
    const seen: { at: number; secs: number }[] = [];
    pc.attachCapture((tapped) => {
      if (tapped.direction !== 'out') return;
      const udp = (tapped.frame.payload as { payload?: { destinationPort?: number; payload?: { secs?: number } } }).payload;
      if (udp?.destinationPort === 67) seen.push({ at: tapped.atMicros / 1000, secs: udp.payload?.secs ?? 0 });
    });
    await run();
    return seen;
  };

  it('dhclient sends six DISCOVERs at 0, 3, 9, 21, 36 and 51 seconds and gives up at 60', async () => {
    const { pc } = pair();
    const seen = await discoverTimes(pc, () => pc.executeCommand('dhclient -v eth0'));
    const offsets = seen.map((entry) => Math.round((entry.at - seen[0].at) / 1000));
    expect(offsets).toEqual([0, 3, 9, 21, 36, 51]);
    expect(seen.map((entry) => entry.secs)).toEqual([0, 3, 9, 21, 36, 51]);
  });

  it('a Windows client sends four DISCOVERs at 0, 4, 12 and 28 seconds, the first with the broadcast flag clear', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const peer = new LinuxPC('linux-pc', 'PEER');
    new Cable('w').connect(pc.getPorts()[0], peer.getPort('eth0')!);
    const seen: { at: number; flags: number }[] = [];
    pc.attachCapture((tapped) => {
      if (tapped.direction !== 'out') return;
      const udp = (tapped.frame.payload as { payload?: { destinationPort?: number; payload?: { flags?: number } } }).payload;
      if (udp?.destinationPort === 67) seen.push({ at: tapped.atMicros / 1000, flags: udp.payload?.flags ?? 0 });
    });
    await pc.executeCommand('ipconfig /renew');
    expect(seen.map((entry) => Math.round((entry.at - seen[0].at) / 1000))).toEqual([0, 4, 12, 28]);
    expect(seen.map((entry) => entry.flags)).toEqual([0, 0x8000, 0x8000, 0x8000]);
  });

  it('the clock has moved by the whole sixty seconds when dhclient gives up', async () => {
    const { pc } = pair();
    const before = await nowMs(pc);
    await pc.executeCommand('dhclient eth0');
    const gap = (await nowMs(pc)) - before;
    expect(gap).toBeGreaterThanOrEqual(60_000);
    expect(gap).toBeLessThan(60_500);
  });
});
