/**
 * `diagnose sys top' ecrivait une COLONNE DE PLUS que la reference, et la
 * remplissait d'une constante.
 *
 * MESURE DE DEPART sur `ce765d12' :
 *
 *   OURS      newcli         83      R     0.0    1.0    1
 *   CAPTURE       newcli    29806      R       0.1     0.5
 *
 * Le `1' de fin etait ecrit `value: () => '1'' — le coeur sur lequel le
 * processus a tourne en dernier, qu'aucun compteur ne produit. Le gabarit
 * `ntc-templates' connait bien cette colonne, mais OPTIONNELLE
 * (`(\s+${PROCESS_CPU_CORE})?'), et la capture — dont l'equipement
 * n'annonce qu'un seul processeur, comme le notre — ne la porte pas. Une
 * colonne constante est exactement ce que la regle 6 nomme : toute
 * l'apparence d'exister, sauf l'effet.
 *
 * ET LES CINQ AUTRES COLONNES TOMBAIENT TOUTES A COTE. Mesure sur les
 * quatre lignes de la capture, qui s'alignent entre elles :
 *
 *   nom      cale a DROITE, finit colonne 16   (nous : 15)
 *   pid      cale a DROITE, finit colonne 25   (nous : 26)
 *   etat     la lettre en colonne 31           (nous : 32)
 *   cpu      cale a DROITE, finit colonne 42   (nous : 41)
 *   memoire  cale a DROITE, finit colonne 50   (nous : 48)
 *
 * LE MARQUEUR DE PRIORITE se lit dans la meme mesure. Un processus
 * renice negativement porte un `<' apres sa lettre d'etat —
 * `       ipshelper      199      S <     0.0     1.8' — et ce `<' tombe
 * en colonne 33 sans deplacer les colonnes suivantes. L'etat n'est donc
 * pas un champ cale a droite mais une cellule de trois caracteres,
 * `R  ' ou `S <', posee a partir de la colonne 31.
 *
 * AUTORITE : la sortie CAPTUREE que `ntc-templates' conserve pour
 * `fortinet_diagnose_sys_top', et son gabarit pour le caractere
 * optionnel de la colonne de coeur.
 *
 * MESURE : 5 cas tombent sur 7.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : la vue rendait deja la ligne de duree et au moins un
 *     processus. Sans lui, « les colonnes sont fausses » et « la table de
 *     processus est vide » seraient indiscernables — les deux rendent une
 *     ligne introuvable ;
 *   - NON-REGRESSION : la ligne de charge garde sa forme. Ce lot ne
 *     touche qu'au tableau, et la ligne au-dessus ne devait pas suivre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  fgt.powerOn();
  await taper(fgt, [
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'set utm-status enable', 'set inspection-mode proxy',
    'next', 'end',
  ]);
  return fgt;
}

const top = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('diagnose sys top').then(String);

function ligne(vue: string, nom: string): string {
  return vue.split('\n').find(l => l.trimStart().startsWith(`${nom} `)
    || l.trimStart() === nom) ?? '';
}

function finDe(l: string, quoi: RegExp): number {
  const lu = quoi.exec(l);
  return lu === null ? -1 : lu.index + lu[0].length;
}

describe('`diagnose sys top` pose ses colonnes comme la reference', () => {
  it('TEMOIN : la vue rend la charge et au moins un processus', async () => {
    const fgt = await laboratoire();
    const vue = await top(fgt);

    expect(vue).toMatch(/^Run Time: {2}\d+ days, \d+ hours and \d+ minutes$/m);
    expect(ligne(vue, 'newcli')).not.toBe('');
  }, 30000);

  it('le nom finit a la colonne 16 et le pid a la 25', async () => {
    const fgt = await laboratoire();
    const l = ligne(await top(fgt), 'newcli');

    expect(finDe(l, /newcli/)).toBe(16);
    expect(finDe(l, /\d+(?= )/)).toBe(25);
  }, 30000);

  it('la lettre d etat est en colonne 31', async () => {
    const fgt = await laboratoire();
    expect(ligne(await top(fgt), 'newcli').indexOf('R')).toBe(31);
  }, 30000);

  it('le marqueur de priorite est en colonne 33', async () => {
    const fgt = await laboratoire();
    const l = ligne(await top(fgt), 'wad');

    expect(l.indexOf('S')).toBe(31);
    expect(l.indexOf('<')).toBe(33);
  }, 30000);

  it('le processeur finit a la colonne 42 et la memoire a la 50', async () => {
    const fgt = await laboratoire();
    const l = ligne(await top(fgt), 'newcli');
    const chiffres = [...l.matchAll(/\d+\.\d/g)];

    expect(chiffres.length).toBe(2);
    expect(chiffres[0].index + chiffres[0][0].length).toBe(42);
    expect(chiffres[1].index + chiffres[1][0].length).toBe(50);
  }, 30000);

  it('la colonne de coeur inventee a disparu : la ligne finit a 50', async () => {
    const fgt = await laboratoire();
    for (const nom of ['newcli', 'httpsd', 'cmdbsvr']) {
      expect(ligne(await top(fgt), nom).length).toBe(50);
    }
  }, 30000);

  it('NON-REGRESSION : la ligne de charge garde sa forme', async () => {
    const fgt = await laboratoire();
    expect((await top(fgt)).split('\n')[1])
      .toMatch(/^\d+U, \d+N, \d+S, \d+I, \d+WA, \d+HI, \d+SI, \d+ST; \d+T, \d+F$/);
  }, 30000);
});
