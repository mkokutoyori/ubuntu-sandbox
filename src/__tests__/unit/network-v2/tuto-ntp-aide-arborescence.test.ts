/**
 * PRD-NTP-Tutoriel.md §9 / lot N7 — `ntp ?` decrit ce que `ntp` a.
 *
 * ── Le defaut, signale depuis une vraie session ─────────────────────
 *
 * ```
 * Router1(config)#ntp ?
 *   access-group        Specify access control for packets
 *   …
 *   md5                 MD5 authentication
 *   mode                Set trunking mode of the interface
 *   prefer              Preferred server
 * ```
 *
 * Trois de ces mots ne sont pas des sous-commandes de `ntp` : `md5` est
 * un argument d'`authentication-key`, `prefer` un argument de `server`,
 * et **`mode` porte la description de `switchport mode`** — une fuite
 * d'une commande vers une autre.
 *
 * Et la meme liste revenait a TOUTES les profondeurs :
 * `ntp access-group access-group access-group ?` la reproposait, la
 * commande etant acceptee.
 *
 * ── La cause ────────────────────────────────────────────────────────
 *
 * `ntp` etait un unique noeud GLOUTON. Un tel noeud n'a pas de
 * sous-arbre — son aide ne peut donc rien descendre — et la liste
 * proposee etait EXTRAITE du code source du gestionnaire par
 * `autoContinuations`, qui ramasse tout mot compare dans un `if`.
 *
 * ── Ce qui a ete verifie contre la documentation constructeur ───────
 *
 * La liste des sous-commandes de `ntp` en configuration globale vient de
 * la reference de commandes IOS, pas d'une supposition. Ce qui n'y est
 * pas est refuse — y compris `nomodify`, que le tutoriel emploie et qui
 * appartient a `ntpd`/`chrony` (lot N6).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

async function config() {
  const r = new CiscoRouter(`H${++serie}`);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

/** Les mots-cles qu'une sortie d'aide propose, sans leur description. */
const mots = (aide: string) =>
  aide.split('\n').map((l) => l.trim().split(/\s{2,}/)[0]).filter(Boolean);

describe('`ntp ?` ne propose que de vraies sous-commandes', () => {
  it('les trois intrus ont disparu', async () => {
    // `md5` et `prefer` sont des ARGUMENTS ; `mode` n'existe pas du tout
    // sous `ntp` et portait la description de `switchport mode`.
    const aide = await (await config()).executeCommand('ntp ?');
    for (const intrus of ['md5', 'mode', 'prefer']) {
      expect(mots(aide), intrus).not.toContain(intrus);
    }
    expect(aide).not.toContain('trunking mode');
  });

  it('les sous-commandes de la reference IOS sont la', async () => {
    const aide = await (await config()).executeCommand('ntp ?');
    for (const attendu of ['access-group', 'authenticate', 'authentication-key',
      'master', 'peer', 'server', 'source', 'trusted-key', 'update-calendar']) {
      expect(mots(aide), attendu).toContain(attendu);
    }
  });

  it('chaque mot propose porte SA description, jamais celle du parent', async () => {
    const aide = await (await config()).executeCommand('ntp ?');
    const descriptions = aide.split('\n').map((l) => l.trim().split(/\s{2,}/)[1])
      .filter(Boolean);
    // Aucune ne se repete : une description recopiee du parent
    // apparaitrait plusieurs fois.
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe('l\'aide DESCEND au lieu de se repeter', () => {
  it('`ntp access-group ?` nomme les quatre familles', async () => {
    // Elle reproposait la liste complete des sous-commandes de `ntp`.
    const aide = await (await config()).executeCommand('ntp access-group ?');
    expect(mots(aide).sort()).toEqual(['peer', 'query-only', 'serve', 'serve-only']);
    expect(aide).not.toContain('authentication-key');
  });

  it('`ntp master ?` donne la plage du stratum', async () => {
    const aide = await (await config()).executeCommand('ntp master ?');
    expect(aide).toContain('<1-15>');
    expect(aide).toContain('Stratum number');
  });

  it('`ntp authentication-key ?` donne la plage du numero de cle', async () => {
    const aide = await (await config()).executeCommand('ntp authentication-key ?');
    expect(aide).toContain('<1-4294967295>');
  });

  it('`ntp server ?` et `ntp peer ?` attendent une adresse', async () => {
    const r = await config();
    for (const c of ['ntp server ?', 'ntp peer ?']) {
      expect(await r.executeCommand(c), c).toContain('A.B.C.D');
    }
  });
});

describe('ce que l\'arbre ne connait pas est refuse', () => {
  it('`ntp zzz` est refuse', async () => {
    expect(await (await config()).executeCommand('ntp zzz'))
      .toMatch(/% Invalid input detected/);
  });

  it('`ntp` seul est incomplet', async () => {
    expect(await (await config()).executeCommand('ntp'))
      .toMatch(/% Incomplete command/);
  });

  it('`ntp access-group access-group access-group` est refuse', async () => {
    // Il etait ACCEPTE : le noeud glouton avalait tout.
    expect(await (await config()).executeCommand('ntp access-group access-group access-group'))
      .toMatch(/% Invalid input detected/);
  });

  it('les formes legitimes restent acceptees', async () => {
    // Le garde-fou du lot : restructurer l'arbre ne doit rien casser.
    const r = await config();
    for (const c of ['ntp server 10.0.0.1', 'ntp server 10.0.0.2 prefer',
      'ntp peer 10.0.0.3', 'ntp master 7', 'ntp authenticate',
      'ntp authentication-key 1 md5 Secret', 'ntp trusted-key 1',
      'ntp source Loopback0', 'ntp update-calendar',
      'access-list 10 permit any', 'ntp access-group peer 10']) {
      expect(await r.executeCommand(c), c).toBe('');
    }
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    for (const l of ['ntp server 10.0.0.1', 'ntp master 7', 'ntp authenticate',
      'ntp trusted-key 1', 'ntp source Loopback0', 'ntp update-calendar',
      'ntp access-group peer 10']) {
      expect(cfg, l).toContain(l);
    }
  });

  it('les formes `no` restent acceptees', async () => {
    const r = await config();
    await r.executeCommand('ntp server 10.0.0.1');
    await r.executeCommand('ntp master 7');
    expect(await r.executeCommand('no ntp server 10.0.0.1')).toBe('');
    expect(await r.executeCommand('no ntp master')).toBe('');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toContain('ntp server 10.0.0.1');
    expect(cfg).not.toContain('ntp master');
  });
});
