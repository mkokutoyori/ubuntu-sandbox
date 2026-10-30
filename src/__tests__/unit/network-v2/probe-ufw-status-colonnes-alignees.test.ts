/**
 * `ufw status` ecrit son tableau comme ufw 0.36.1 (src/backend_iptables.py `get_status`) : une ligne vide apres « Status: active », puis
 * l'en-tete `"%-26s %-12s%s"`, le filet de tirets de la LONGUEUR DES MOTS (`--`, `------`, `----`), et chaque regle en
 * `"%-26s %-12s%-26s"` -- la colonne From est calee elle aussi, donc la ligne garde ses blancs de fin. Les attendus viennent de
 * tests/root/live/result, live_route/result et live_apps/result de l'archive source (par exemple
 * `53                         ALLOW FWD   Anywhere                  `).
 *
 * Ce que la source fixe et que ces cas reprennent :
 *  - « IN » n'est ecrit que dans `status verbose` et `status numbered` (`dir_str = ""` sinon) ; « OUT » et « FWD » le sont toujours ;
 *  - l'interface d'une regle entrante s'ecrit dans la colonne To (« 22/tcp on eth0 »), celle d'une regle sortante dans From, et une
 *    regle de routage met l'entree sous From et la sortie sous To ;
 *  - hors `numbered`, les regles entrantes, sortantes puis de routage sont separees par une ligne vide ;
 *  - `status numbered` decale tout de cinq colonnes et numerote `[%2d] ` ;
 *  - `status verbose` ajoute Logging, Default et New profiles, puis une ligne vide AVANT le tableau seulement s'il y a des regles.
 *
 * Mesure de depart : le tableau avait une colonne To de 27, une colonne Action de 16, un filet de la largeur de la colonne, la mention
 * « IN » partout, et l'interface collee a l'action.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

const row = (to: string, action: string, from: string): string => `${to.padEnd(26)} ${action.padEnd(12)}${from.padEnd(26)}`;
const HEADER = 'To                         Action      From';
const RULE = '--                         ------      ----';

beforeEach(async () => {
  srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('ufw enable');
});

async function status(arg = ''): Promise<string[]> {
  return (await srv.executeCommand(`ufw status ${arg}`.trim())).split('\n');
}

describe('ufw status', () => {
  it('sans regle, rien d\'autre que l\'etat', async () => {
    expect(await status()).toEqual(['Status: active']);
  });

  it('une ligne vide, l\'en-tete, le filet, puis les regles calees sur 26 et 12', async () => {
    await srv.executeCommand('ufw allow 22/tcp');
    const out = await status();
    expect(out.slice(0, 3)).toEqual(['Status: active', '', HEADER]);
    expect(out[3]).toBe(RULE);
    expect(out[4]).toBe(row('22/tcp', 'ALLOW', 'Anywhere'));
    expect(out[5]).toBe(row('22/tcp (v6)', 'ALLOW', 'Anywhere (v6)'));
  });

  it('une adresse source remplace « Anywhere » dans From', async () => {
    await srv.executeCommand('ufw deny from 10.0.0.0/8');
    expect((await status())[4]).toBe(row('Anywhere', 'DENY', '10.0.0.0/8'));
  });

  it('une interface d\'entree s\'ecrit dans To', async () => {
    await srv.executeCommand('ufw allow in on eth0 to any port 22 proto tcp');
    expect((await status())[4]).toBe(row('22/tcp on eth0', 'ALLOW', 'Anywhere'));
  });
});

describe('la grammaire de regle de ufw 0.36.1', () => {
  it('`proto` peut ouvrir la regle', async () => {
    await srv.executeCommand('ufw allow proto tcp from any to any port 22');
    expect((await status())[4]).toBe(row('22/tcp', 'ALLOW', 'Anywhere'));
  });

  it('`to` sans `from` est une regle valide', async () => {
    expect(await srv.executeCommand('ufw allow to any port 80 proto tcp')).toContain('Rule added');
  });
});

describe('ufw status verbose', () => {
  it('ecrit « IN » et l\'etat de la journalisation', async () => {
    await srv.executeCommand('ufw allow 22/tcp');
    const out = await status('verbose');
    expect(out.slice(0, 6)).toEqual([
      'Status: active',
      'Logging: on (low)',
      'Default: deny (incoming), allow (outgoing), disabled (routed)',
      'New profiles: skip',
      '',
      HEADER,
    ]);
    expect(out[7]).toBe(row('22/tcp', 'ALLOW IN', 'Anywhere'));
  });

  it('sans regle, le bloc s\'arrete a « New profiles » sans ligne vide', async () => {
    const out = await status('verbose');
    expect(out[out.length - 1]).toBe('New profiles: skip');
  });
});

describe('ufw status numbered', () => {
  it('decale de cinq colonnes et numerote [ n]', async () => {
    await srv.executeCommand('ufw allow 22/tcp');
    const out = await status('numbered');
    expect(out.slice(0, 2)).toEqual(['Status: active', '']);
    expect(out[2]).toBe(`     ${HEADER}`);
    expect(out[3]).toBe(`     ${RULE}`);
    expect(out[4]).toBe(`[ 1] ${row('22/tcp', 'ALLOW IN', 'Anywhere')}`);
    expect(out[5]).toBe(`[ 2] ${row('22/tcp (v6)', 'ALLOW IN', 'Anywhere (v6)')}`);
  });
});

describe('groupes entrant, sortant, routage', () => {
  it('sont separes par une ligne vide et portent OUT ou FWD', async () => {
    await srv.executeCommand('ufw allow 22/tcp');
    await srv.executeCommand('ufw allow out on eth0');
    const out = await status();
    const blank = out.indexOf('', 3);
    expect(blank).toBeGreaterThan(3);
    expect(out[blank + 1]).toBe(row('Anywhere', 'ALLOW OUT', 'Anywhere on eth0'));
  });
});
