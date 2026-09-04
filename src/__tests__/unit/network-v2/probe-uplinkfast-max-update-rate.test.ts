/**
 * `spanning-tree uplinkfast max-update-rate 100` se RELIT.
 *
 * Reference des Catalyst :
 *
 *   spanning-tree uplinkfast [ max-update-rate <0-32000> ]   defaut 150
 *   spanning-tree backbonefast                               sans argument
 *
 * Mesure de depart, la configuration relue apres chaque ligne :
 *
 *   spanning-tree uplinkfast                     -> rendu `… uplinkfast`
 *   spanning-tree uplinkfast max-update-rate 100 -> rendu `… uplinkfast`
 *   spanning-tree uplinkfast zorglub             -> ACCEPTE
 *   spanning-tree backbonefast zorglub           -> ACCEPTE
 *
 * DEUX DEFAUTS. Le debit est ANNONCE par `?` — `spanning-tree uplinkfast
 * ?` offre `max-update-rate` — accepte par l'analyseur, et RENDU NULLE
 * PART : la configuration etant rejouee a l'import d'une topologie, un
 * laboratoire qui regle ce debit revient a 150 sans qu'un mot le dise.
 * Et les deux commandes prenaient le mot de trop, `uplinkfast` et
 * `backbonefast` etant les deux seules formes que le repartiteur laissait
 * passer sans regarder leur suite (`return null` sec).
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que le debit gouverne
 * quoi que ce soit. UplinkFast n'emet pas de trames de mise a jour dans
 * ce simulateur — le debit est ce que la commande RETIENT, pas ce qu'elle
 * mesure — et pretendre le contraire serait le decor que ce depot refuse.
 * Le defaut de 150 est celui d'IOS, et il reste TU dans la configuration,
 * comme IOS le tait.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 10 des 22
 * cas tombent avant correctif. Les 12 autres sont nommes ici :
 *
 *   - `uplinkfast` seul, le defaut de 150 tu, `no uplinkfast` et le
 *     commutateur neuf, qui passaient parce que le debit n'etait JAMAIS
 *     rendu — leur role est desormais de garder que le rendu ne
 *     s'emballe pas ;
 *   - les huit cas de non-regression, sans lesquels un correctif qui
 *     refuserait toute la famille satisferait la sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

type Dev = { executeCommand(c: string): Promise<string> };

const commutateur = (n: string) =>
  new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('le debit regle se relit', () => {
  it.each(['0', '100', '32000'])(
    '`spanning-tree uplinkfast max-update-rate %s` est rendu tel quel', async (v) => {
      const d = commutateur(`A${v}`);
      expect(await conf(d, `spanning-tree uplinkfast max-update-rate ${v}`))
        .not.toContain('%');
      expect(await config(d)).toContain(`spanning-tree uplinkfast max-update-rate ${v}`);
    });

  it('le defaut de 150 reste tu, meme ecrit a la main', async () => {
    const d = commutateur('AD');
    await conf(d, 'spanning-tree uplinkfast max-update-rate 150');
    const cfg = await config(d);
    expect(cfg).toContain('spanning-tree uplinkfast');
    expect(cfg).not.toContain('max-update-rate');
  });

  it('`spanning-tree uplinkfast` seul reste rendu sans debit', async () => {
    const d = commutateur('AS');
    await conf(d, 'spanning-tree uplinkfast');
    const cfg = await config(d);
    expect(cfg).toContain('spanning-tree uplinkfast');
    expect(cfg).not.toContain('max-update-rate');
  });

  it('et `no spanning-tree uplinkfast` retire la ligne ET le debit', async () => {
    const d = commutateur('AN');
    await conf(d, 'spanning-tree uplinkfast max-update-rate 100',
      'no spanning-tree uplinkfast');
    expect(await config(d)).not.toContain('uplinkfast');
  });

  it('un commutateur neuf ne rend aucune ligne uplinkfast', async () => {
    const d = commutateur('AV');
    await conf(d);
    expect(await config(d)).not.toContain('uplinkfast');
  });
});

describe('un mot que ces deux commandes ne lisent pas est refuse', () => {
  it.each(['spanning-tree uplinkfast zorglub', 'spanning-tree backbonefast zorglub',
    'spanning-tree uplinkfast max-update-rate zorglub',
    'spanning-tree uplinkfast max-update-rate 32001',
    'spanning-tree uplinkfast max-update-rate 100 zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = commutateur(`B${cle(ligne)}`);
      expect(await conf(d, ligne)).toContain('% Invalid');
    });

  it('`spanning-tree uplinkfast max-update-rate` sans valeur dit INCOMPLET', async () => {
    const d = commutateur('BI');
    expect(await conf(d, 'spanning-tree uplinkfast max-update-rate'))
      .toContain('% Incomplete command.');
  });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = commutateur('BR');
    await conf(d, 'spanning-tree uplinkfast zorglub');
    expect(await config(d)).not.toContain('uplinkfast');
  });
});

describe('non-regression — le reste de la famille', () => {
  it.each(['spanning-tree backbonefast', 'spanning-tree portfast default',
    'spanning-tree loopguard default', 'spanning-tree pathcost method long',
    'spanning-tree mode rapid-pvst', 'spanning-tree extend system-id'])(
    '`%s` reste accepte', async (ligne) => {
      const d = commutateur(`C${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
    });

  it('`spanning-tree backbonefast` reste rendu', async () => {
    const d = commutateur('CB');
    await conf(d, 'spanning-tree backbonefast');
    expect(await config(d)).toContain('spanning-tree backbonefast');
  });

  it('et `show spanning-tree summary` decrit toujours UplinkFast', async () => {
    const d = commutateur('CS');
    await conf(d, 'spanning-tree uplinkfast max-update-rate 100');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show spanning-tree summary')))
      .toContain('UplinkFast');
  });
});
