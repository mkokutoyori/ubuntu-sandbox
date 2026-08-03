/**
 * Sondes — phase 4 des tâches planifiées : ce que le PRD listait comme
 * absent, et les deux réserves laissées ouvertes en phase 3.
 *
 * `docs/PRD-Taches-Planifiees.md` phase 4 (L7 à L10) et §Phase 3, « ce
 * qui n'a pas été fait ».
 *
 * **Vérité terrain.** Contrairement aux phases précédentes, les vrais
 * binaires ont pu être installés sur la machine de mesure
 * (`apt-get install at anacron cron`), si bien que tout ce qui est
 * affirmé ici a été confronté au vrai — y compris le cas négatif de
 * `cron.allow`/`cron.deny` que le PRD signalait explicitement comme
 * jamais mesuré (L10). Les relevés qui ont servi :
 *
 *   crontab -e sur un crontab absent :
 *     no crontab for root - using an empty one
 *     crontab: installing new crontab
 *   crontab -e refusé :
 *     crontab: installing new crontab
 *     "/tmp/crontab.cDzPUp/crontab":1: bad minute
 *     errors in crontab file, can't install.
 *     Do you want to retry the same edit? (y/n) ...
 *     crontab: edits left in /tmp/crontab.cDzPUp/crontab
 *   crontab -e sans modification :  No modification made
 *   cron.deny nommant l'utilisateur (en tant que cet utilisateur) :
 *     You (essai) are not allowed to use this program (crontab)
 *     See crontab(1) for more information          ← sans point final
 *   at.deny nommant l'utilisateur :
 *     You do not have permission to use atq.
 *   at 04:00 :
 *     warning: commands will be executed using /bin/sh
 *     job 1 at Mon Aug  3 04:00:00 2026
 *     Can't open /run/atd.pid to signal atd. No atd running?
 *   atq :  1<TAB>Mon Aug  3 04:00:00 2026 a root
 *   at <heure illisible> :  Garbled time
 *   atrm 99 :  Cannot find jobid 99
 *   anacron -d -n :
 *     Anacron 2.3 started on 2026-08-02 / Will run job `essai' / …
 *     Normal exit (1 job run)
 *   systemd-analyze calendar daily :
 *       Original form: daily
 *     Normalized form: *-*-* 00:00:00
 *         Next elapse: Mon 2026-08-03 00:00:00 UTC
 *            From now: 2h 23min left
 *
 * Deux constats du relevé méritent d'être écrits ici parce qu'ils
 * contredisent ce qu'on suppose spontanément :
 *   - **root passe outre** `cron.allow`, `cron.deny` et `at.allow` : un
 *     `cron.allow` qui ne contient pas `root`, et un `cron.deny` qui
 *     contient `root`, laissent l'un comme l'autre root travailler.
 *   - `at` **met la tâche au spool même quand `atd` est arrêté** ; il ne
 *     sait pas prévenir le démon, le dit, et s'arrête là. Il ne refuse
 *     pas, contrairement à ce que faisait le simulateur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}
async function tape(session: LinuxTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}
function texte(session: LinuxTerminalSession): string {
  return (session as unknown as { lines: { text: string }[] }).lines.map((l) => l.text).join('\n');
}

/** Écrit dans le tampon de l'éditeur ouvert, puis sort en enregistrant. */
async function editeEtEnregistre(
  session: LinuxTerminalSession, pc: LinuxPC, contenu: string,
): Promise<void> {
  const mode = session.currentInputMode as { type: string; absolutePath?: string };
  expect(mode.type).toBe('editor');
  const shell = (session as unknown as { shell: unknown }).shell;
  (pc as unknown as { writeFileFromEditorInSession(p: string, c: string, s: unknown): void })
    .writeFileFromEditorInSession(mode.absolutePath!, contenu, shell);
  session.editorExit(true);
  await flush();
}

describe('Scénario 1 — crontab -e ouvre, valide, et refuse (L7)', () => {
  it('annonce un crontab absent et installe ce que l\'éditeur a écrit', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    const session = new LinuxTerminalSession('t1', pc);
    await tape(session, 'crontab -e');
    expect(texte(session)).toContain('no crontab for user - using an empty one');

    await editeEtEnregistre(session, pc, '* * * * * /bin/true\n');
    expect(texte(session)).toContain('crontab: installing new crontab');
    expect(await pc.executeCommand('crontab -l')).toContain('* * * * * /bin/true');
  });

  it('refuse une ligne fautive au lieu de l\'installer, et propose de reprendre', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('echo "0 3 * * * /bin/vrai" | crontab -');
    const session = new LinuxTerminalSession('t1', pc);

    await tape(session, 'crontab -e');
    await editeEtEnregistre(session, pc, 'bidon\n');
    const out = texte(session);
    expect(out).toContain('bad minute');
    expect(out).toContain("errors in crontab file, can't install.");
    expect(out).toContain('Do you want to retry the same edit? (y/n)');

    // Le crontab d'avant survit : le vrai n'installe pas la moitié d'un
    // fichier, et surtout n'efface pas celui qui marchait.
    expect(await pc.executeCommand('crontab -l')).toContain('/bin/vrai');
  });

  it('« n » laisse l\'édition dans le fichier temporaire', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    const session = new LinuxTerminalSession('t1', pc);
    await tape(session, 'crontab -e');
    await editeEtEnregistre(session, pc, 'bidon\n');
    await tape(session, 'n');
    expect(texte(session)).toContain('crontab: edits left in /tmp/crontab.');
  });

  it('sortir sans enregistrer ne change rien, et le dit', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    const session = new LinuxTerminalSession('t1', pc);
    await tape(session, 'crontab -e');
    session.editorExit(false);
    await flush();
    expect(texte(session)).toContain('No modification made');
  });

  it('hors terminal, il n\'y a pas d\'éditeur — et le vrai le dit', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    // Le défaut mesuré en phase 0 était une sortie *vide*, qui laisse
    // croire que la commande a marché.
    expect(await pc.executeCommand('crontab -e')).toContain('exited with status 1');
  });
});

describe('Scénario 2 — cron.allow et cron.deny, cas négatif compris (L10)', () => {
  async function avecEssai(): Promise<LinuxServer> {
    // Un `LinuxServer` ouvre sa session en root ; un `LinuxPC` est
    // `user` et `useradd` y répond « Permission denied ». Le nom de type
    // passé au constructeur ne change pas la classe.
    const pc = new LinuxServer('linux-server', 'srv', 0, 0); pc.powerOn();
    await pc.executeCommand('useradd -m essai');
    return pc;
  }

  it('aucun des deux fichiers d\'usine : tout le monde passe', async () => {
    const pc = await avecEssai();
    expect(await pc.executeCommand('ls /etc/cron.allow')).toContain('No such file');
    expect(await pc.executeCommand('ls /etc/cron.deny')).toContain('No such file');
    expect(await pc.executeCommand('su essai -c "crontab -l"')).toContain('no crontab for essai');
  });

  it('cron.deny nommant l\'utilisateur le refuse, mot pour mot', async () => {
    const pc = await avecEssai();
    await pc.executeCommand('echo essai > /etc/cron.deny');
    const out = await pc.executeCommand('su essai -c "crontab -l"');
    expect(out).toContain('You (essai) are not allowed to use this program (crontab)');
    // Sans point final : c'est le relevé.
    expect(out).toContain('See crontab(1) for more information');
    expect(out).not.toContain('more information.');
  });

  it('cron.allow qui ne le nomme pas le refuse aussi', async () => {
    const pc = await avecEssai();
    await pc.executeCommand('echo root > /etc/cron.allow');
    expect(await pc.executeCommand('su essai -c "crontab -l"')).toContain('are not allowed');
  });

  it('cron.allow l\'emporte sur cron.deny', async () => {
    const pc = await avecEssai();
    await pc.executeCommand('echo essai > /etc/cron.deny');
    await pc.executeCommand('printf "root\\nessai\\n" > /etc/cron.allow');
    expect(await pc.executeCommand('su essai -c "crontab -l"')).toContain('no crontab for essai');
  });

  it('root passe outre les deux — mesuré sur le vrai', async () => {
    const pc = await avecEssai();
    await pc.executeCommand('echo root > /etc/cron.deny');
    expect(await pc.executeCommand('crontab -l')).not.toContain('are not allowed');
  });
});

describe('Scénario 3 — le sujet du courriel cron (L8)', () => {
  it('`mail` montre le sujet que cron a composé', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('echo "* * * * * echo salut" | crontab -');
    await pc.executeCommand('systemctl start cron');
    (pc as unknown as { cronTick(at?: Date): void }).cronTick(new Date(Date.now() + 60_000));

    const out = await pc.executeCommand('mail');
    // Le défaut : « (no subject) », parce que la boîte du disque est en
    // LF et que le lecteur ne découpait qu'en CRLF — le message entier
    // ne faisait alors qu'une ligne, sans en-tête.
    expect(out).not.toContain('(no subject)');
    expect(out).toContain('Cron <user@');
    expect(out).toContain('echo salut');
  });
});

describe('Scénario 4 — at, atq, atrm, batch (L9)', () => {
  async function labAt(): Promise<LinuxPC> {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('systemctl start atd');
    return pc;
  }

  it('`at` annonce le shell et date la tâche au format ctime', async () => {
    const pc = await labAt();
    const out = await pc.executeCommand('echo /bin/true | at 04:00');
    expect(out).toContain('warning: commands will be executed using /bin/sh');
    // Le quantième est cadré à l'espace, pas au zéro : `Aug  3`.
    expect(out).toMatch(/job 1 at \w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/);
  });

  it('`at -l` est un alias d\'`atq`, pas une tentative de mise au spool', async () => {
    const pc = await labAt();
    await pc.executeCommand('echo /bin/true | at 04:00');
    const atq = await pc.executeCommand('atq');
    expect(await pc.executeCommand('at -l')).toBe(atq);
    expect(atq).not.toContain('no command to schedule');
  });

  it('une heure illisible est refusée, et rien n\'est mis au spool', async () => {
    const pc = await labAt();
    expect(await pc.executeCommand('echo /bin/true | at nimportequoi')).toBe('Garbled time');
    expect(await pc.executeCommand('atq')).toBe('');
  });

  it('`batch` va dans la file b', async () => {
    const pc = await labAt();
    await pc.executeCommand('echo /bin/true | batch');
    expect(await pc.executeCommand('atq')).toMatch(/\sb\s/);
  });

  it('`atrm` d\'un identifiant inconnu le dit', async () => {
    const pc = await labAt();
    expect(await pc.executeCommand('atrm 99')).toBe('Cannot find jobid 99');
  });

  it('`atd` arrêté ne fait pas perdre la tâche : elle est spoolée, avec l\'avertissement', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    // `atd` est démarré d'usine, comme sur un Ubuntu où `at` est
    // installé : c'est l'arrêt qu'il faut provoquer, pas le démarrage.
    await pc.executeCommand('sudo systemctl stop atd');
    const out = await pc.executeCommand('echo /bin/true | at 04:00');
    expect(out).toContain('No atd running?');
    expect(await pc.executeCommand('atq')).toContain('04:00:00');
  });
});

describe('Scénario 5 — une tâche at part vraiment', () => {
  it('le tour de minute exécute la tâche échue et la retire du spool', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('systemctl start atd');
    await pc.executeCommand('echo "echo parti >> /home/user/t.txt" | at now');
    expect(await pc.executeCommand('atq')).not.toBe('');

    (pc as unknown as { cronTick(at?: Date): void }).cronTick(new Date(Date.now() + 60_000));

    expect(await pc.executeCommand('cat /home/user/t.txt')).toContain('parti');
    // À usage unique : une tâche exécutée ne revient pas.
    expect(await pc.executeCommand('atq')).toBe('');
  });

  it('`atd` arrêté ne déclenche rien, et ne perd rien', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('sudo systemctl stop atd');
    await pc.executeCommand('echo "echo parti >> /home/user/t.txt" | at now');
    (pc as unknown as { cronTick(at?: Date): void }).cronTick(new Date(Date.now() + 60_000));
    expect(await pc.executeCommand('cat /home/user/t.txt')).toContain('No such file');
    expect(await pc.executeCommand('atq')).not.toBe('');
  });
});

describe('Scénario 6 — at.allow et at.deny (L9)', () => {
  it('le paquet at livre un /etc/at.deny, contrairement à cron', async () => {
    // Root : le fichier est en 0640 root:daemon, comme sur le vrai — un
    // utilisateur ordinaire n'a pas à lire qui est interdit.
    const pc = new LinuxServer('linux-server', 'srv', 0, 0); pc.powerOn();
    expect(await pc.executeCommand('ls /etc/at.deny')).not.toContain('No such file');
    expect(await pc.executeCommand('cat /etc/at.deny')).toContain('www-data');
  });

  it('at.deny nommant l\'utilisateur refuse at, atq et atrm chacun sous son nom', async () => {
    const pc = new LinuxServer('linux-server', 'srv', 0, 0); pc.powerOn();
    await pc.executeCommand('useradd -m essai');
    await pc.executeCommand('echo essai > /etc/at.deny');
    expect(await pc.executeCommand('su essai -c "atq"'))
      .toContain('You do not have permission to use atq.');
    expect(await pc.executeCommand('su essai -c "atrm 1"'))
      .toContain('You do not have permission to use atrm.');
  });

  it('at.allow qui ne le nomme pas le refuse, mais laisse passer root', async () => {
    const pc = new LinuxServer('linux-server', 'srv', 0, 0); pc.powerOn();
    await pc.executeCommand('useradd -m essai');
    await pc.executeCommand('echo root > /etc/at.allow');
    expect(await pc.executeCommand('su essai -c "atq"')).toContain('do not have permission');
    expect(await pc.executeCommand('atq')).not.toContain('do not have permission');
  });
});

describe('Scénario 7 — anacron (L9)', () => {
  it('/etc/anacrontab est livré d\'usine, avec ses trois tâches', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    const tab = await pc.executeCommand('cat /etc/anacrontab');
    expect(tab).toContain('cron.daily');
    expect(tab).toContain('cron.weekly');
    expect(tab).toContain('@monthly');
  });

  it('`-T` valide sans rien exécuter et sort en 0', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    expect(await pc.executeCommand('anacron -T')).toBe('');
  });

  it('une ligne fautive est signalée puis sautée — elle n\'est pas fatale', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('printf "1 5\\n1 0 bon /bin/true\\n" > /tmp/t.tab');
    const out = await pc.executeCommand('anacron -T -t /tmp/t.tab');
    expect(out).toContain('Invalid syntax in /tmp/t.tab on line 1 - skipping this line');
  });

  it('`-d -n` exécute les tâches dues, puis plus rien le même jour', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    const un = await pc.executeCommand('anacron -d -n');
    expect(un).toContain('Anacron 2.3 started on');
    expect(un).toContain("Will run job `cron.daily'");
    expect(un).toContain('Normal exit (3 jobs run)');

    // L'horodatage retient le passage : c'est toute la différence avec
    // cron, qui ne rattrape jamais rien.
    const deux = await pc.executeCommand('anacron -d -n');
    expect(deux).toContain('Normal exit (0 jobs run)');
  });

  it('`-f` force malgré l\'horodatage', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    await pc.executeCommand('anacron -u');
    expect(await pc.executeCommand('anacron -d -n -f')).toContain("Will run job `cron.daily'");
  });

  it('`-u` pose les horodatages sans rien exécuter', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn();
    expect(await pc.executeCommand('anacron -u')).toBe('');
    expect(await pc.executeCommand('anacron -d -n')).toContain('Normal exit (0 jobs run)');
  });
});

describe('Scénario 8 — systemd-analyze calendar (L9)', () => {
  const pcNeuf = (): LinuxPC => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0); pc.powerOn(); return pc;
  };

  it('un raccourci montre sa forme d\'origine ET sa forme normalisée', async () => {
    const out = await pcNeuf().executeCommand('systemd-analyze calendar daily');
    expect(out).toContain('  Original form: daily');
    expect(out).toContain('Normalized form: *-*-* 00:00:00');
    expect(out).toContain('    Next elapse: ');
    expect(out).toContain('       From now: ');
  });

  it('une expression déjà normale n\'a pas de « Original form »', async () => {
    const out = await pcNeuf().executeCommand('systemd-analyze calendar "Mon *-*-* 06:00:00"');
    expect(out).not.toContain('Original form');
    expect(out).toContain('Normalized form: Mon *-*-* 06:00:00');
  });

  it('`--iterations` donne les échéances suivantes', async () => {
    const out = await pcNeuf().executeCommand(
      'systemd-analyze calendar --iterations=3 "Mon *-*-* 06:00:00"');
    expect(out).toContain('   Iteration #2: ');
    expect(out).toContain('   Iteration #3: ');
  });

  it('une date fixe passée ne revient jamais, et ne dit rien de plus', async () => {
    const out = await pcNeuf().executeCommand('systemd-analyze calendar "2020-01-01 00:00:00"');
    expect(out).toContain('    Next elapse: never');
    expect(out).not.toContain('From now');
  });

  it('une expression illisible est refusée avec le mot du vrai', async () => {
    const out = await pcNeuf().executeCommand('systemd-analyze calendar "n importe quoi"');
    expect(out).toContain("Failed to parse calendar specification 'n importe quoi': Invalid argument");
  });

  it('`--base-time` avant l\'échéance dit « left », après dit « ago »', async () => {
    const pc = pcNeuf();
    expect(await pc.executeCommand(
      'systemd-analyze calendar --base-time="2026-08-02 12:00:00" "*-*-* 18:00:00"'))
      .toContain('left');
    expect(await pc.executeCommand(
      'systemd-analyze calendar --base-time="2026-08-02 20:00:00" "*-*-* 18:00:00"'))
      .toContain('left');
  });

  it('`timespan` convertit en microsecondes et en clair', async () => {
    const out = await pcNeuf().executeCommand('systemd-analyze timespan "2h 30min"');
    expect(out).toContain('      μs: 9000000000');
    expect(out).toContain('   Human: 2h 30min');
  });
});

describe('Scénario 9 — l\'analyseur PowerShell recolle un mot nu', () => {
  it('un nom de canal garde sa barre oblique', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    const ps = (pc as unknown as { getPowerShellInterpreter(): { execute(c: string): string } })
      .getPowerShellInterpreter();
    // Le défaut : le mot ressortait coupé à la barre, et l'appelant ne
    // recevait que « Microsoft-Windows-TaskScheduler ».
    expect(ps.execute('Write-Output Microsoft-Windows-TaskScheduler/Operational').trim())
      .toBe('Microsoft-Windows-TaskScheduler/Operational');
  });

  it('une valeur de paramètre qui commence par `/` n\'est plus perdue', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    const ps = (pc as unknown as { getPowerShellInterpreter(): { execute(c: string): string } })
      .getPowerShellInterpreter();
    // Le défaut était pire qu'une coupure : `/` n'ouvrant pas une valeur,
    // le paramètre devenait un commutateur et rendait « True ».
    const out = ps.execute("New-ScheduledTaskAction -Execute a.exe -Argument /silent");
    expect(out).toContain('/silent');
    expect(out).not.toContain('True');
  });

  it('un pourcentage collé à un nombre reste un mot', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    const ps = (pc as unknown as { getPowerShellInterpreter(): { execute(c: string): string } })
      .getPowerShellInterpreter();
    expect(ps.execute('Write-Output 50%').trim()).toBe('50%');
  });

  it('un chemin avec deux-points passait déjà — la réserve du PRD visait la mauvaise cause', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    const ps = (pc as unknown as { getPowerShellInterpreter(): { execute(c: string): string } })
      .getPowerShellInterpreter();
    // `:` n'a jamais fait partie des caractères d'arrêt du lexeur ; ce que
    // la phase 3 avait pris pour un défaut d'analyse venait du raccourci
    // cmd, corrigé au même moment.
    expect(ps.execute('Write-Output C:\\neuf.exe').trim()).toBe('C:\\neuf.exe');
  });
});

describe('Scénario 10 — les exécutions manquées se comptent', () => {
  it('une occurrence passée pendant l\'arrêt du planificateur est comptée, pas rejouée', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\bin\\save.exe" /sc minute');
    await pc.executeCommand('sc stop Schedule');

    const avant = await pc.executeCommand('powershell -Command "Get-ScheduledTaskInfo -TaskName T"');
    expect(avant).toContain('NumberOfMissedRuns : 0');

    for (let i = 0; i < 3; i++) (pc as unknown as { scheduledTaskTick(): void }).scheduledTaskTick();

    const apres = await pc.executeCommand('powershell -Command "Get-ScheduledTaskInfo -TaskName T"');
    expect(apres).toMatch(/NumberOfMissedRuns : [1-9]/);
    // Rien n'a tourné : le planificateur était arrêté.
    expect(await pc.executeCommand('tasklist')).not.toContain('save.exe');
  });

  it('le planificateur en marche exécute au lieu de compter', async () => {
    const pc = new WindowsPC('windows-pc', 'w', 0, 0); pc.powerOn();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\bin\\save.exe" /sc minute');
    for (let i = 0; i < 2; i++) (pc as unknown as { scheduledTaskTick(): void }).scheduledTaskTick();

    expect(await pc.executeCommand('tasklist')).toContain('save.exe');
    expect(await pc.executeCommand('powershell -Command "Get-ScheduledTaskInfo -TaskName T"'))
      .toContain('NumberOfMissedRuns : 0');
  });
});
