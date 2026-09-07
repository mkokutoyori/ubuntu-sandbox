/**
 * `netstat` dit d'UDP ce qu'UDP est, et une machine Windows ne nomme pas
 * un demon Linux.
 *
 * Ecrit A L'AVEUGLE, apres avoir balaye un poste Windows au nmap et
 * compare le rapport a ce que la machine dit d'elle-meme.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * ```
 *   UDP    0.0.0.0:5355          0.0.0.0:0             LISTENING
 * ```
 *
 * Trois choses fausses sur une seule ligne. La documentation de
 * Microsoft est explicite sur les deux premieres : « State — Indicates
 * the state of a TCP CONNECTION », donc une ligne UDP n'a pas d'etat ;
 * et « If the port is not yet established, the port number is shown as
 * an asterisk », d'ou le `*:*` d'une socket UDP a l'ecoute. La
 * troisieme est l'adresse LOCALE, ecrite `0.0.0.0:` en dur : une socket
 * liee a une adresse precise etait rendue comme si elle ecoutait
 * partout, ce qui est le contraire de ce qu'elle fait.
 *
 * S'y ajoutent deux options acceptees et jetees — `-o`, qui doit
 * ajouter la colonne PID, et `-p <proto>`, qui doit ne montrer QUE ce
 * protocole — et une mise en page dessinee a la main, dont les colonnes
 * de donnees tombent un cran avant celles de l'en-tete.
 *
 * ── Le demon qui n'est pas le bon ───────────────────────────────────
 *
 * `Get-NetUDPEndpoint` sur un poste WINDOWS rendait
 * `ProcessName: systemd-resolved` pour 5353 et 5355. Le nom etait
 * declare dans `llmnr/types.ts` et `mdns/types.ts`, c'est-a-dire dans le
 * PROTOCOLE, alors qu'il nomme le DEMON de la plateforme : c'est
 * `systemd-resolved` sous Linux et `svchost` sous Windows, ou le service
 * de client DNS porte les deux repondeurs.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 7 des 10 cas tombent contre l'etat d'avant. Les TROIS qui
 * passent des deux cotes sont nommes plutot que laisses a decouvrir :
 * la ligne TCP, qui etait deja juste ; le nom du demon sous Linux, qui
 * l'etait aussi ; et « sans -o, il n'y a pas de colonne PID », qui
 * passait avant pour une raison qui ne prouve rien — la colonne
 * n'existait dans aucun cas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): WindowsPC {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.powerOn();
  return win;
}

function ligne(sortie: string, motif: RegExp): string {
  const m = sortie.split('\n').find((l) => motif.test(l));
  return m ?? '<absente>';
}

/** La colonne ou commence chaque intitule de l'en-tete. */
function colonnes(entete: string): number[] {
  return ['Proto', 'Local Address', 'Foreign Address', 'State']
    .map((t) => entete.indexOf(t));
}

describe('une ligne UDP n a ni etat ni pair', () => {
  it('elle finit par `*:*` et rien d autre', async () => {
    const win = poste();

    const l = ligne(await taper(win, 'netstat -an'), /^ +UDP +0\.0\.0\.0:5353/);

    expect(l).toMatch(/\*:\*\s*$/);
    expect(l).not.toContain('LISTENING');
  });

  it('la ligne TCP garde son etat et son pair', async () => {
    const win = poste();

    const l = ligne(await taper(win, 'netstat -an'), /^ +TCP +0\.0\.0\.0:445/);

    expect(l).toContain('0.0.0.0:0');
    expect(l).toContain('LISTENING');
  });

  it('les colonnes des donnees tombent sous celles de l en-tete', async () => {
    const win = poste();

    const sortie = await taper(win, 'netstat -an');
    const entete = ligne(sortie, /^ +Proto +Local Address/);
    const tcp = ligne(sortie, /^ +TCP +0\.0\.0\.0:445/);

    const [pProto, pLocal, pForeign, pState] = colonnes(entete);
    expect(tcp.indexOf('TCP')).toBe(pProto);
    expect(tcp.indexOf('0.0.0.0:445')).toBe(pLocal);
    expect(tcp.indexOf('0.0.0.0:0')).toBe(pForeign);
    expect(tcp.indexOf('LISTENING')).toBe(pState);
  });

  it('une socket liee a UNE adresse ne se rend pas comme liee a tout', async () => {
    const win = poste();
    win.udpBindAddress('127.0.0.1', 5000, () => {}, 'testeur');

    const sortie = await taper(win, 'netstat -an');

    expect(sortie).toMatch(/^ +UDP +127\.0\.0\.1:5000/m);
    expect(sortie).not.toMatch(/^ +UDP +0\.0\.0\.0:5000/m);
  });
});

describe('les options sont honorees', () => {
  it('-o ajoute la colonne PID, en-tete compris', async () => {
    const win = poste();

    const sortie = await taper(win, 'netstat -ano');

    expect(sortie).toMatch(/^ +Proto +Local Address +Foreign Address +State +PID$/m);
    expect(ligne(sortie, /^ +TCP +0\.0\.0\.0:445/)).toMatch(/LISTENING\s+\d+$/);
  });

  it('sans -o, il n y a pas de colonne PID', async () => {
    const win = poste();

    const sortie = await taper(win, 'netstat -an');

    expect(sortie).not.toContain('PID');
  });

  it('-p UDP ne montre que l UDP', async () => {
    const win = poste();

    const sortie = await taper(win, 'netstat -an -p UDP');

    expect(sortie).toMatch(/^ +UDP /m);
    expect(sortie).not.toMatch(/^ +TCP /m);
  });

  it('-p tcp ne montre que le TCP', async () => {
    const win = poste();

    const sortie = await taper(win, 'netstat -an -p tcp');

    expect(sortie).toMatch(/^ +TCP /m);
    expect(sortie).not.toMatch(/^ +UDP /m);
  });
});

describe('le demon nomme est celui de la plateforme', () => {
  it('Windows ne nomme pas systemd-resolved', async () => {
    const win = poste();

    const sortie = await taper(win, 'powershell -c "Get-NetUDPEndpoint | Format-Table"');

    expect(sortie).not.toContain('systemd-resolved');
    expect(sortie).toContain('svchost');
  });

  it('Linux le nomme toujours', async () => {
    const pc = new LinuxPC('linux-pc', 'L', 0, 0);
    pc.powerOn();

    const sortie = await taper(pc, 'ss -lunp');

    expect(sortie).toContain('systemd-resolved');
  });
});
