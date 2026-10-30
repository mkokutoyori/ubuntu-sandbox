/**
 * `tree -a` (Linux) ne liste jamais `.` ni `..`, et un lien symbolique est
 * montré `nom -> cible` sans être suivi.
 *
 * Mesuré avant le correctif : sur un serveur Linux neuf, `tree -a` rendait
 * `RangeError: Maximum call stack size exceeded`. Le VFS renvoie `.` et `..`
 * parmi les entrées d'un répertoire ; sans `-a` leur nom commence par un
 * point et `visible()` les cache, mais AVEC `-a` ils passaient pour de vrais
 * sous-répertoires, et `tree` descendait dans `/tmp/./././…` sans fin. Le
 * nombre d'entrées vues à la profondeur L croissait d'un facteur ~8 par
 * niveau (190, 1 250, 10 477, 70 690, 558 677 pour L2 à L6), et `/tmp`,
 * vide, en annonçait 11 942 à L5.
 *
 * Autorité : le code de tree 2.1.1 (Old-Man-Programmer/tree, cloné), pas
 * une supposition — `tree.c:985` : « if (!strcmp("..",ent->d_name) ||
 * !strcmp(".",ent->d_name)) continue; » avant même le test de `-a` ; et
 * `unix.c` imprime « -> » puis la cible d'un lien (`file->lnk`), le lien
 * n'étant suivi qu'avec `-l` (`tree.c:873`).
 *
 * Discrimination par `git stash` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'Server1');
  srv.powerOn();
  return srv;
}

async function labo(srv: LinuxServer): Promise<void> {
  await srv.executeCommand('mkdir -p /srv/t/sub');
  await srv.executeCommand('touch /srv/t/.cache /srv/t/sub/f.txt /srv/t/sub/.env');
}

describe('tree -a', () => {
  it('liste les fichiers cachés mais ni « . » ni « .. »', async () => {
    const srv = machine();
    await labo(srv);
    expect(await srv.executeCommand('tree -a /srv/t')).toBe([
      '/srv/t',
      '|-- .cache',
      '`-- sub',
      '    |-- .env',
      '    `-- f.txt',
      '',
      '2 directories, 3 files',
    ].join('\n'));
  });

  it('sans -a, les fichiers cachés restent masqués (témoin)', async () => {
    const srv = machine();
    await labo(srv);
    expect(await srv.executeCommand('tree /srv/t')).toBe([
      '/srv/t',
      '`-- sub',
      '    `-- f.txt',
      '',
      '2 directories, 1 file',
    ].join('\n'));
  });

  it('tree -a / se termine, avec un décompte, au lieu de lever RangeError', async () => {
    const srv = machine();
    const out = await srv.executeCommand('tree -a /');
    expect(out).not.toContain('RangeError');
    expect(out).not.toContain('Maximum call stack');
    expect(out).toMatch(/\n\d+ directories, \d+ files$/);
  });

  it('tree -a du répertoire courant (« tree -a » nu) se termine aussi', async () => {
    const srv = machine();
    const out = await srv.executeCommand('tree -a');
    expect(out).not.toContain('RangeError');
    expect(out).toMatch(/\d+ director(y|ies), \d+ files?$/);
  });

  it('aucune ligne ne porte « . » ou « .. » comme entrée', async () => {
    const srv = machine();
    const out = await srv.executeCommand('tree -a /etc');
    const names = out.split('\n').map((line) => line.replace(/^[| `-]+/, ''));
    expect(names).not.toContain('.');
    expect(names).not.toContain('..');
  });

  it('un lien vers le répertoire parent est montré « nom -> cible » et n\'est pas suivi', async () => {
    const srv = machine();
    await srv.executeCommand('mkdir -p /srv/loop');
    await srv.executeCommand('ln -s .. /srv/loop/up');
    const out = await srv.executeCommand('tree -a /srv/loop');
    expect(out).toBe(['/srv/loop', '`-- up -> ..', '', '1 directory, 1 file'].join('\n'));
  });
});
