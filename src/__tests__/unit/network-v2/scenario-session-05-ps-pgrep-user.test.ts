/**
 * Scénario 5 — Commandes de processus par utilisateur : ps, pgrep, et
 * filtrage par identité.
 *
 * `ps -u`/`ps -fu` et `pgrep -u` doivent filtrer correctement par
 * utilisateur, avec un comptage cohérent entre les deux commandes et
 * avec le champ Uid de /proc/<pid>/status.
 *
 * Note : comme le vrai `ps`, la colonne USER tronque les noms de plus de
 * 8 caractères ("user-admin" → "user-ad+") — les comparaisons d'identité
 * ici utilisent donc la colonne UID (numérique, jamais tronquée) plutôt
 * que le nom affiché.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let srv: LinuxServer;
let adminUid: string;
let reseauUid: string;
let lectureUid: string;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  await run('useradd -m -s /bin/bash user-admin');
  await run('useradd -m -s /bin/bash user-reseau');
  await run('useradd -m -s /bin/bash user-lecture');
  await run('su - user-admin -c "sleep 300 &"');
  await run('su - user-reseau -c "sleep 300 &"');
  await run('su - user-lecture -c "sleep 300 &"');
  adminUid = (await run('id -u user-admin')).trim();
  reseauUid = (await run('id -u user-reseau')).trim();
  lectureUid = (await run('id -u user-lecture')).trim();
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('Scénario 5 — ps / pgrep : filtrage par utilisateur', () => {
  it('ps -u <user> ne liste que les processus de cet utilisateur', async () => {
    const out = await run('ps -u user-admin --no-headers -o uid');
    const uids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(uids.length).toBeGreaterThan(0);
    for (const uid of uids) expect(uid).toBe(adminUid);
  });

  it('ps -fu <user> affiche UID/PID/PPID/CMD au format complet', async () => {
    const out = await run('ps -fu user-admin');
    expect(out).toMatch(/UID\s+PID\s+PPID/);
    expect(out).toMatch(/user-ad\+|user-admin/);
    expect(out).toMatch(/sleep 300/);
  });

  it('ps -u user1,user2,user3 combine plusieurs utilisateurs', async () => {
    const out = await run('ps -u user-admin,user-reseau,user-lecture -o uid --no-headers');
    const uids = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
    expect(uids).toEqual(new Set([adminUid, reseauUid, lectureUid]));
  });

  it('pgrep -u <user> retourne les PIDs de cet utilisateur uniquement', async () => {
    const out = await run('pgrep -u user-admin');
    const pids = out.split('\n').filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      const uid = (await run(`ps -p ${pid} -o uid --no-headers`)).trim();
      expect(uid).toBe(adminUid);
    }
  });

  it('pgrep -u <user> sleep filtre aussi par nom de commande', async () => {
    const out = await run('pgrep -u user-admin sleep');
    expect(out.trim().split('\n').filter(Boolean).length).toBeGreaterThan(0);
    const outWrong = await run('pgrep -u user-admin nonexistentcmd123');
    expect(outWrong.trim()).toBe('');
  });

  it('pgrep -u <user> -l affiche le nom du processus', async () => {
    const out = await run('pgrep -u user-admin -l');
    expect(out).toMatch(/^\d+\s+sleep/m);
  });

  it('pgrep -u <user> -a affiche la ligne de commande complète', async () => {
    const out = await run('pgrep -u user-admin -a');
    expect(out).toMatch(/^\d+\s+sleep 300/m);
  });

  it('cohérence pgrep vs ps : même comptage pour chaque utilisateur', async () => {
    for (const u of ['user-admin', 'user-reseau', 'user-lecture']) {
      const pgrepCount = (await run(`pgrep -u ${u} | wc -l`)).trim();
      const psCount = (await run(`ps -u ${u} --no-headers | wc -l`)).trim();
      expect(pgrepCount).toBe(psCount);
    }
  });

  it('chaque PID retourné par ps -u <user> a un /proc/<pid>/status avec le bon Uid', async () => {
    const out = await run('ps -u user-admin --no-headers -o pid');
    const pids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      const status = await run(`cat /proc/${pid}/status`);
      expect(status).toMatch(new RegExp(`Uid:\\t${adminUid}\\t${adminUid}`));
    }
  });

  it('ps -eo uid | sort | uniq -c dénombre correctement les processus par utilisateur', async () => {
    const out = await run('ps -eo uid --no-headers | sort | uniq -c');
    const adminLine = out.split('\n').find((l) => l.trim().endsWith(` ${adminUid}`));
    expect(adminLine).toBeDefined();
    const count = Number(adminLine!.trim().split(/\s+/)[0]);
    const directCount = Number((await run('ps -u user-admin --no-headers | wc -l')).trim());
    expect(count).toBe(directCount);
  });
});
