/**
 * Les paramètres DH du simulateur sont du DER réel (RFC 2631 / PKCS#3 DHParameter : SEQUENCE de
 * p et g) : un openssl 3.x réel les lit, les contrôle (`-check`) et en donne le même texte, et le
 * simulateur lit ceux qu'un openssl réel fabrique.
 *
 * MESURÉ avant correctif : la charge d'un bloc DH PARAMETERS était du JSON hexadécimal ; openssl
 * répondait « Error, unable to load parameters » ; le texte ne nommait pas le groupe connu
 * (« GROUP: modp_2048 », « GROUP: ffdhe2048 ») qu'openssl 3.0 affiche à la place de P et G. Avant
 * correctif, 2 des 3 cas tombent ; le troisième (relecture par le simulateur de ses propres
 * paramètres) est un TÉMOIN de non-régression qui passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'dhder-'));
const real = (...args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });

describe('paramètres DH ↔ openssl réel', () => {
  it('openssl lit les paramètres du simulateur : même texte, et -check les accepte', async () => {
    const srv = new LinuxServer('linux-server', 'D'); srv.powerOn();
    await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 2048');
    const file = join(dir, 'sim.dh');
    writeFileSync(file, await srv.executeCommand('cat /tmp/dh.pem'));
    expect(readFileSync(file, 'utf8')).toContain('BEGIN DH PARAMETERS');
    const oracle = real('dhparam', '-in', file, '-noout', '-text');
    expect(oracle.stdout).toContain('DH Parameters: (2048 bit)');
    expect((await srv.executeCommand('openssl dhparam -in /tmp/dh.pem -noout -text')).trim()).toBe(oracle.stdout.trim());
    expect(real('dhparam', '-in', file, '-check', '-noout').stderr).toContain('DH parameters appear to be ok');
  });

  it('le simulateur lit des paramètres fabriqués par openssl (les groupes RFC 7919 nommés)', async () => {
    const file = join(dir, 'ffdhe.dh');
    writeFileSync(file, real('genpkey', '-genparam', '-algorithm', 'DH', '-pkeyopt', 'group:ffdhe2048', '-outform', 'PEM').stdout);
    const expected = real('dhparam', '-in', file, '-noout', '-text').stdout.trim();
    const srv = new LinuxServer('linux-server', 'E'); srv.powerOn();
    await srv.executeCommand(`sh -c 'echo ${readFileSync(file).toString('base64')} | base64 -d > /tmp/real.dh'`);
    expect((await srv.executeCommand('openssl dhparam -in /tmp/real.dh -noout -text')).trim()).toBe(expected);
  });

  it('le simulateur relit ses paramètres et les contrôle', async () => {
    const srv = new LinuxServer('linux-server', 'F'); srv.powerOn();
    await srv.executeCommand('openssl dhparam -out /tmp/dh.pem 2048');
    expect(await srv.executeCommand('openssl dhparam -in /tmp/dh.pem -check -noout 2>&1')).toContain('DH parameters appear to be ok');
  });
});
