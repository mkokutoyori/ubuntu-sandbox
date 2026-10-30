/**
 * `journalctl -f` n'affiche chaque enregistrement qu'UNE fois.
 *
 * Mesuré avant le correctif : `LinuxMachine.followJournal` s'abonnait aux
 * nouveaux enregistrements et, pour CHACUN, relançait
 * `journalctl --after-cursor=<curseur de l'enregistrement PRÉCÉDENT>`. Quand
 * une commande écrit plusieurs enregistrements d'un coup (un redémarrage de
 * service en écrit plusieurs), le rappel du premier relit déjà tous les
 * suivants — ils sont stockés avant que les rappels ne s'exécutent — puis le
 * rappel du deuxième part du curseur du premier et les affiche une seconde
 * fois : n enregistrements en rafale donnaient jusqu'à n(n+1)/2 lignes.
 *
 * La première hypothèse (rappels qui se recouvrent) était FAUSSE : un rappel
 * s'exécute au moment où son enregistrement est ajouté, donc il n'en voit
 * jamais d'autre. Le suivi est exact, et le cas « ce que -f affiche est
 * exactement ce que journalctl montre » le garde ainsi. Les doublons que
 * `journalctl -f` montrait étaient DANS le journal, et `journalctl` seul les
 * montrait aussi :
 *  - `systemctl restart ssh` écrivait « Started ssh.service. » DEUX fois :
 *    `LinuxServiceManager.restart()` émet `stopped`, `started` puis
 *    `restarted`, et la projection journalisait « Started » pour `started`
 *    ET pour `restarted` ;
 *  - `systemctl start nginx` écrivait « Listening on TCP 0.0.0.0:80 » deux
 *    fois, avec un PID différent chacune : `ServicePortProjection` republiait
 *    `linux.port.bound` à chaque appel d'`openSockets` pour une écoute déjà
 *    inscrite (démarrage puis `reloaded`, `restarted`), et la réinscrivait
 *    dans son registre.
 * systemd, lui, n'écrit qu'un « Started » par activation.
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

function followed(srv: LinuxServer, args: string[] = []): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = srv.followJournal(args, (line) => lines.push(line));
  return { lines, stop };
}

const duplicates = (lines: readonly string[]): string[] =>
  lines.filter((line, index) => lines.indexOf(line) !== index);

describe('journalctl -f', () => {
  it('une rafale d\'enregistrements ne produit aucun doublon', async () => {
    const srv = machine();
    const { lines, stop } = followed(srv);
    await srv.executeCommand('systemctl restart ssh');
    stop();
    expect(lines.length).toBeGreaterThan(1);
    expect(duplicates(lines)).toEqual([]);
  });

  it('ce que -f affiche est exactement ce que journalctl montre ensuite, dans l\'ordre', async () => {
    const srv = machine();
    const before = (await srv.executeCommand('journalctl --no-pager -q')).split('\n').filter(Boolean).length;
    const { lines, stop } = followed(srv);
    await srv.executeCommand('systemctl restart ssh');
    stop();
    const all = (await srv.executeCommand('journalctl --no-pager -q')).split('\n').filter(Boolean);
    expect(lines).toEqual(all.slice(before));
  });

  it('un enregistrement isolé est affiché une fois (témoin)', async () => {
    const srv = machine();
    const { lines, stop } = followed(srv);
    await srv.executeCommand('logger -t probe un-seul');
    stop();
    expect(lines.filter((l) => l.includes('un-seul'))).toHaveLength(1);
  });

  it('plusieurs commandes de suite : chaque ligne une fois, rien de perdu', async () => {
    const srv = machine();
    const { lines, stop } = followed(srv);
    await srv.executeCommand('logger -t probe alpha');
    await srv.executeCommand('logger -t probe bravo');
    await srv.executeCommand('logger -t probe charlie');
    stop();
    for (const word of ['alpha', 'bravo', 'charlie']) {
      expect(lines.filter((l) => l.includes(word)), word).toHaveLength(1);
    }
  });

  it('un filtre qui masque les enregistrements ne fait pas réapparaître les anciens', async () => {
    const srv = machine();
    const { lines, stop } = followed(srv, ['-t', 'probe']);
    await srv.executeCommand('logger -t autre ignoré');
    await srv.executeCommand('logger -t probe visible');
    stop();
    expect(lines.filter((l) => l.includes('visible'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('ignoré'))).toBe(false);
  });

  it('après stop(), plus aucune ligne', async () => {
    const srv = machine();
    const { lines, stop } = followed(srv);
    stop();
    await srv.executeCommand('logger -t probe tardif');
    expect(lines).toEqual([]);
  });
});

describe('le journal lui-même ne doublonne pas', () => {
  const count = (text: string, needle: string): number => text.split('\n').filter((l) => l.includes(needle)).length;

  it('systemctl restart ssh : un « Stopped » et un « Started », pas deux', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl restart ssh');
    const out = await srv.executeCommand('journalctl --no-pager -q -u ssh');
    expect(count(out, 'Started ssh.service.')).toBe(1);
    expect(count(out, 'Stopped ssh.service.')).toBe(1);
  });

  it('systemctl start nginx : une seule ligne « Listening on TCP 0.0.0.0:80 »', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    const out = await srv.executeCommand('journalctl --no-pager -q');
    expect(count(out, 'Listening on TCP 0.0.0.0:80')).toBe(1);
    expect(count(out, 'Started nginx.service.')).toBe(1);
  });

  it('systemctl reload nginx n\'ajoute aucune ligne d\'écoute', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    await srv.executeCommand('systemctl reload nginx');
    const after = await srv.executeCommand('journalctl --no-pager -q');
    expect(count(after, 'Listening on TCP 0.0.0.0:80')).toBe(1);
    expect(count(after, 'Reloaded nginx.service.')).toBe(1);
    expect(count(after, 'Closed TCP listening socket 0.0.0.0:80')).toBe(0);
  });

  it('systemctl restart nginx : un arrêt, un démarrage, une écoute par cycle', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    await srv.executeCommand('systemctl restart nginx');
    const out = await srv.executeCommand('journalctl --no-pager -q -u nginx');
    expect(count(out, 'Stopped nginx.service.')).toBe(1);
    expect(count(out, 'Started nginx.service.')).toBe(2);
    expect(count(out, 'Listening on TCP 0.0.0.0:80')).toBe(2);
  });

  it('arrêt puis démarrage : l\'écoute est de nouveau annoncée (témoin : le registre se vide au stop)', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    await srv.executeCommand('systemctl stop nginx');
    await srv.executeCommand('systemctl start nginx');
    const out = await srv.executeCommand('journalctl --no-pager -q -u nginx');
    expect(count(out, 'Listening on TCP 0.0.0.0:80')).toBe(2);
  });
});

