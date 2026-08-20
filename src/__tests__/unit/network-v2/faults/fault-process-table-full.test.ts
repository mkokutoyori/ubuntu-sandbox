/**
 * §F5.8 — la table des processus est pleine.
 *
 * `ulimit` était une table de dix-huit lignes codées en dur dans le switch
 * de `LinuxCommandExecutor` : la valeur `max user processes (-u) 15730`
 * était AFFICHÉE et jamais consultée, et `ulimit -u 5` ne faisait rien du
 * tout. Même motif que `df` avant §F9.1 — un plafond qui vit dans la
 * commande qui l'affiche plutôt que dans le système qui devrait le faire
 * respecter.
 *
 * Deux règles de fidélité portent le scénario, et toutes deux décident si
 * la panne est réparable :
 *
 *   - **Le comptage est par UID réel, sur toute la machine**, pas par
 *     shell. C'est `RLIMIT_NPROC`, et c'est ce qui fait qu'une fork bomb
 *     d'un utilisateur laisse les autres — et root — travailler. Compter
 *     par shell donnerait une machine qu'on ne peut plus sauver.
 *   - **root en est exempt**, parce que le noyau saute le contrôle pour qui
 *     détient `CAP_SYS_RESOURCE`/`CAP_SYS_ADMIN` (`kernel/fork.c`). C'est
 *     exactement ce qui laisse un administrateur reprendre la main.
 *
 * Et, comme le PRD l'exige : **aucune fork bomb n'est simulée**. On abaisse
 * le plafond et on refuse — le navigateur n'a rien à ramer.
 *
 * Le message est celui de bash, avec ses quatre tentatives : c'est cette
 * répétition qui fait reconnaître la panne sur une vraie machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** Une machine dont le terminal s'ouvre en utilisateur non privilégié. */
function userBox(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

/** Une machine dont le terminal s'ouvre en root. */
function rootBox(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'SRV');
  srv.powerOn();
  return srv;
}

const EAGAIN = 'bash: fork: Resource temporarily unavailable';

describe('`ulimit -u` est une vraie limite, pas un affichage', () => {
  it('la valeur par défaut est celle qu\'affichait déjà la commande', async () => {
    const pc = userBox();

    expect((await pc.executeCommand('ulimit -u')).trim()).toBe('15730');
  });

  it('l\'abaisser change ce que la commande répond', async () => {
    const pc = userBox();

    await pc.executeCommand('ulimit -u 5');

    expect((await pc.executeCommand('ulimit -u')).trim()).toBe('5');
  });

  it('`ulimit -a` dit la même chose que `ulimit -u`', async () => {
    const pc = userBox();
    await pc.executeCommand('ulimit -u 42');

    // Deux lectures d'une seule limite : elles ne doivent pas pouvoir
    // diverger, comme `sc qc` et `reg query` côté Windows.
    expect(await pc.executeCommand('ulimit -a'))
      .toContain('max user processes              (-u) 42');
  });

  it('un utilisateur remonte sa limite souple jusqu\'à la dure', async () => {
    const pc = userBox();
    await pc.executeCommand('ulimit -u 5');

    // C'est la vraie règle POSIX : la souple circule librement sous la
    // dure. La modéliser autrement rendrait la panne irréparable là où
    // elle ne l'est pas.
    expect(await pc.executeCommand('ulimit -u 100')).toBe('');
    expect((await pc.executeCommand('ulimit -u')).trim()).toBe('100');
  });

  it('mais jamais au-dessus de la limite dure', async () => {
    const pc = userBox();

    expect(await pc.executeCommand('ulimit -u 99999'))
      .toContain('cannot modify limit: Operation not permitted');
  });

  it('une valeur absurde est refusée sans rien changer', async () => {
    const pc = userBox();

    expect(await pc.executeCommand('ulimit -u abc')).toContain('invalid number');
    expect((await pc.executeCommand('ulimit -u')).trim()).toBe('15730');
  });
});

describe('§F5.8 — au plafond, le fork échoue vraiment', () => {
  it('`cmd &` répond le transcript de bash et ne lance rien', async () => {
    const pc = userBox();
    await pc.executeCommand('ulimit -u 1');

    const out = await pc.executeCommand('sleep 100 &');

    expect(out).toContain(EAGAIN);
    // bash réessaie quatre fois avant d'abandonner : c'est cette
    // répétition qui fait reconnaître la panne.
    expect(out.split('retry:').length - 1).toBe(4);
    // Et aucun job n'a été annoncé.
    expect(out).not.toMatch(/\[\d+\]\s+\d+/);
  });

  it('le processus refusé n\'apparaît nulle part', async () => {
    const pc = userBox();
    await pc.executeCommand('ulimit -u 1');

    await pc.executeCommand('sleep 12345 &');

    expect(await pc.executeCommand('ps aux')).not.toContain('sleep 12345');
  });

  it('relever la limite souple remet la machine en état de forker', async () => {
    const pc = userBox();
    await pc.executeCommand('ulimit -u 1');
    expect(await pc.executeCommand('sleep 100 &')).toContain(EAGAIN);

    // La réparation compte autant que la panne (PRD §P4). `ulimit` est un
    // BUILTIN du shell : `sudo ulimit` n'existe pas, l'opérateur remonte sa
    // propre limite souple sous le plafond dur.
    await pc.executeCommand('ulimit -u 500');

    const out = await pc.executeCommand('sleep 100 &');
    expect(out).toMatch(/\[\d+\]\s+\d+/);
    expect(out).not.toContain(EAGAIN);
  });
});

describe('§F5.8 — root n\'est pas concerné, et c\'est ce qui sauve la machine', () => {
  it('root forke même avec une limite à 1', async () => {
    const srv = rootBox();
    await srv.executeCommand('ulimit -u 1');

    // `CAP_SYS_RESOURCE` : le noyau saute le contrôle. Sans ça, une fork
    // bomb rendrait la machine irrécupérable.
    expect(await srv.executeCommand('sleep 100 &')).toMatch(/\[\d+\]\s+\d+/);
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('les jobs d\'arrière-plan partent normalement', async () => {
    const pc = userBox();

    const out = await pc.executeCommand('sleep 100 &');

    expect(out).toMatch(/\[\d+\]\s+\d+/);
    expect(out).not.toContain('Resource temporarily unavailable');
  });
});
