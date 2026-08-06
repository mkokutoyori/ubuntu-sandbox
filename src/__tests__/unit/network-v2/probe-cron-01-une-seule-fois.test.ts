/**
 * Probes — cron exécute une fois, et refuse ce qu'il ne sait pas lire.
 *
 * `docs/PRD-Taches-Planifiees.md` phase 1, objectifs P1.1 et P1.5.
 *
 * Deux défauts mesurés, de la même famille : le crontab utilisateur
 * existait en double, et n'importe quoi pouvait s'y installer.
 *
 * Le double venait de deux sources énumérées côte à côte —
 * `LinuxCronManager` gardait une copie en mémoire pendant que
 * `installCrontab` écrivait aussi le fichier de spool, et le moteur
 * lisait les deux. Une sauvegarde tournait donc deux fois par minute.
 * `/etc/cron.d` ne présentait pas le défaut, ce qui a désigné le
 * coupable. Le fichier fait désormais foi, seul.
 *
 * Le refus, lui, était déjà entièrement calculé : `parseCrontab`
 * relevait les lignes fautives depuis toujours, personne ne lisait ses
 * `errors`.
 *
 * Réserve d'honnêteté : `crontab` n'est pas installé sur la machine de
 * mesure, les libellés ci-dessous suivent donc le format documenté de
 * Vixie cron sans avoir pu être confrontés à un binaire réel. Le
 * comportement — refuser, ne rien installer, laisser le précédent en
 * place, sortir en 1 — lui a été vérifié ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): { pc: LinuxPC; tick: (minute: number) => void } {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  // Le minuteur autonome de cron est un vrai `setInterval` de 60 s. Ces
  // cas comptent les exécutions d'une minute pilotée à la main : si la
  // suite est lente au point de franchir une minute réelle, ce minuteur
  // tombe en plus et ajoute une trace, et la sonde mesure alors la charge
  // de la machine au lieu de cron. On le coupe ; c'est l'horloge du test
  // qui fait foi.
  const machine = pc as unknown as {
    cronTick(at?: Date): void;
    cronTimer: symbol | null;
    hostTimers: { clear(id: symbol): void };
  };
  if (machine.cronTimer) { machine.hostTimers.clear(machine.cronTimer); machine.cronTimer = null; }
  // The clock is FIXED rather than `Date.now()`, and that is the whole
  // point. The machine ships Debian's own `/etc/crontab`, whose hourly
  // entry `17 * * * * root cd / && run-parts --report /etc/cron.hourly`
  // is genuinely due one minute per hour — so a probe started at :16
  // counted two CRON lines in syslog and failed, measuring the time of
  // day instead of cron. The second line was correct behaviour; the real
  // clock was the defect. 09:00 is a quiet minute: none of the four
  // seeded entries (17 hourly, 25 6, 47 6 sunday, 52 6 on the 1st) falls
  // within the three ticks these cases drive.
  const base = new Date(2026, 0, 1, 9, 0, 0).getTime();
  return { pc, tick: (minute) => machine.cronTick(new Date(base + minute * 60_000)) };
}

describe('Scénario 1 — une minute, une exécution', () => {
  it('un tour de cron exécute la tâche une seule fois', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * echo tick >> /home/user/t.txt" | crontab -');
    tick(1);
    expect(await pc.executeCommand('cat /home/user/t.txt')).toBe('tick');
  });

  it('et ne laisse qu\'une trace dans syslog', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    tick(1);
    expect(await pc.executeCommand('grep -c CRON /var/log/syslog')).toBe('1');
  });

  it('trois minutes donnent trois exécutions, pas six', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('echo "* * * * * echo t >> /home/user/t.txt" | crontab -');
    for (const m of [1, 2, 3]) tick(m);
    expect(await pc.executeCommand('cat /home/user/t.txt')).toBe('t\nt\nt');
  });

  it('/etc/cron.d compte pour un lui aussi', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand(
      'sudo sh -c "echo \'* * * * * root echo d >> /home/user/d.txt\' > /etc/cron.d/mien"');
    tick(1);
    expect(await pc.executeCommand('cat /home/user/d.txt')).toBe('d');
  });
});

describe('Scénario 2 — le fichier de spool est la seule vérité', () => {
  it('`crontab -l` lit ce que cron exécute', async () => {
    const { pc } = lab();
    await pc.executeCommand('echo "*/5 * * * * /bin/true" | crontab -');
    // Une modification directe du spool — ce qu'un `vim` ferait — doit se
    // voir : sans quoi cron exécuterait une ligne que `-l` ne montre pas.
    await pc.executeCommand(
      'sudo sh -c \'printf "0 3 * * * /bin/edite\\n" > /var/spool/cron/crontabs/user\'');
    expect(await pc.executeCommand('crontab -l')).toBe('0 3 * * * /bin/edite');
  });

  it('`crontab -r` efface des deux côtés', async () => {
    const { pc } = lab();
    await pc.executeCommand('echo "*/5 * * * * /bin/true" | crontab -');
    await pc.executeCommand('crontab -r');
    expect(await pc.executeCommand('crontab -l')).toBe('no crontab for user');
    expect(await pc.executeCommand('sudo cat /var/spool/cron/crontabs/user'))
      .toContain('No such file');
  });
});

describe('Scénario 3 — ce qui n\'est pas lisible n\'est pas installé', () => {
  it('une ligne sans horaire est refusée, en nommant le champ', async () => {
    const { pc } = lab();
    const out = await pc.executeCommand('echo "bidon" | crontab -');
    expect(out).toContain('bad minute');
    expect(out).toContain("errors in crontab file, can't install.");
  });

  it('une minute hors bornes est refusée', async () => {
    const { pc } = lab();
    // 99 n'est pas une minute ; c'était pourtant installé et relu.
    expect(await pc.executeCommand('echo "99 * * * * /bin/true" | crontab -'))
      .toContain('bad minute');
  });

  it('chaque champ est nommé pour lui-même', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('echo "* 99 * * * /bin/true" | crontab -')).toContain('bad hour');
    expect(await pc.executeCommand('echo "* * 99 * * /bin/true" | crontab -')).toContain('bad day-of-month');
    expect(await pc.executeCommand('echo "* * * 13 * /bin/true" | crontab -')).toContain('bad month');
    expect(await pc.executeCommand('echo "* * * * xyz /bin/true" | crontab -')).toContain('bad day-of-week');
    expect(await pc.executeCommand('echo "* * * * *" | crontab -')).toContain('bad command');
  });

  it('le refus sort en 1', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('echo "bidon" | crontab -; echo rc=$?')).toContain('rc=1');
  });

  it('et surtout : le crontab précédent survit', async () => {
    const { pc } = lab();
    await pc.executeCommand('echo "*/5 * * * * /bin/garde" | crontab -');
    await pc.executeCommand('echo "bidon" | crontab -');
    // Installer la moitié d'un fichier, ou l'effacer sur une faute,
    // serait pire que refuser.
    expect(await pc.executeCommand('crontab -l')).toBe('*/5 * * * * /bin/garde');
  });

  it('une ligne fautive condamne tout le fichier, pas seulement elle', async () => {
    const { pc } = lab();
    await pc.executeCommand('printf "* * * * * /bin/bon\\nbidon\\n" | crontab -');
    expect(await pc.executeCommand('crontab -l')).toBe('no crontab for user');
  });
});

describe('Scénario 4 — ce qui est valable passe toujours', () => {
  it('les macros restent acceptées', async () => {
    const { pc } = lab();
    await pc.executeCommand('echo "@daily /bin/true" | crontab -');
    expect(await pc.executeCommand('crontab -l')).toBe('@daily /bin/true');
  });

  it('les pas, listes et intervalles aussi', async () => {
    const { pc } = lab();
    await pc.executeCommand('echo "*/15 1,2 1-5 jan mon /bin/true" | crontab -');
    expect(await pc.executeCommand('crontab -l')).toBe('*/15 1,2 1-5 jan mon /bin/true');
  });

  it('MAILTO survit au trajet et fait poster le courriel', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('printf "MAILTO=user\\n* * * * * echo bruit\\n" | crontab -');
    tick(1);
    expect(await pc.executeCommand('mail')).toContain('1 message');
  });
});
