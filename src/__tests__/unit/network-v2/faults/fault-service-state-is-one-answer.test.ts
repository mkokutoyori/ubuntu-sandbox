/**
 * Un service a UN état, et toutes les commandes qui l'interrogent doivent
 * en donner le même.
 *
 * En parcourant les familles F5 (processus) et F6 (services) de
 * docs/PRD-Pannes.md, deux contradictions sont apparues sur la même
 * machine, au même instant :
 *
 *   - `systemctl is-active atd` répondait `inactive` pendant que
 *     `systemctl is-failed atd` répondait `active`. `is-failed` ne
 *     regardait qu'une chose — « est-ce `failed` ? » — et imprimait
 *     `active` pour tout le reste. Le vrai `is-failed` imprime l'état
 *     d'activation de l'unité et ne sort 0 que s'il vaut `failed`.
 *   - `systemctl status ssh` annonçait `Main PID: 22 (ssh)` — le nom de
 *     l'UNITÉ — alors que `ps` sur la même machine montrait
 *     `/usr/sbin/sshd -D`. systemd imprime le nom du processus principal.
 *
 * Ce que ce fichier vérifie AUSSI, parce que ça n'allait pas de soi : les
 * mécanismes de F5 sont bien réels. Un `kill -9` sur le processus
 * principal est vu par le superviseur, `Restart=on-failure` se déclenche
 * pour de vrai après `RestartSec`, et le service revient avec un NOUVEAU
 * pid — pas le même processus ressuscité.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function box(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

/** Le pid du processus principal d'un service, lu dans `ps`. */
async function pidOf(pc: LinuxPC, exe: string): Promise<string | undefined> {
  const ps = await pc.executeCommand('ps aux');
  return ps.split('\n').find((l) => l.includes(exe))?.trim().split(/\s+/)[1];
}

describe('`is-active` et `is-failed` parlent de la même unité', () => {
  it('un service arrêté est `inactive` pour les deux', async () => {
    const pc = box();
    await pc.executeCommand('sudo systemctl stop atd');

    expect((await pc.executeCommand('systemctl is-active atd')).trim()).toBe('inactive');
    // Répondre `active` ici — ce qu'il faisait — contredisait la ligne
    // du dessus sur la même machine, au même instant.
    expect((await pc.executeCommand('systemctl is-failed atd')).trim()).toBe('inactive');
  });

  it('un service qui tourne est `active` pour les deux', async () => {
    const pc = box();

    expect((await pc.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect((await pc.executeCommand('systemctl is-failed ssh')).trim()).toBe('active');
  });

  it('une unité inconnue est `inactive`, pas `active`', async () => {
    const pc = box();

    expect((await pc.executeCommand('systemctl is-failed nexistepas')).trim())
      .toBe('inactive');
  });
});

describe('`systemctl status` nomme le processus, pas l\'unité', () => {
  it('`Main PID` porte le nom que `ps` montre', async () => {
    const pc = box();

    const status = await pc.executeCommand('systemctl status ssh');
    const pid = await pidOf(pc, '/usr/sbin/sshd -D');

    expect(status).toContain(`Main PID: ${pid} (sshd)`);
    // Et pas le nom de l'unité, qui est `ssh`.
    expect(status).not.toContain(`(ssh)`);
  });

  it('cron aussi — le nom vient de son propre `ExecStart`', async () => {
    const pc = box();

    expect(await pc.executeCommand('systemctl status cron'))
      .toMatch(/Main PID: \d+ \(cron\)/);
  });
});

describe('F5 — un kill -9 est vu, et `Restart=` se déclenche vraiment', () => {
  it('le service revient avec un NOUVEAU pid', async () => {
    const pc = box();
    const before = await pidOf(pc, '/usr/sbin/sshd -D');

    await pc.executeCommand(`sudo kill -9 ${before}`);
    // Juste après, systemd annonce le redémarrage programmé — c'est ce
    // que dit un vrai `systemctl status` entre la mort et la relance.
    expect(await pc.executeCommand('systemctl status ssh'))
      .toContain('activating (auto-restart)');
    expect(await pc.executeCommand('systemctl status ssh'))
      .toContain('code=killed, signal=KILL');

    await wait(400); // RestartSec

    const after = await pidOf(pc, '/usr/sbin/sshd -D');
    expect((await pc.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect(after).toBeDefined();
    // Un service relancé est un processus NEUF : le même pid signifierait
    // que rien n'est mort.
    expect(after).not.toBe(before);
  });
});
