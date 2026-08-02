/**
 * §F5.2 — ce qu'un `kill -9` laisse derrière lui, et ce qu'il ne laisse pas.
 *
 * Un `systemctl stop` demande poliment au démon de partir, et le démon
 * range : il efface son fichier PID. Un `kill -9` ne lui laisse rien
 * exécuter du tout — le fichier survit au processus, et pointe désormais
 * sur un pid mort. C'est toute la différence entre les deux.
 *
 * Rien de tout ça n'était modélisé : `/run` ne contenait aucun fichier PID,
 * ni avant ni après un `kill`, donc le TP n'avait aucun résidu à trouver.
 * `service/RuntimeArtifacts.ts` déclare désormais, par service, les
 * fichiers que le démon crée en tournant — le pendant exact de
 * `CriticalFiles.ts`, qui déclare ceux dont il ne peut pas se passer.
 *
 * ── La correction que ce fichier apporte au PRD ───────────────────────
 *
 * Le PRD annonçait qu'après un `kill -9` « la relance doit échouer tant
 * qu'on ne nettoie pas ». C'est un mythe sur une machine systemd moderne,
 * et le simuler apprendrait le contraire du réel :
 *
 *   - le **port** est libéré par le noyau à la mort du processus, donc pas
 *     d'`address already in use` — vérifié sur cette plateforme, le 22
 *     disparaît de `ss -ltn` puis revient ;
 *   - un **verrou `flock()`** meurt avec son détenteur, donc un fichier PID
 *     périmé n'empêche rien ;
 *   - une **`RuntimeDirectory=`** est effacée par systemd dès que l'unité
 *     quitte l'état actif, échec compris.
 *
 * Le résidu est donc réel, visible et trompeur — mais il ne bloque rien.
 * C'est ça, la leçon : l'opérateur qui accuse le fichier PID périmé se
 * trompe de coupable. Les deux comportements sont testés côte à côte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SSHD_PID = '/run/sshd.pid';
const F2B_DIR = '/run/fail2ban';
const F2B_SOCK = '/run/fail2ban/fail2ban.sock';
const F2B_PID = '/run/fail2ban/fail2ban.pid';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** Un serveur : son terminal est root, donc pas de `sudo` à intercaler. */
function box(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'SRV');
  srv.powerOn();
  return srv;
}

/** Le pid du processus principal d'un service, lu dans `ps`. */
async function pidOf(srv: LinuxServer, exe: string): Promise<string> {
  const ps = await srv.executeCommand('ps aux');
  const line = ps.split('\n').find((l) => l.trimEnd().endsWith(exe));
  expect(line, `aucun processus ${exe} dans ps`).toBeDefined();
  return line!.trim().split(/\s+/)[1];
}

/** Le pid vit-il encore ? */
async function alive(srv: LinuxServer, pid: string): Promise<boolean> {
  const ps = await srv.executeCommand('ps aux');
  return ps.split('\n').some((l) => l.trim().split(/\s+/)[1] === pid);
}

describe('un démon qui tourne a ses fichiers d\'exécution', () => {
  it('`/run/sshd.pid` existe et nomme le processus que `ps` montre', async () => {
    const srv = box();

    const pid = await pidOf(srv, '/usr/sbin/sshd -D');
    // Une seule vérité sur le pid : le fichier et `ps` doivent tomber
    // d'accord, sinon le résidu ne se distingue pas d'un fichier normal.
    expect((await srv.executeCommand(`cat ${SSHD_PID}`)).trim()).toBe(pid);
  });

  it('`at` nomme un fichier qui existe vraiment pendant qu\'atd tourne', async () => {
    const srv = box();

    // `at` répond « Can't open /var/run/atd.pid … » quand le démon est
    // absent. Tant que ce fichier n'existait nulle part, le message était
    // une chaîne plausible ; il décrit maintenant un vrai fichier.
    expect((await srv.executeCommand('cat /var/run/atd.pid')).trim())
      .toBe(await pidOf(srv, '/usr/sbin/atd -f'));
  });

  it('les directives sont celles que Debian porte vraiment', async () => {
    const srv = box();

    const ssh = await srv.executeCommand('cat /usr/lib/systemd/system/ssh.service');
    expect(ssh).toContain(`PIDFile=${SSHD_PID}`);
    // sshd écrit à même /run : rien ne nettoiera derrière lui.
    expect(ssh).not.toContain('RuntimeDirectory=');

    const f2b = await srv.executeCommand('cat /usr/lib/systemd/system/fail2ban.service');
    expect(f2b).toContain('RuntimeDirectory=fail2ban');

    // cron écrit bien un fichier PID, mais son unité ne le déclare pas :
    // systemd suit le processus lui-même.
    expect(await srv.executeCommand('cat /usr/lib/systemd/system/cron.service'))
      .not.toContain('PIDFile=');
    expect(await srv.executeCommand('cat /run/crond.pid')).not.toContain('No such file');
  });
});

describe('un arrêt propre range derrière lui', () => {
  it('`systemctl stop` efface le fichier PID', async () => {
    const srv = box();
    expect(await srv.executeCommand(`ls ${SSHD_PID}`)).toContain(SSHD_PID);

    await srv.executeCommand('systemctl stop ssh');

    expect(await srv.executeCommand(`ls ${SSHD_PID}`))
      .toContain('No such file or directory');
  });

  it('atd arrêté : le fichier que `at` nomme a bien disparu', async () => {
    const srv = box();
    await srv.executeCommand('systemctl stop atd');

    expect(await srv.executeCommand('ls /var/run/atd.pid'))
      .toContain('No such file or directory');
    // Et `at` dit exactement ça.
    expect(await srv.executeCommand('echo "ls" | at now + 1 hour'))
      .toContain("Can't open /var/run/atd.pid to signal atd. No atd running?");
  });
});

describe('§F5.2 — un `kill -9` ne range rien', () => {
  it('le fichier PID survit au processus et nomme un pid MORT', async () => {
    const srv = box();
    const pid = await pidOf(srv, '/usr/sbin/sshd -D');

    await srv.executeCommand(`kill -9 ${pid}`);

    // La fenêtre où la panne se voit : avant que `Restart=` ne relance.
    // C'est ce qui rend le résidu trompeur — le fichier a l'air normal.
    expect((await srv.executeCommand(`cat ${SSHD_PID}`)).trim()).toBe(pid);
    expect(await alive(srv, pid)).toBe(false);
  });

  it('un arrêt propre l\'aurait effacé — c\'est toute la différence', async () => {
    const srv = box();

    await srv.executeCommand('systemctl stop ssh');
    expect(await srv.executeCommand(`ls ${SSHD_PID}`)).toContain('No such file');

    await srv.executeCommand('systemctl start ssh');
    const pid = await pidOf(srv, '/usr/sbin/sshd -D');
    await srv.executeCommand(`kill -9 ${pid}`);

    // Même service, même fichier, deux morts différentes.
    expect(await srv.executeCommand(`ls ${SSHD_PID}`)).toContain(SSHD_PID);
  });
});

describe('§F5.2 — `RuntimeDirectory=` : systemd nettoie ce que le démon n\'a pas pu', () => {
  it('rien de fail2ban ne survit au `kill -9`', async () => {
    const srv = box();
    const pid = await pidOf(srv, '/usr/bin/fail2ban-server -xf start');
    expect(await srv.executeCommand(`ls ${F2B_SOCK}`)).toContain(F2B_SOCK);

    await srv.executeCommand(`kill -9 ${pid}`);

    // Le démon n'a rien pu ranger, mais le répertoire ne lui appartient
    // pas : systemd l'efface dès que l'unité quitte l'état actif.
    expect(await srv.executeCommand(`ls ${F2B_DIR}`))
      .toContain('No such file or directory');
  });

  it('deux démons, un seul `kill -9`, deux résultats opposés', async () => {
    const srv = box();
    const sshPid = await pidOf(srv, '/usr/sbin/sshd -D');
    const f2bPid = await pidOf(srv, '/usr/bin/fail2ban-server -xf start');

    await srv.executeCommand(`kill -9 ${sshPid}`);
    await srv.executeCommand(`kill -9 ${f2bPid}`);

    // Sans la directive modélisée, les deux se ressembleraient et le TP
    // apprendrait la mauvaise règle.
    expect(await srv.executeCommand(`ls ${SSHD_PID}`)).toContain(SSHD_PID);
    expect(await srv.executeCommand(`ls ${F2B_SOCK}`)).toContain('No such file');
  });
});

describe('§F5.2 — un résidu ne bloque rien, et c\'est la leçon', () => {
  it('ssh revient tout seul et réécrit son fichier avec le NOUVEAU pid', async () => {
    const srv = box();
    const before = await pidOf(srv, '/usr/sbin/sshd -D');

    await srv.executeCommand(`kill -9 ${before}`);
    await wait(400); // RestartSec

    // Le reliquat n'a rien empêché : sshd le réécrit. Croire l'inverse
    // est l'erreur de diagnostic classique que ce scénario doit lever.
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    const after = await pidOf(srv, '/usr/sbin/sshd -D');
    expect(after).not.toBe(before);
    expect((await srv.executeCommand(`cat ${SSHD_PID}`)).trim()).toBe(after);
  });

  it('même un fichier PID inventé de toutes pièces ne gêne pas', async () => {
    const srv = box();
    await srv.executeCommand('systemctl stop ssh');
    await srv.executeCommand(`sh -c "echo 99999 > ${SSHD_PID}"`);

    // Un vrai sshd écrase ce fichier sans discuter. Refuser de démarrer
    // ici serait une invention, pas une panne.
    expect(await srv.executeCommand('systemctl start ssh')).toBe('');
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect((await srv.executeCommand(`cat ${SSHD_PID}`)).trim())
      .toBe(await pidOf(srv, '/usr/sbin/sshd -D'));
  });

  it('le port aussi est rendu : le noyau ferme ce que le processus tenait', async () => {
    const srv = box();
    const pid = await pidOf(srv, '/usr/sbin/sshd -D');

    await srv.executeCommand(`kill -9 ${pid}`);
    expect(await srv.executeCommand('ss -ltn')).not.toContain('0.0.0.0:22');

    await wait(400);

    // Donc pas d'`address already in use` à la relance : le port est libre.
    expect(await srv.executeCommand('ss -ltn')).toContain('0.0.0.0:22');
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('au démarrage, aucun fichier ne ment', async () => {
    const srv = box();

    expect((await srv.executeCommand('systemctl is-active fail2ban')).trim()).toBe('active');
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect(await alive(srv, (await srv.executeCommand(`cat ${F2B_PID}`)).trim())).toBe(true);
    expect(await alive(srv, (await srv.executeCommand(`cat ${SSHD_PID}`)).trim())).toBe(true);
  });
});
