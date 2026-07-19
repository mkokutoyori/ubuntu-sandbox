/**
 * Scénario 9 — usermod : modification de compte et cohérence immédiate.
 *
 * Chaque modification `usermod` doit être immédiatement reflétée dans
 * le fichier concerné (/etc/passwd, /etc/group, /etc/shadow) sans délai
 * observable ; le verrouillage préfixe le hash par `!` et bloque
 * immédiatement toute nouvelle connexion (par mot de passe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let srv: LinuxServer;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  await run('useradd -m -s /bin/bash test-usermod');
  await run('echo "test-usermod:password123" | chpasswd');
  await run('groupadd mandeng-ops');
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

async function buildLan() {
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], srv.getPorts()[0]);
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  return { pc1 };
}

describe('Scénario 9 — usermod : modification et cohérence immédiate', () => {
  it('usermod -s change le shell, immédiatement visible dans /etc/passwd', async () => {
    await run('usermod -s /bin/sh test-usermod');
    const shell = (await run('getent passwd test-usermod | cut -d: -f7')).trim();
    expect(shell).toBe('/bin/sh');
  });

  it('usermod -aG ajoute au groupe supplémentaire, visible via id -Gn', async () => {
    await run('usermod -aG sudo test-usermod');
    const groups = (await run('id -Gn test-usermod')).trim().split(/\s+/);
    expect(groups).toContain('sudo');
  });

  it('usermod -L verrouille le compte : le hash shadow est préfixé par "!"', async () => {
    await run('usermod -L test-usermod');
    const hash = (await run('grep "^test-usermod:" /etc/shadow | cut -d: -f2')).trim();
    expect(hash.startsWith('!')).toBe(true);
  });

  it('un compte verrouillé (usermod -L) refuse une connexion SSH par mot de passe', async () => {
    const { pc1 } = await buildLan();
    await run('usermod -L test-usermod');
    const out = await pc1.executeCommand('sshpass -p password123 ssh test-usermod@10.0.0.10 whoami');
    expect(out).not.toMatch(/^test-usermod\s*$/m);
  });

  it('usermod -U déverrouille : le préfixe "!" disparaît et l\'authentification refonctionne', async () => {
    const { pc1 } = await buildLan();
    await run('usermod -L test-usermod');
    await run('usermod -U test-usermod');
    const hash = (await run('grep "^test-usermod:" /etc/shadow | cut -d: -f2')).trim();
    expect(hash.startsWith('!')).toBe(false);
    const out = await pc1.executeCommand('sshpass -p password123 ssh test-usermod@10.0.0.10 whoami');
    expect(out).toMatch(/^test-usermod\s*$/m);
  });

  it('usermod -aG mandeng-ops : le compte apparaît dans /etc/group', async () => {
    await run('usermod -aG mandeng-ops test-usermod');
    const line = await run('grep "mandeng-ops" /etc/group');
    expect(line).toContain('test-usermod');
  });

  it('cohérence id vs /etc/group après usermod -aG', async () => {
    await run('usermod -aG mandeng-ops test-usermod');
    const idGroups = (await run('id -Gn test-usermod')).trim().split(/\s+/).sort();
    const etcGroups = (await run('grep "test-usermod" /etc/group | cut -d: -f1'))
      .split('\n').filter(Boolean).sort();
    const primaryGroup = (await run(
      'getent group "$(getent passwd test-usermod | cut -d: -f4)" | cut -d: -f1',
    )).trim();
    const expected = [...new Set([...etcGroups, primaryGroup])].sort();
    expect(idGroups).toEqual(expected);
  });

  it('usermod -d change le home, immédiatement visible dans /etc/passwd', async () => {
    await run('usermod -d /tmp/newhome-test test-usermod');
    const home = (await run('getent passwd test-usermod | cut -d: -f6')).trim();
    expect(home).toBe('/tmp/newhome-test');
  });

  it('usermod -G remplace la liste des groupes supplémentaires (pas d\'ajout, un remplacement)', async () => {
    await run('usermod -aG sudo,mandeng-ops test-usermod');
    await run('usermod -G mandeng-ops test-usermod');
    const groups = (await run('id -Gn test-usermod')).trim().split(/\s+/);
    expect(groups).not.toContain('sudo');
    expect(groups).toContain('mandeng-ops');
  });

  it('userdel -r supprime le compte et son home', async () => {
    await run('userdel -r test-usermod');
    const out = await run('getent passwd test-usermod; echo "EXIT:$?"');
    expect(out).toContain('EXIT:2');
    const homeExists = await run('[ -d /home/test-usermod ] && echo yes || echo no');
    expect(homeExists.trim()).toBe('no');
  });
});
