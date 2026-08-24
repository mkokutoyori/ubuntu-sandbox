/**
 * L'ordre d'une liste d'aide est celui d'IOS : ASCII, `<cr>` en dernier.
 *
 * Deux defauts mesures (audit completion, M1 et M2) qui n'en font qu'un :
 * `getHelp` RETRIAIT par `localeCompare` ce que l'arbre venait de classer
 * correctement. Le tri de l'arbre range deja `<cr>` en queue et les
 * substituts (`<1-4094>`) apres les mots-cles ; le retri l'annulait.
 *
 * M1 — `<cr>` sortait en TETE. La documentation Cisco est explicite : le
 * symbole apparait EN FIN de sortie pour dire « vous pouvez valider ici »,
 * et « les arguments et mots-cles qui le precedent sont optionnels ».
 * En tete, il se lit comme la premiere option ; en queue, comme le repli.
 *
 * M2 — le tri etait insensible a la casse, si bien que les substituts en
 * majuscules (`LINE`, `WORD`, `A.B.C.D`) tombaient au milieu des
 * mots-cles. IOS trie sur les octets : `/` (0x2F) avant les majuscules
 * (0x41…) avant les minuscules (0x61…).
 *
 * Reference : capture reelle de `reload ?` sur une machine —
 *
 *     /noverify
 *     /verify
 *     LINE
 *     at
 *     cancel
 *     in
 *     warm
 *     <cr>
 *
 * `<cr>` y est le dernier element ET n'est pas trie : il est place, pas
 * classe. Un tri qui le rangerait avec les autres le remettrait en tete,
 * `<` valant 0x3C.
 *
 * G5 au passage : sa description etant vide, `<cr>` etait rembourre a la
 * largeur de la colonne et laissait des blancs en fin de ligne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = { cliHelp(s: string): string; executeCommand(c: string): Promise<string> };

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

async function routeur(nom: string): Promise<Machine> {
  const r = new CiscoRouter(nom) as unknown as Machine;
  await r.executeCommand('enable');
  return r;
}

describe('M1 — `<cr>` est le dernier element', () => {
  // `terminal ` figurait ici et n'y a plus sa place : il ne s'execute
  // pas nu (`% Incomplete command.`), donc son `<cr>` etait justement
  // l'un des mensonges que M5 a corriges. `show ip route ` le remplace —
  // plusieurs mots-cles ET une forme nue qui s'execute, ce que ce cas
  // demande pour mesurer un ordre.
  it.each(['reload ', 'ping ', 'traceroute ', 'show ip route ', 'show clock '])(
    '«%s?» le place en queue', async (cas) => {
      const r = await routeur(`R${cas.length}`);
      const mots = motsDe(r.cliHelp(cas));
      expect(mots).toContain('<cr>');
      expect(mots[mots.length - 1]).toBe('<cr>');
    });

  it('et il n apparait qu une fois', async () => {
    const r = await routeur('RU');
    const mots = motsDe(r.cliHelp('ping '));
    expect(mots.filter((m) => m === '<cr>')).toHaveLength(1);
  });
});

describe('M2 — le tri est celui des octets', () => {
  it('`reload ?` met `LINE` avant les mots-cles en minuscules', async () => {
    const r = await routeur('RA');
    const mots = motsDe(r.cliHelp('reload ')).filter((m) => m !== '<cr>');
    expect(mots).toContain('LINE');
    expect(mots.indexOf('LINE')).toBeLessThan(mots.indexOf('at'));
  });

  it.each(['reload ', 'ping ', 'traceroute ', 'username ', 'show clock '])(
    '«%s?» est trie en ASCII, hors `<cr>`', async (cas) => {
      const r = await routeur(`RB${cas.length}`);
      const mots = motsDe(r.cliHelp(cas)).filter((m) => m !== '<cr>');
      expect(mots).toEqual([...mots].sort());
    });

  it('les substituts en majuscules ouvrent la liste', async () => {
    const r = await routeur('RC');
    const mots = motsDe(r.cliHelp('ping ')).filter((m) => m !== '<cr>');
    expect(mots[0]).toBe('WORD');
  });
});

describe('G5 — aucune ligne ne porte de blanc final', () => {
  it.each(['reload ', 'ping ', 'terminal ', 'debug ip ', 'show ip '])(
    '«%s?»', async (cas) => {
      const r = await routeur(`RD${cas.length}`);
      const lignes = r.cliHelp(cas).split('\n');
      expect(lignes.filter((l) => /\s$/.test(l))).toEqual([]);
    });
});

describe('non-regression — le reste de la liste ne bouge pas', () => {
  it('la colonne des descriptions reste alignee', async () => {
    const r = await routeur('RE');
    const lignes = r.cliHelp('show ip ').split('\n');
    const colonnes = new Set(lignes.map((l) => {
      const m = /^\s\s(\S+)(\s+)/.exec(l);
      return m ? m[1].length + m[2].length : -1;
    }));
    expect(colonnes.size).toBe(1);
  });

  it('les listes sans `<cr>` gardent leur contenu', async () => {
    const r = await routeur('RF');
    const mots = motsDe(r.cliHelp('show '));
    for (const m of ['version', 'ip', 'ipv6', 'interfaces', 'running-config']) {
      expect(mots, m).toContain(m);
    }
    expect(mots).not.toContain('<cr>');
  });

  it('le commutateur suit la meme regle', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1') as unknown as Machine;
    await s.executeCommand('enable');
    await s.executeCommand('configure terminal');
    await s.executeCommand('interface FastEthernet0/1');
    const mots = motsDe(s.cliHelp('channel-group 1 '));
    expect(mots[mots.length - 1]).toBe('<cr>');
    const sansCr = mots.filter((m) => m !== '<cr>');
    expect(sansCr).toEqual([...sansCr].sort());
  });

  it('les modificateurs de tuyau restent servis', async () => {
    const r = await routeur('RG');
    const mots = motsDe(r.cliHelp('show running-config | '));
    expect(mots).toContain('include');
    expect(mots).toEqual([...mots].sort());
  });
});

describe('VRP — meme regle sur les blancs de fin', () => {
  it('`<cr>` ne porte pas de rembourrage', async () => {
    const { HuaweiRouter } = await import('@/network/devices/HuaweiRouter');
    const h = new HuaweiRouter('AR1') as unknown as Machine;
    for (const cas of ['display clock ', 'ping ', 'display version ']) {
      const lignes = h.cliHelp(cas).split('\n');
      expect(lignes.filter((l) => /\s$/.test(l)), cas).toEqual([]);
    }
  });

  it('et `<cr>` y reste en queue', async () => {
    const { HuaweiRouter } = await import('@/network/devices/HuaweiRouter');
    const h = new HuaweiRouter('AR2') as unknown as Machine;
    const mots = motsDe(h.cliHelp('ping '));
    expect(mots[mots.length - 1]).toBe('<cr>');
  });
});
