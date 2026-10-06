/**
 * `openssl` sans argument, `openssl help` et commande inconnue. Source : OpenSSL 3.0.13,
 * apps/openssl.c — il n'y a PAS de boucle interactive `OpenSSL> ` en 3.0 (elle a disparu avec
 * la 1.1.1) : sans argument, `main` exécute `help`, qui écrit sur la sortie d'erreur ; une
 * commande inconnue répond `Invalid command '<x>'; type "help" for a list.` et sort en 1.
 * L'oracle est openssl 3.x réel, comparé ligne à ligne.
 *
 * MESURÉ avant correctif : `openssl` répondait « interactive mode is not implemented in this
 * simulator » ; `openssl help` n'imprimait que les sous-commandes implémentées, sur la sortie
 * standard ; une commande inconnue répondait avec le texte de la 1.1.1
 * (« openssl:Error: 'x' is an invalid command »). Avant correctif, les 3 cas tombent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
  return srv;
}

describe('openssl help (3.0)', () => {
  it('`openssl help` : le texte d\'openssl réel, ligne pour ligne, sur la sortie d\'erreur', async () => {
    const real = spawnSync('openssl', ['help'], { encoding: 'utf8' }).stderr;
    expect((await (await lab()).executeCommand('openssl help 2>&1 >/dev/null')).trimEnd()).toBe(real.trimEnd());
  });

  it('`openssl` seul : la même aide, pas de boucle interactive', async () => {
    const real = spawnSync('openssl', [], { encoding: 'utf8', input: '' }).stderr;
    expect((await (await lab()).executeCommand('openssl 2>&1 >/dev/null')).trimEnd()).toBe(real.trimEnd());
  });

  it('commande inconnue : le message d\'openssl réel', async () => {
    const real = spawnSync('openssl', ['frobnicate'], { encoding: 'utf8' }).stderr.trim();
    expect((await (await lab()).executeCommand('openssl frobnicate 2>&1')).trim()).toBe(real);
  });
});
