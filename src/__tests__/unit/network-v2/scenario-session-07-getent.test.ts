/**
 * Scénario 7 — getent : interrogation des bases de données NSS et
 * cohérence avec les fichiers.
 *
 * `getent passwd`/`group`/`shadow`/`hosts` doivent retourner des
 * résultats cohérents avec les fichiers sous-jacents et respecter les
 * codes de sortie glibc (0 succès, 2 clé introuvable).
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
  await run('usermod -aG mandeng-ops user-admin');
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('Scénario 7 — getent : NSS passwd/group/shadow/hosts', () => {
  it('getent passwd <user> correspond exactement à la ligne de /etc/passwd', async () => {
    const fromGetent = (await run('getent passwd user-admin')).trim();
    const fromPasswd = (await run('grep "^user-admin:" /etc/passwd')).trim();
    expect(fromGetent).toBe(fromPasswd);
  });

  it('getent passwd <uid> retourne le même résultat que getent passwd <nom>', async () => {
    const uid = (await run('id -u user-admin')).trim();
    const byName = (await run('getent passwd user-admin')).trim();
    const byUid = (await run(`getent passwd ${uid}`)).trim();
    expect(byUid).toBe(byName);
  });

  it('getent passwd (sans clé) énumère au moins autant de comptes que /etc/passwd', async () => {
    const getentCount = Number((await run('getent passwd | wc -l')).trim());
    const passwdCount = Number((await run('wc -l < /etc/passwd')).trim());
    expect(getentCount).toBeGreaterThanOrEqual(passwdCount);
  });

  it('getent passwd sur un compte inexistant retourne exit code 2', async () => {
    const out = await run('getent passwd compte_inexistant; echo "EXIT:$?"');
    expect(out).toContain('EXIT:2');
  });

  it('getent passwd sur un UID inexistant retourne exit code 2', async () => {
    const out = await run('getent passwd 99999; echo "EXIT:$?"');
    expect(out).toContain('EXIT:2');
  });

  it('getent group <name> correspond exactement à la ligne de /etc/group', async () => {
    const fromGetent = (await run('getent group mandeng-ops')).trim();
    const fromGroup = (await run('grep "^mandeng-ops:" /etc/group')).trim();
    expect(fromGetent).toBe(fromGroup);
  });

  it('getent group <gid> retourne le même résultat que getent group <nom>', async () => {
    const gid = (await run("getent group mandeng-ops | cut -d: -f3")).trim();
    const byName = (await run('getent group mandeng-ops')).trim();
    const byGid = (await run(`getent group ${gid}`)).trim();
    expect(byGid).toBe(byName);
  });

  it('getent group <name> liste les membres attendus dans le champ 4', async () => {
    const members = (await run('getent group mandeng-ops | cut -d: -f4')).trim();
    expect(members.split(',')).toContain('user-admin');
  });

  it('getent shadow <user> correspond exactement à la ligne de /etc/shadow (root)', async () => {
    const fromGetent = (await run('getent shadow user-admin')).trim();
    const fromShadow = (await run('grep "^user-admin:" /etc/shadow')).trim();
    expect(fromGetent).toBe(fromShadow);
  });

  it('getent hosts localhost résout vers 127.0.0.1', async () => {
    const out = await run('getent hosts localhost');
    expect(out).toMatch(/^127\.0\.0\.1\s+localhost/m);
  });

  it('getent hosts (sans clé) énumère les entrées cohérentes avec /etc/hosts', async () => {
    const out = await run('getent hosts');
    expect(out).toMatch(/127\.0\.0\.1\s+localhost/);
  });

  it('getent avec une base de données inconnue échoue proprement', async () => {
    const out = await run('getent bogusdb somekey; echo "EXIT:$?"');
    expect(out).not.toContain('EXIT:0');
  });
});
