/**
 * Un identifiant de VLAN tient sur douze bits, et deux d'entre eux sont
 * reserves.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference : le
 * champ VID de 802.1Q fait DOUZE bits, la valeur 0 y designe « pas de
 * VLAN, seulement une priorite » et 4095 est reservee par la norme, si
 * bien qu'un VLAN utilisable porte un numero de 1 a 4094. C'est un fait de
 * PROTOCOLE et non une table de constructeur : il ne depend d'aucune
 * documentation qu'il faudrait aller chercher.
 *
 * Cote commande (`ip igmp snooping vlan <vlan-id> ...`), la convention
 * d'IOS est que le VLAN nomme doit exister et etre valide.
 *
 * Mesure de depart sur un commutateur Catalyst :
 *
 *   ip igmp snooping vlan zorglub -> ACCEPTE
 *   ip igmp snooping vlan 99999   -> ACCEPTE
 *   ip igmp snooping vlan 0       -> ACCEPTE
 *   ip igmp snooping vlan 4095    -> ACCEPTE
 *
 * Quatre saisies impossibles sur quatre, acceptees en silence — et trois
 * d'entre elles ECRIVENT dans le magasin, `parseInt` rendant 99999, 0 et
 * 4095 tels quels et le gestionnaire ne verifiant que `Number.isNaN`.
 *
 * UNE PREMISSE DE DEPART S'EST REVELEE FAUSSE ET EST CORRIGEE ICI plutot
 * qu'effacee : la sonde tenait pour acquis que `no ip igmp snooping vlan
 * <n>` etait RENDUE dans la configuration, et l'avait donc rangee en
 * non-regression. La mesure dit le contraire — RIEN de la surveillance
 * IGMP n'etait rendu, ni la coupure globale, ni la coupure par VLAN, ni
 * `immediate-leave`, ni les ports de routeur multicast statiques. C'est
 * le manquement le plus couteux du lot : la configuration rendue est
 * REJOUEE a l'import d'une topologie, donc une surveillance coupee
 * revenait ALLUMEE, sans un mot.
 *
 * DEUX FOIS le laboratoire de cette sonde a ete pris en defaut avant le
 * code, et c'est ecrit ici parce que la lecon vaut plus que le correctif :
 * `vlan 4094` est une plage ETENDUE, qu'un Catalyst refuse tant qu'il
 * n'est pas en VTP transparent ; le refus laissait le `exit` suivant
 * quitter le mode de configuration, et TOUTES les commandes d'apres
 * s'executaient en mode exec, ou elles sont evidemment refusees. Un
 * laboratoire mal bati et un defaut sont alors indiscernables.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 16 des 24
 * cas tombent avant correctif. Les 8 autres sont nommes ici :
 *
 *   - les trois `ip igmp snooping vlan {1|10|4094}` acceptes : ce sont
 *     les TEMOINS, ils l'etaient deja — sans eux, un analyseur refusant
 *     TOUT satisferait la sonde ;
 *   - « un refus ne laisse RIEN dans la configuration » : avant correctif
 *     RIEN n'etait rendu du tout, donc l'absence etait vraie pour une
 *     mauvaise raison ;
 *   - « l'etat par defaut ne rend AUCUNE ligne » : meme raison, et il
 *     garde desormais le rendu de rendre ce qu'IOS taît ;
 *   - `ip igmp snooping` global accepte, `show ip igmp snooping` qui
 *     decrit l'etat, et le port inconnu refuse par `mrouter interface` :
 *     ce que la famille faisait deja et que ce lot ne doit pas casser.
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

const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

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

describe('un numero de VLAN impossible est refuse', () => {
  const IMPOSSIBLES = ['zorglub', '99999', '0', '4095', '-1', '10abc'];

  it.each(IMPOSSIBLES)('`ip igmp snooping vlan %s` est refuse', async (vlan) => {
    const d = commutateur(`I${IMPOSSIBLES.indexOf(vlan)}`);
    expect(await conf(d, `ip igmp snooping vlan ${vlan}`)).toContain('%');
  });

  it.each(IMPOSSIBLES)('`no ip igmp snooping vlan %s` aussi', async (vlan) => {
    const d = commutateur(`N${IMPOSSIBLES.indexOf(vlan)}`);
    expect(await conf(d, `no ip igmp snooping vlan ${vlan}`)).toContain('%');
  });

  it('et un refus ne laisse RIEN dans la configuration', async () => {
    const d = commutateur('IR');
    await conf(d, ...IMPOSSIBLES.map((v) => `no ip igmp snooping vlan ${v}`));
    const cfg = await config(d);
    for (const vlan of IMPOSSIBLES) {
      expect(cfg, vlan).not.toContain(`no ip igmp snooping vlan ${vlan}`);
    }
  });
});

describe('les bornes de la norme sont acceptees', () => {
  const POSSIBLES = ['1', '10', '4094'];

  it.each(POSSIBLES)('`ip igmp snooping vlan %s` est accepte', async (vlan) => {
    const d = commutateur(`P${POSSIBLES.indexOf(vlan)}`);
    expect(await conf(d, 'vtp mode transparent', 'vlan ' + vlan, 'exit',
      `ip igmp snooping vlan ${vlan}`)).not.toContain('%');
  });
});

describe('couper la surveillance se RELIT', () => {
  it('`no ip igmp snooping` global revient dans la configuration', async () => {
    const d = commutateur('XA');
    await conf(d, 'no ip igmp snooping');
    expect(await config(d)).toContain('no ip igmp snooping');
  });

  it('`no ip igmp snooping vlan 10` aussi', async () => {
    const d = commutateur('XB');
    await conf(d, 'vlan 10', 'exit', 'no ip igmp snooping vlan 10');
    expect(await config(d)).toContain('no ip igmp snooping vlan 10');
  });

  it('`ip igmp snooping vlan 10 immediate-leave` aussi', async () => {
    const d = commutateur('XC');
    await conf(d, 'vlan 10', 'exit', 'ip igmp snooping vlan 10 immediate-leave');
    expect(await config(d)).toContain('ip igmp snooping vlan 10 immediate-leave');
  });

  it('et rejouer la configuration rendue la redonne', async () => {
    const source = commutateur('XR1');
    await conf(source, 'vlan 10', 'exit',
      'no ip igmp snooping vlan 10', 'ip igmp snooping querier');
    const rendu = (await config(source)).split('\n')
      .filter((l) => /igmp/.test(l)).map((l) => l.trim());
    expect(rendu.length).toBeGreaterThan(0);

    const copie = commutateur('XR2');
    await conf(copie, 'vlan 10', 'exit', ...rendu);
    const relu = (await config(copie)).split('\n')
      .filter((l) => /igmp/.test(l)).map((l) => l.trim());
    expect(relu).toEqual(rendu);
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('l etat par defaut ne rend AUCUNE ligne', async () => {
    const d = commutateur('YA');
    expect(await config(d)).not.toContain('igmp');
  });

  it('`ip igmp snooping` global reste accepte', async () => {
    const d = commutateur('YB');
    expect(await conf(d, 'ip igmp snooping')).not.toContain('%');
  });

  it('`show ip igmp snooping` decrit toujours l etat', async () => {
    const d = commutateur('YC');
    await conf(d, 'no ip igmp snooping');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show ip igmp snooping')))
      .toContain('IGMP snooping');
  });

  it('`ip igmp snooping vlan 10 mrouter interface` refuse un port inconnu', async () => {
    const d = commutateur('YD');
    expect(await conf(d, 'vlan 10', 'exit',
      'ip igmp snooping vlan 10 mrouter interface Gi9/9')).toContain('%');
  });
});
