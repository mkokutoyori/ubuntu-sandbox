/**
 * Scénario 4 — Commandes d'identité : id, whoami, groups, et cohérence
 * des identités.
 *
 * `id`/`whoami`/`groups` doivent être cohérents entre eux et avec
 * /etc/passwd et /etc/group, aussi bien en session normale qu'après
 * `su`/`sudo -u`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let srv: LinuxServer;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  await run('useradd -m -s /bin/bash user-admin');
  await run('groupadd mandeng-ops');
  await run('usermod -aG sudo,mandeng-ops user-admin');
  await run('useradd -m -s /bin/bash user-reseau');
  await run('usermod -aG mandeng-ops user-reseau');
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('Scénario 4 — id / whoami / groups : cohérence des identités', () => {
  it('id -u <user> correspond exactement au champ 3 de /etc/passwd', async () => {
    for (const u of ['user-admin', 'user-reseau']) {
      const idUid = (await run(`id -u ${u}`)).trim();
      const passwdUid = (await run(`getent passwd ${u} | cut -d: -f3`)).trim();
      expect(idUid).toBe(passwdUid);
    }
  });

  it('id -g <user> correspond exactement au champ 4 de /etc/passwd', async () => {
    for (const u of ['user-admin', 'user-reseau']) {
      const idGid = (await run(`id -g ${u}`)).trim();
      const passwdGid = (await run(`getent passwd ${u} | cut -d: -f4`)).trim();
      expect(idGid).toBe(passwdGid);
    }
  });

  it('id -Gn liste exactement les groupes trouvés dans /etc/group plus le groupe primaire', async () => {
    const groupsFromId = (await run('id -Gn user-admin')).trim().split(/\s+/).sort();
    const secondaryFromEtcGroup = (await run("grep 'user-admin' /etc/group | cut -d: -f1"))
      .split('\n').filter(Boolean).sort();
    const primaryGroup = (await run(
      'getent group "$(getent passwd user-admin | cut -d: -f4)" | cut -d: -f1',
    )).trim();
    const expected = [...new Set([...secondaryFromEtcGroup, primaryGroup])].sort();
    expect(groupsFromId).toEqual(expected);
  });

  it('id complet (uid=..(name) gid=..(name) groups=...) est cohérent avec ses propres -u/-g/-G', async () => {
    const full = await run('id user-admin');
    const uid = (await run('id -u user-admin')).trim();
    const gid = (await run('id -g user-admin')).trim();
    expect(full).toContain(`uid=${uid}(user-admin)`);
    expect(full).toContain(`gid=${gid}(`);
    expect(full).toMatch(/groups=/);
  });

  it('whoami et id -un produisent toujours le même résultat', async () => {
    const whoami = (await run('su - user-admin -c "whoami"')).trim();
    const idUn = (await run('su - user-admin -c "id -un"')).trim();
    expect(whoami).toBe(idUn);
    expect(whoami).toBe('user-admin');
  });

  it('groups (sans argument) reflète les groupes de la session courante', async () => {
    const out = (await run('su - user-admin -c "groups"')).trim();
    expect(out).toContain('user-admin');
    expect(out).toContain('sudo');
    expect(out).toContain('mandeng-ops');
  });

  it('groups <user> affiche "user : groupes"', async () => {
    const out = await run('groups user-reseau');
    expect(out).toMatch(/^user-reseau : /);
    expect(out).toContain('mandeng-ops');
  });

  it('après sudo -u, id reflète l\'identité cible, pas l\'invoquant', async () => {
    const out = await run('sudo -u user-reseau id -un');
    expect(out.trim()).toBe('user-reseau');
  });

  it('id d\'un utilisateur inexistant renvoie une erreur explicite', async () => {
    const out = await run('id -u ghostuser');
    expect(out).toMatch(/no such user/);
  });

  it('id sans argument (session root par défaut) correspond à whoami', async () => {
    const idOut = (await run('id -un')).trim();
    const whoamiOut = (await run('whoami')).trim();
    expect(idOut).toBe(whoamiOut);
  });
});
