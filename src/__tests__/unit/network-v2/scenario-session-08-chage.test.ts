/**
 * Scénario 8 — chage -l : audit complet des politiques de mots de passe
 * par compte.
 *
 * `chage -l` doit produire un rapport lisible et cohérent avec les
 * champs numériques bruts de `/etc/shadow`, et une modification via
 * `chage -M/-W/-I` doit être immédiatement visible des deux côtés.
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
  await run('useradd -m -s /bin/bash user-reseau');
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('Scénario 8 — chage -l : politiques de mots de passe', () => {
  it('chage -l affiche les sept champs attendus', async () => {
    const out = await run('chage -l user-admin');
    expect(out).toMatch(/Last password change\s*:/);
    expect(out).toMatch(/Password expires\s*:/);
    expect(out).toMatch(/Password inactive\s*:/);
    expect(out).toMatch(/Account expires\s*:/);
    expect(out).toMatch(/Minimum number of days between password change\s*:/);
    expect(out).toMatch(/Maximum number of days between password change\s*:/);
    expect(out).toMatch(/Number of days of warning before password expires\s*:/);
  });

  it('par défaut : password/account expiration = never, warn = 7', async () => {
    const out = await run('chage -l user-admin');
    expect(out).toMatch(/Password expires\s*:\s*never/);
    expect(out).toMatch(/Account expires\s*:\s*never/);
    expect(out).toMatch(/Number of days of warning before password expires\s*:\s*7/);
  });

  it('les champs Min/Max/Warn de chage -l correspondent exactement aux champs 4/5/6 de /etc/shadow', async () => {
    const shadowLine = (await run('grep "^user-admin:" /etc/shadow')).trim();
    const fields = shadowLine.split(':');
    const minShadow = fields[3];
    const maxShadow = fields[4];
    const warnShadow = fields[5];

    const chageOut = await run('chage -l user-admin');
    const minChage = chageOut.match(/Minimum number of days between password change\s*:\s*(-?\d+)/)?.[1];
    const maxChage = chageOut.match(/Maximum number of days between password change\s*:\s*(-?\d+)/)?.[1];
    const warnChage = chageOut.match(/Number of days of warning before password expires\s*:\s*(-?\d+)/)?.[1];

    expect(minChage).toBe(minShadow);
    expect(maxChage).toBe(maxShadow);
    expect(warnChage).toBe(warnShadow);
  });

  it('chage -M/-W/-I modifie immédiatement chage -l ET /etc/shadow', async () => {
    await run('chage -M 30 -W 7 -I 14 user-reseau');

    const chageOut = await run('chage -l user-reseau');
    expect(chageOut).toMatch(/Maximum number of days between password change\s*:\s*30/);
    expect(chageOut).toMatch(/Number of days of warning before password expires\s*:\s*7/);

    const shadowFields = (await run('grep "^user-reseau:" /etc/shadow')).trim().split(':');
    expect(shadowFields[4]).toBe('30'); // max
    expect(shadowFields[5]).toBe('7');  // warn
    expect(shadowFields[6]).toBe('14'); // inactive
  });

  it('chage -d 0 affiche "password must be changed" au lieu d\'une date', async () => {
    await run('chage -d 0 user-reseau');
    const out = await run('chage -l user-reseau');
    expect(out).toMatch(/Last password change\s*:\s*password must be changed/);
    expect(out).toMatch(/Password expires\s*:\s*password must be changed/);
  });

  it('chage -E fixe une date d\'expiration de compte visible dans chage -l', async () => {
    await run('chage -E 2030-01-01 user-reseau');
    const out = await run('chage -l user-reseau');
    expect(out).toMatch(/Account expires\s*:\s*Jan 01, 2030/);
  });

  it('chage sur un compte inexistant échoue proprement', async () => {
    const out = await run('chage -l ghostaccount');
    expect(out).toMatch(/does not exist/);
  });

  it('chage -l pour deux comptes différents peut diverger indépendamment', async () => {
    await run('chage -M 10 user-admin');
    await run('chage -M 20 user-reseau');
    const adminOut = await run('chage -l user-admin');
    const reseauOut = await run('chage -l user-reseau');
    expect(adminOut).toMatch(/Maximum number of days between password change\s*:\s*10/);
    expect(reseauOut).toMatch(/Maximum number of days between password change\s*:\s*20/);
  });
});
