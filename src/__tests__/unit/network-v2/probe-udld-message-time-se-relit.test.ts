/**
 * `udld message time 30` se RELIT, et 200 n'est pas une valeur.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference des
 * Catalyst 2960/3560 :
 *
 *   udld { enable | aggressive | message time <1-90> }
 *   no udld { enable | aggressive | message time }
 *   interface : udld port [ aggressive ]
 *   show udld [ <interface> | neighbors ]
 *
 * Mesure de depart sur un commutateur Cisco, une commande par machine
 * neuve, la configuration relue apres chaque ligne :
 *
 *   udld message time 30    -> accepte, RIEN dans la configuration
 *   udld message time 200   -> accepte
 *   udld message time zorglub -> accepte
 *   udld message time       -> accepte
 *   udld                    -> accepte
 *   udld enable zorglub     -> accepte, rend `udld enable`
 *   udld aggressive zorglub -> accepte, rend `udld aggressive`
 *   show udld neighbors     -> chaine vide
 *
 * TROIS DEFAUTS, ET LE PREMIER EST LE PLUS COUTEUX.
 *
 * (1) LE REGLAGE EXISTE, IL AGIT, ET IL N'EST RENDU NULLE PART.
 *     `udld message time <n>` ecrit bel et bien `helloIntervalSec` sur
 *     l'agent — `show udld` le lit sous `Message interval:` et le
 *     minuteur d'emission s'en sert — mais le rendu de la configuration
 *     ne l'ecrit pas. Or la configuration rendue est REJOUEE a l'import
 *     d'une topologie : un laboratoire qui accelere UDLD revient a 15
 *     secondes sans qu'un mot le dise, et la vue affirme 15 la ou
 *     l'operateur avait ecrit 30. C'est le meme defaut que ce depot a
 *     ferme famille par famille (TACACS+, console, NTP, pools DHCP) ;
 *     UDLD est la suivante.
 *
 * (2) LA PLAGE N'EST PAS APPLIQUEE, ET LE MOT NON PLUS. `parseInt` rend
 *     `NaN` sur `zorglub`, le gestionnaire l'ecarte en SILENCE et rend
 *     la chaine vide : l'operateur croit avoir regle l'intervalle. Une
 *     valeur hors bornes (0, 200) est, elle, ECRITE — donc le minuteur
 *     prend une valeur qu'aucune machine reelle n'accepte.
 *
 * (3) UN MOT QUE LA COMMANDE NE LIT PAS EST JETE. `udld enable zorglub`
 *     et `udld aggressive zorglub` sont acceptes, et `udld` nu aussi —
 *     alors que les trois formes de cette commande exigent un mot-cle.
 *     C'est la regle que ce depot applique deja aux criteres de
 *     securite, portee ici : on n'accepte pas un argument qu'on ne lit
 *     pas.
 *
 * TROUVE EN MESURANT, ET CORRIGE AVEC : `show udld <interface>` filtrait
 * par `p.port === cible || p.port.endsWith(cible)`, donc `show udld 1`
 * decrivait `GigabitEthernet0/1` — la meme comparaison approximative que
 * le lot precedent vient de retirer de `show standby`. Le depot porte
 * `resolvePortName` ; sauf qu'il etait lui-meme une TROISIEME ecriture de
 * « resoudre un nom d'interface Cisco », reduite a l'egalite exacte,
 * donc `Gi0/2` ne designait rien. Il DELEGUE desormais a
 * `resolveCiscoInterfaceName`, la fonction que tout le depot lit — un
 * elargissement pur, puisqu'elle commence par la meme egalite exacte et
 * n'ajoute que l'expansion d'abreviation.
 *
 * CE QUE CE LOT NE FAIT DELIBEREMENT PAS : ecrire `show udld neighbors`.
 * C'est une vue reelle d'IOS, et elle etait lue comme un NOM DE PORT,
 * donc ne trouvait aucun port et rendait la CHAINE VIDE — le silence,
 * qui se lit comme une panne. Elle rend maintenant le caret, ce qui est
 * honnete sans etre juste. L'ecrire demande sa mise en forme, et aucune
 * transcription n'est atteignable depuis ce reseau : `ntc-templates`, le
 * jeu de reference dont ce depot tire ses autres largeurs de colonnes,
 * ne porte AUCUN gabarit `udld` — verifie dans son index, pas suppose.
 * Inventer des largeurs serait exactement ce que ce depot refuse ;
 * inscrit au `TODO.md`.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 22 des 34
 * cas tombent avant correctif. Les 12 autres sont nommes ici plutot que
 * laisses a decouvrir, et ils portent lourd puisque la moitie de ce lot
 * consiste a REFUSER :
 *
 *   - `et la vue annonce la MEME valeur` passait DEJA, et pour une
 *     raison qui ne prouve rien : le reglage agissait bel et bien sur
 *     l'agent, c'est le RENDU qui manquait. Ce cas est le temoin qui
 *     dit que le defaut n'etait pas dans le moteur ;
 *   - `un commutateur neuf ne rend rien`, `le defaut de 15 reste tu` et
 *     `no udld message time` passaient parce que RIEN n'etait jamais
 *     rendu — ils gardent maintenant que le rendu ne s'emballe pas ;
 *   - `show udld <nom complet>` et `show udld` nu, deja justes ;
 *   - les six cas de non-regression, sans lesquels un correctif qui
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

describe('l intervalle regle se relit dans la configuration', () => {
  it('`udld message time 30` est rendu tel quel', async () => {
    const d = commutateur('M1');
    await conf(d, 'udld enable', 'udld message time 30');
    expect(await config(d)).toContain('udld message time 30');
  });

  it('et la vue annonce la MEME valeur', async () => {
    const d = commutateur('M2');
    await conf(d, 'udld enable', 'udld message time 30',
      'interface GigabitEthernet0/1', 'udld port', 'end');
    expect(String(await d.executeCommand('show udld GigabitEthernet0/1')))
      .toContain('Message interval: 30');
  });

  it('un commutateur neuf ne rend aucune ligne d intervalle', async () => {
    const d = commutateur('M3');
    await conf(d);
    expect(await config(d)).not.toContain('udld message time');
  });

  it('et le defaut de 15 secondes reste tu, meme ecrit a la main', async () => {
    const d = commutateur('M4');
    await conf(d, 'udld enable', 'udld message time 15');
    expect(await config(d)).not.toContain('udld message time');
  });

  it('`no udld message time` revient au defaut et cesse d etre rendu', async () => {
    const d = commutateur('M5');
    await conf(d, 'udld enable', 'udld message time 30', 'no udld message time');
    expect(await config(d)).not.toContain('udld message time');
  });
});

describe('la plage annoncee est appliquee', () => {
  it.each(['0', '91', '200', '-1', 'zorglub'])(
    '`udld message time %s` est refuse', async (valeur) => {
      const d = commutateur(`P${cle(valeur)}`);
      expect(await conf(d, `udld message time ${valeur}`)).toContain('% Invalid');
    });

  it.each(['1', '7', '90'])('`udld message time %s` reste accepte', async (valeur) => {
    const d = commutateur(`Q${valeur}`);
    expect(await conf(d, 'udld enable', `udld message time ${valeur}`)).not.toContain('%');
    expect(await config(d)).toContain(`udld message time ${valeur}`);
  });

  it('et une valeur refusee ne touche pas celle qui etait posee', async () => {
    const d = commutateur('QR');
    await conf(d, 'udld enable', 'udld message time 30', 'udld message time 200');
    expect(await config(d)).toContain('udld message time 30');
  });
});

describe('un mot que `udld` ne lit pas est refuse', () => {
  it.each(['udld zorglub', 'udld enable zorglub', 'udld aggressive zorglub',
    'udld message zorglub', 'udld message time 30 zorglub'])(
    '`%s` rend le caret', async (ligne) => {
      const d = commutateur(`R${cle(ligne)}`);
      expect(await conf(d, ligne)).toContain('% Invalid');
    });

  it.each(['udld', 'udld message', 'udld message time'])(
    '`%s` — le mot-cle est bon, la suite manque — dit INCOMPLET', async (ligne) => {
      const d = commutateur(`S${cle(ligne)}`);
      expect(await conf(d, ligne)).toContain('% Incomplete command.');
    });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = commutateur('SR');
    await conf(d, 'udld zorglub', 'udld enable zorglub');
    expect(await config(d)).not.toContain('udld');
  });
});

describe('`show udld` designe le port qu on nomme', () => {
  async function labo(n: string): Promise<Dev> {
    const d = commutateur(n);
    await conf(d, 'udld enable',
      'interface GigabitEthernet0/1', 'udld port', 'exit',
      'interface GigabitEthernet0/2', 'udld port aggressive', 'end');
    return d;
  }

  it('`show udld GigabitEthernet0/2` ne decrit que ce port', async () => {
    const d = await labo('N1');
    const out = String(await d.executeCommand('show udld GigabitEthernet0/2'));
    expect(out).toContain('Interface GigabitEthernet0/2');
    expect(out).not.toContain('Interface GigabitEthernet0/1');
  });

  it('`show udld Gi0/2` — la forme abregee — designe le meme port', async () => {
    const d = await labo('N2');
    const out = String(await d.executeCommand('show udld Gi0/2'));
    expect(out).toContain('Interface GigabitEthernet0/2');
    expect(out).not.toContain('Interface GigabitEthernet0/1');
  });

  it('`show udld 2` ne designe AUCUN port : ce n est pas un nom', async () => {
    const d = await labo('N3');
    expect(String(await d.executeCommand('show udld 2'))).toContain('% Invalid');
  });

  it('`show udld neighbors` cesse de repondre le SILENCE', async () => {
    const d = await labo('N4');
    const out = String(await d.executeCommand('show udld neighbors'));
    expect(out.trim()).not.toBe('');
    expect(out).toContain('% Invalid');
  });

  it('et `show udld` nu decrit les deux ports', async () => {
    const d = await labo('N5');
    const out = String(await d.executeCommand('show udld'));
    expect(out).toContain('Interface GigabitEthernet0/1');
    expect(out).toContain('Interface GigabitEthernet0/2');
  });
});

describe('non-regression — les formes qui marchaient', () => {
  it.each([['udld enable', 'udld enable'], ['udld aggressive', 'udld aggressive']])(
    '`%s` reste accepte et rendu', async (ligne, attendu) => {
      const d = commutateur(`X${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
      expect(await config(d)).toContain(attendu);
    });

  it('`no udld` coupe et n est plus rendu', async () => {
    const d = commutateur('XN');
    await conf(d, 'udld aggressive', 'no udld');
    expect(await config(d)).not.toContain('udld aggressive');
  });

  it.each(['udld port', 'udld port aggressive'])(
    '`%s` reste accepte en vue d interface', async (ligne) => {
      const d = commutateur(`Y${cle(ligne)}`);
      expect(await conf(d, 'interface GigabitEthernet0/1', ligne)).not.toContain('%');
    });

  it('`udld port zorglub` reste refuse', async () => {
    const d = commutateur('YZ');
    expect(await conf(d, 'interface GigabitEthernet0/1', 'udld port zorglub'))
      .toContain('% Invalid');
  });
});
