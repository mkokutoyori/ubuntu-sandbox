/**
 * §F5.9 — le OOM killer emporte un service qui dépasse `MemoryMax=`.
 *
 * Le PRD borne lui-même le modèle : « au niveau déclaratif […] **pas de
 * comptabilité mémoire réelle** ». Ce qui est comparé est donc le RSS que
 * le service déclare déjà — celui que `systemctl status` affiche et que
 * `ps` montre — au plafond qu'un opérateur pose avec une VRAIE commande,
 * `systemctl set-property`. Aucune allocation n'est simulée : on abaisse le
 * plafond sous la taille connue du démon, et la panne se produit.
 *
 * `MemoryMax=` était déjà parsé et validé par `set-property` — la valeur
 * était stockée, affichée par `systemctl show`, et rien ne la faisait
 * respecter. Troisième occurrence du même motif après `df` (§F9.1) et
 * `ulimit -u` (§F5.8) : un plafond qui vit dans la commande qui l'affiche.
 *
 * Deux points de fidélité :
 *
 *   - **L'ordre.** Le service DÉMARRE, puis le noyau le tue. Ce n'est pas
 *     un démarrage refusé : sur un vrai système le processus a existé, et
 *     c'est pourquoi `Main PID` porte un pid mort plutôt que rien.
 *   - **`oom-kill` est un résultat systemd distinct**, pas `exit-code` ni
 *     `signal` : c'est ce mot qui envoie l'opérateur regarder la mémoire
 *     plutôt que la configuration.
 *
 * C'est aussi ici qu'`ENOMEM` trouve sa place, laissée ouverte en §F5.8 :
 * la mémoire épuisée et la table des processus pleine (`EAGAIN`) sont deux
 * pannes différentes, et le simulateur ne les confond pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { stripAnsi } from '@/terminal/core/OutputFormatter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { parseMemoryMax } from '@/network/devices/linux/LinuxServiceManager';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function box(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'SRV');
  srv.powerOn();
  return srv;
}

describe('`MemoryMax=` se lit comme systemd le lit', () => {
  it('les suffixes K/M/G donnent des kibioctets', () => {
    expect(parseMemoryMax('4096')).toBe(4096);
    expect(parseMemoryMax('4096K')).toBe(4096);
    expect(parseMemoryMax('8M')).toBe(8192);
    expect(parseMemoryMax('1G')).toBe(1024 * 1024);
  });

  it('`infinity` et l\'absence de valeur ne posent aucun plafond', () => {
    // Le défaut systemd : sans ça, toute machine intacte serait en panne.
    expect(parseMemoryMax('infinity')).toBeNull();
    expect(parseMemoryMax(undefined)).toBeNull();
  });
});

describe('§F5.9 — le plafond dépassé fait tuer le service', () => {
  it('le service passe `failed` avec le résultat `oom-kill`', async () => {
    const srv = box();
    await srv.executeCommand('systemctl set-property ssh MemoryMax=1M');

    await srv.executeCommand('systemctl restart ssh');

    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('failed');
    const status = await srv.executeCommand('systemctl status ssh');
    // `oom-kill` et pas `exit-code` : la cause est distincte.
    expect(stripAnsi(status)).toContain('Active: failed (Result: oom-kill)');
    expect(status).toContain('code=killed, signal=KILL');
  });

  it('le journal porte la ligne du noyau, avec le nom du processus', async () => {
    const srv = box();
    await srv.executeCommand('systemctl set-property ssh MemoryMax=1M');
    await srv.executeCommand('systemctl restart ssh');

    const journal = await srv.executeCommand('journalctl -u ssh -n 10');
    expect(journal).toMatch(/Out of memory: Killed process \d+ \(ssh\)/);
    expect(journal).toContain('anon-rss:');
  });

  it('le processus est bien mort — pas seulement déclaré mort', async () => {
    const srv = box();
    await srv.executeCommand('systemctl set-property ssh MemoryMax=1M');
    await srv.executeCommand('systemctl restart ssh');

    expect(await srv.executeCommand('ps aux')).not.toContain('/usr/sbin/sshd -D');
  });
});

describe('§F5.9 — la réparation compte autant que la panne', () => {
  it('relever le plafond fait repartir le service', async () => {
    const srv = box();
    await srv.executeCommand('systemctl set-property ssh MemoryMax=1M');
    await srv.executeCommand('systemctl restart ssh');
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('failed');

    await srv.executeCommand('systemctl set-property ssh MemoryMax=infinity');

    expect(await srv.executeCommand('systemctl restart ssh')).toBe('');
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('sans plafond posé, les services démarrent normalement', async () => {
    const srv = box();

    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect(await srv.executeCommand('systemctl status ssh')).not.toContain('oom-kill');
    expect(await srv.executeCommand('journalctl -u ssh -n 20')).not.toContain('Out of memory');
  });
});
