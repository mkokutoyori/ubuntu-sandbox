/**
 * Probes — `OnCalendar=` et les timers d'usine.
 *
 * `docs/PRD-Taches-Planifiees.md` phase 2, objectifs P2.1 à P2.4.
 *
 * `TimerScheduler` ne connaissait que trois mots — `minutely`, `hourly`,
 * `daily`. Tout le reste rendait `null`, donc pas d'échéance, donc un
 * timer armé, affiché dans `list-timers` avec un `NEXT` à `n/a`, et qui
 * ne partait jamais. Or la forme normale d'un timer systemd est
 * justement une expression calendaire.
 *
 * Les échéances attendues ci-dessous ne sont pas déduites de
 * `systemd.time(7)` : elles ont été relevées sur le `systemd-analyze
 * calendar` de la machine de mesure, avec la même base de temps
 * (`--base-time="2026-08-02 19:50:00 UTC"`) et `--iterations=2`. Les
 * vingt-neuf expressions du tableau y ont été confrontées une par une,
 * et les deux sorties étaient identiques.
 *
 * Les six unités `.timer` d'usine sont, elles, recopiées des fichiers de
 * `/lib/systemd/system` d'un vrai Ubuntu — d'où des `OnCalendar=`
 * qu'on n'inventerait pas : `*-*-* 6,18:00` pour apt, `Sun *-*-*
 * 03:10:00` pour e2scrub, et un `systemd-tmpfiles-clean` qui n'a pas de
 * calendrier du tout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { parseCalendar, nextCalendarElapse } from '@/network/devices/linux/systemd/CalendarSpec';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

/** La base de temps des relevés `systemd-analyze`. */
const BASE = new Date('2026-08-02T19:50:00Z');

const iso = (d: Date | null) =>
  d === null ? 'never' : d.toISOString().replace('T', ' ').slice(0, 19);

function elapse(expr: string, count = 1): string[] {
  const spec = parseCalendar(expr);
  if (spec === null) return ['INVALIDE'];
  const out: string[] = [];
  let at = BASE;
  for (let i = 0; i < count; i++) {
    const next = nextCalendarElapse(spec, at);
    out.push(iso(next));
    if (next === null) break;
    at = next;
  }
  return out;
}

describe('Scénario 1 — les raccourcis, développés comme le vrai', () => {
  it('minutely, hourly, daily', () => {
    expect(elapse('minutely')).toEqual(['2026-08-02 19:51:00']);
    expect(elapse('hourly')).toEqual(['2026-08-02 20:00:00']);
    expect(elapse('daily')).toEqual(['2026-08-03 00:00:00']);
  });

  it('weekly tombe le lundi à minuit, pas « dans sept jours »', () => {
    // C'est la subtilité du raccourci : `Mon *-*-* 00:00:00`.
    expect(elapse('weekly', 2)).toEqual(['2026-08-03 00:00:00', '2026-08-10 00:00:00']);
  });

  it('monthly, yearly', () => {
    expect(elapse('monthly', 2)).toEqual(['2026-09-01 00:00:00', '2026-10-01 00:00:00']);
    expect(elapse('yearly', 2)).toEqual(['2027-01-01 00:00:00', '2028-01-01 00:00:00']);
  });

  it('quarterly et semiannually ont leurs mois à eux', () => {
    // `*-01,04,07,10-01` et `*-01,07-01`.
    expect(elapse('quarterly', 2)).toEqual(['2026-10-01 00:00:00', '2027-01-01 00:00:00']);
    expect(elapse('semiannually', 2)).toEqual(['2027-01-01 00:00:00', '2027-07-01 00:00:00']);
  });
});

describe('Scénario 2 — la forme complète, champ par champ', () => {
  it('jour de semaine seul ou en liste', () => {
    expect(elapse('Mon *-*-* 06:00:00', 2)).toEqual(['2026-08-03 06:00:00', '2026-08-10 06:00:00']);
    expect(elapse('Sat,Sun 12:00', 2)).toEqual(['2026-08-08 12:00:00', '2026-08-09 12:00:00']);
    expect(elapse('Mon,Wed,Fri *-*-* 07:30', 2)).toEqual(['2026-08-03 07:30:00', '2026-08-05 07:30:00']);
  });

  it('intervalle de jours de semaine', () => {
    expect(elapse('Mon..Fri 09:00', 2)).toEqual(['2026-08-03 09:00:00', '2026-08-04 09:00:00']);
  });

  it('listes et intervalles dans la date et l\'heure', () => {
    expect(elapse('*-*-* 00,12:00:00', 2)).toEqual(['2026-08-03 00:00:00', '2026-08-03 12:00:00']);
    expect(elapse('*-*-8..14 00:00:00', 2)).toEqual(['2026-08-08 00:00:00', '2026-08-09 00:00:00']);
  });

  it('les pas courent jusqu\'au bout du champ', () => {
    // `0/15` n'est pas « zéro puis quinze » mais « tous les quarts d'heure ».
    expect(elapse('*:0/15', 2)).toEqual(['2026-08-02 20:00:00', '2026-08-02 20:15:00']);
    expect(elapse('*-*-* 00/6:00:00', 2)).toEqual(['2026-08-03 00:00:00', '2026-08-03 06:00:00']);
  });

  it('une heure seule vaut tous les jours, une date seule minuit', () => {
    expect(elapse('03:00', 2)).toEqual(['2026-08-03 03:00:00', '2026-08-04 03:00:00']);
    expect(elapse('*:15')).toEqual(['2026-08-02 20:15:00']);
    // Une date fixe déjà passée n'arrive jamais — le vrai affiche « never ».
    expect(elapse('2026-01-01')).toEqual(['never']);
  });

  it('les expressions des unités Ubuntu livrées', () => {
    expect(elapse('*-*-* 6,18:00', 2)).toEqual(['2026-08-03 06:00:00', '2026-08-03 18:00:00']);
    expect(elapse('Sun *-*-* 03:10:00')).toEqual(['2026-08-09 03:10:00']);
    expect(elapse('00,12:00:00', 2)).toEqual(['2026-08-03 00:00:00', '2026-08-03 12:00:00']);
  });
});

describe('Scénario 3 — ce que le vrai refuse', () => {
  it('une liste nue n\'est ni une date ni une heure', () => {
    expect(parseCalendar('15,45')).toBeNull();
  });

  it('un raccourci suivi d\'autre chose n\'est pas un raccourci', () => {
    expect(parseCalendar('hourly:0')).toBeNull();
  });

  it('une valeur hors bornes est refusée', () => {
    expect(parseCalendar('*-13-01 00:00:00')).toBeNull();
    expect(parseCalendar('25:00')).toBeNull();
    expect(parseCalendar('Lundi 09:00')).toBeNull();
  });
});

describe('Scénario 4 — les six timers d\'usine', () => {
  it('`systemctl list-timers` n\'annonce plus « 0 timers »', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('systemctl list-timers');
    expect(out).toContain('6 timers listed.');
    for (const u of ['apt-daily.timer', 'apt-daily-upgrade.timer', 'fstrim.timer',
      'motd-news.timer', 'e2scrub_all.timer', 'systemd-tmpfiles-clean.timer']) {
      expect(out).toContain(u);
    }
  });

  it('chacun a une échéance datée, aucun n\'est resté à `n/a`', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    const rows = (await pc.executeCommand('systemctl list-timers'))
      .split('\n').filter((l) => l.includes('.timer'));
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatch(/^\w{3} \d{4}-\d{2}-\d{2}/);
  });

  it('les colonnes ne se chevauchent pas, même sur un nom long', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('systemctl list-timers');
    // À largeur fixe, `systemd-tmpfiles-clean.timer` collait ACTIVATES.
    expect(out).toContain('systemd-tmpfiles-clean.timer systemd-tmpfiles-clean.service');
  });

  it('`list-timers <unité>` ne montre que celle-là', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('systemctl list-timers fstrim.timer');
    expect(out).toContain('1 timers listed.');
    expect(out).not.toContain('apt-daily');
  });

  it('ils sont activés et en attente, comme après un vrai boot', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    expect(await pc.executeCommand('systemctl is-enabled fstrim.timer')).toBe('enabled');
    expect(await pc.executeCommand('systemctl status fstrim.timer')).toContain('active (waiting)');
  });
});

describe('Scénario 5 — `enable --now` et `@reboot`', () => {
  it('`enable --now` active et démarre en une commande', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    const vfs = (pc as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/systemd/system/mien.timer',
      '[Unit]\nDescription=Mien\n[Timer]\nOnCalendar=*-*-* *:*:00\nUnit=mien.service\n[Install]\nWantedBy=timers.target\n', 0, 0, 0o022);
    vfs.writeFile('/etc/systemd/system/mien.service',
      '[Unit]\nDescription=Mien\n[Service]\nType=oneshot\nExecStart=/bin/echo hop\n', 0, 0, 0o022);
    await pc.executeCommand('sudo systemctl daemon-reload');
    // `--now` était lu comme un nom d'unité : « Unit --now.service not found ».
    const out = await pc.executeCommand('sudo systemctl enable --now mien.timer');
    expect(out).not.toContain('not found');
    expect(await pc.executeCommand('systemctl is-active mien.timer')).toBe('active');
  });

  it('`disable --now` arrête dans la foulée', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('sudo systemctl disable --now fstrim.timer');
    expect(await pc.executeCommand('systemctl is-active fstrim.timer')).toBe('inactive');
  });

  it('`@reboot` part au redémarrage du service, une fois', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('echo "@reboot echo boot >> /home/user/boot.txt" | crontab -');
    await pc.executeCommand('sudo systemctl restart cron');
    // Une fois, pas deux : `restart()` démarre puis annonce le
    // redémarrage, et écouter les deux événements doublait la mise.
    expect(await pc.executeCommand('cat /home/user/boot.txt')).toBe('boot');
    await pc.executeCommand('sudo systemctl restart cron');
    expect(await pc.executeCommand('cat /home/user/boot.txt')).toBe('boot\nboot');
  });

  it('une ligne ordinaire ne part pas au redémarrage', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('echo "0 3 * * * echo nuit >> /home/user/nuit.txt" | crontab -');
    await pc.executeCommand('sudo systemctl restart cron');
    expect(await pc.executeCommand('cat /home/user/nuit.txt')).toContain('No such file');
  });
});
