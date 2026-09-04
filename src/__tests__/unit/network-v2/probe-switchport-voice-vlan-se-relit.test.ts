/**
 * `switchport voice vlan dot1p` se RELIT, et `switchport voice` n'est pas
 * une commande.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference des
 * Catalyst :
 *
 *   switchport voice vlan { <1-4094> | dot1p | none | untagged }
 *   no switchport voice vlan
 *
 * Mesure de depart sur un port d'acces, la configuration relue apres
 * chaque ligne :
 *
 *   switchport voice vlan 10       -> accepte, RENDU        TEMOIN
 *   switchport voice vlan dot1p    -> accepte, RENDU NULLE PART
 *   switchport voice vlan none     -> accepte, RENDU NULLE PART
 *   switchport voice vlan untagged -> accepte, RENDU NULLE PART
 *   switchport voice               -> accepte, RENDU `switchport voice`
 *   switchport voice zorglub       -> accepte, RENDU `switchport voice zorglub`
 *   switchport voice vlan zorglub  -> REFUSE                TEMOIN
 *   switchport voice vlan 4095     -> REFUSE                TEMOIN
 *
 * TROIS DEFAUTS, ET LE PREMIER EST LE PLUS COUTEUX.
 *
 * (1) TROIS VALEURS SUR QUATRE SONT PERDUES A L'IMPORT. `dot1p`, `none`
 *     et `untagged` sont annoncees par `?`, acceptees par l'analyseur,
 *     et rendues nulle part : la configuration est REJOUEE a l'import
 *     d'une topologie, donc un port de telephonie configure en `dot1p`
 *     — le reglage qui fait etiqueter la voix en priorite 802.1p sans
 *     VLAN dedie, c'est-a-dire la moitie du parametrage d'un telephone —
 *     revient vierge et rien ne le dit. Seul le VLAN numerote survivait.
 *
 * (2) `switchport voice` NU EST ACCEPTE ET RENDU. La ligne rendue n'est
 *     pas une commande d'IOS : elle decrit un reglage qui n'existe pas,
 *     et le rejeu la retape a chaque import.
 *
 * (3) `switchport voice zorglub` EST ACCEPTE ET RENDU TEL QUEL. C'est la
 *     meme regle que ce depot applique deja aux criteres de securite —
 *     on ne range pas un critere qu'on n'evalue pas.
 *
 * TROUVE EN MESURANT, ET CORRIGE AVEC : `switchport voice vlan ?`
 * annoncait CHAQUE valeur DEUX FOIS (`<1-4094>`, `<1-4094>`, `dot1p`,
 * `dot1p`…), la place etant declaree a deux endroits pour un seul
 * mot-cle. C'est la meme divergence que `ntp source ?` rendant `IFACE`
 * et `WORD` pour une seule place, corrigee au lot precedent.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que le VLAN de voix
 * agisse sur le plan de donnees. Un vrai Catalyst etiquette la voix dans
 * le VLAN declare ; ce simulateur ne modelise pas de telephone, et
 * l'ajouter est un autre lot. La sonde n'observe que ce que la machine
 * ACCEPTE, RETIENT et RELIT.
 *
 * CE QUE LA MESURE A IMPOSE, et qui n'etait pas prevu : le magasin
 * `SwitchportConfig.voiceVlan` est un NOMBRE, et le plan de donnees le
 * LIT (`Switch.ts` accepte une trame etiquetee dans le VLAN de voix sur
 * un port d'acces, et distingue le port de donnees du telephone). Les
 * trois modes n'ont pas de numero : les faire tenir dans le meme champ
 * aurait casse ces comparaisons. `voiceVlanMode` est donc un second
 * champ, et le seul ecrivain des deux les tient MUTUELLEMENT EXCLUSIFS —
 * poser l'un efface l'autre —, ce qui est exactement ce que la commande
 * veut dire ; un seul rendu les lit, donc ils ne peuvent pas se
 * contredire. La place declaree passe de `VLAN_ID` a `WORD` pour la
 * meme raison que `ip access-group` dans ce depot : une place qui admet
 * PLUSIEURS formes ne peut pas etre typee par une seule, et ce sont les
 * `alternatives` qui la decrivent.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 8 des 30
 * cas tombent avant correctif. Les 22 autres sont nommes ici :
 *
 *   - le TEMOIN `switchport voice vlan 10`, seule valeur qui survivait,
 *     et les deux refus deja justes (`zorglub`, `4095`) ;
 *   - les cinq cas « un port neuf ne rend rien » et « `no` retire »,
 *     qui passaient parce que les trois modes n'etaient JAMAIS rendus —
 *     leur role est desormais de garder que le rendu ne s'emballe pas ;
 *   - les trois valeurs offertes par `?`, deja annoncees (c'est leur
 *     DOUBLON qui etait le defaut, et un seul cas l'observe) ;
 *   - les sept cas de non-regression de la famille `switchport`, sans
 *     lesquels un correctif qui refuserait tout satisferait la sonde.
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

interface Dev {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
}

const commutateur = (n: string) =>
  new CiscoSwitch('switch-cisco', n) as unknown as Dev;

const PORT = 'interface GigabitEthernet0/1';

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', PORT, ...cmds]) {
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

const VALEURS: readonly string[] = ['10', 'dot1p', 'none', 'untagged'];

describe('les quatre valeurs se relisent dans la configuration', () => {
  it.each(VALEURS)('`switchport voice vlan %s` est rendu tel quel', async (v) => {
    const d = commutateur(`A${cle(v)}`);
    expect(await conf(d, `switchport voice vlan ${v}`)).not.toContain('%');
    expect(await config(d)).toContain(`switchport voice vlan ${v}`);
  });

  it('un port neuf ne rend aucune ligne de voix', async () => {
    const d = commutateur('AN');
    await conf(d);
    expect(await config(d)).not.toContain('switchport voice');
  });

  it.each(VALEURS)('et `no switchport voice vlan` retire `%s`', async (v) => {
    const d = commutateur(`B${cle(v)}`);
    await conf(d, `switchport voice vlan ${v}`, 'no switchport voice vlan');
    expect(await config(d)).not.toContain('switchport voice');
  });

  it('la derniere valeur posee remplace la precedente', async () => {
    const d = commutateur('BR');
    await conf(d, 'switchport voice vlan 10', 'switchport voice vlan dot1p');
    const cfg = await config(d);
    expect(cfg).toContain('switchport voice vlan dot1p');
    expect(cfg).not.toContain('switchport voice vlan 10');
  });
});

describe('ce qui n est pas une valeur est refuse', () => {
  it.each(['switchport voice', 'switchport voice zorglub',
    'switchport voice vlan zorglub', 'switchport voice vlan 4095',
    'switchport voice vlan 0', 'switchport voice vlan dot1p zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = commutateur(`C${cle(ligne)}`);
      const out = await conf(d, ligne);
      expect(out).toMatch(/% (Invalid input|Incomplete command)/);
    });

  it('`switchport voice vlan` nu dit INCOMPLET', async () => {
    const d = commutateur('CN');
    expect(await conf(d, 'switchport voice vlan')).toContain('% Incomplete command.');
  });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = commutateur('CR');
    await conf(d, 'switchport voice', 'switchport voice zorglub',
      'switchport voice vlan zorglub');
    const cfg = await config(d);
    expect(cfg).not.toContain('switchport voice');
    expect(cfg).not.toContain('zorglub');
  });
});

describe('`?` annonce chaque valeur UNE fois', () => {
  it('la liste ne porte aucun doublon', async () => {
    const d = commutateur('D1');
    await conf(d);
    const mots = d.cliHelp('switchport voice vlan ')
      .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    expect(mots).toEqual([...new Set(mots)]);
  });

  it.each(['dot1p', 'none', 'untagged', '<1-4094>'])('et elle offre `%s`', async (mot) => {
    const d = commutateur(`D${cle(mot)}`);
    await conf(d);
    expect(d.cliHelp('switchport voice vlan ')).toContain(mot);
  });
});

describe('non-regression — le reste de la famille switchport', () => {
  it.each(['switchport mode access', 'switchport access vlan 10',
    'switchport mode trunk', 'switchport trunk allowed vlan 10,20',
    'switchport nonegotiate', 'switchport port-security'])(
    '`%s` reste accepte', async (ligne) => {
      const d = commutateur(`E${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
    });

  it('`switchport access vlan 10` et le VLAN de voix cohabitent', async () => {
    const d = commutateur('E9');
    await conf(d, 'switchport mode access', 'switchport access vlan 10',
      'switchport voice vlan 20');
    const cfg = await config(d);
    expect(cfg).toContain('switchport access vlan 10');
    expect(cfg).toContain('switchport voice vlan 20');
  });
});
