/**
 * Un mot mal tape ne DEVIENT pas le defaut.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 * `track <1-1000> interface <if> {line-protocol | ip routing}`,
 * `track <n> ip route <prefixe> <masque> {reachability | metric threshold}`,
 * `track <n> ip sla <n> [state | reachability]`,
 * `track <n> list boolean {and | or}`.
 *
 * Mesure de depart, sur un routeur et sur un commutateur :
 *
 *   track 1 interface GigabitEthernet0/0 zorglub  -> ACCEPTE
 *       et rendu `track 1 interface GigabitEthernet0/0 line-protocol`
 *
 * L'objet suit donc une condition que l'operateur n'a PAS demandee, et
 * ce n'est pas de l'affichage : un objet de suivi conditionne une route
 * flottante, donc le basculement se declenche sur le mauvais fait. Le
 * rendu est en outre rejoue a l'import d'une topologie, si bien que la
 * substitution devient permanente sans qu'un mot la signale.
 *
 * La forme est la meme dans les QUATRE branches de l'analyseur — chacune
 * devine par presence puis retombe sur un defaut :
 *
 *   interface   -> `rest.includes('ip') && rest.includes('routing')`
 *   ip route    -> `rest.includes('metric')`
 *   ip sla      -> `rest[3] === 'state'`
 *   list boolean-> `rest[2] === 'or'`
 *
 * et le commutateur en porte une CINQUIEME ecriture, un ternaire
 * (`args[3] === 'ip' && args[4] === 'routing' ? … : 'line-protocol'`)
 * sur un registre a lui, plus pauvre que celui du routeur.
 *
 * Discrimine par `git stash` sur les deux gestionnaires : 9 des 28 cas
 * tombent avant correctif. Les 19 autres sont nommes ici :
 *
 *   - les onze formes VALIDES (les deux types d'interface, les deux de
 *     `ip route`, les trois de `ip sla`, les deux de `list boolean`, les
 *     deux de `list threshold`) : elles bornent le refus, et sans elles
 *     un analyseur qui refuserait TOUT satisferait la sonde ;
 *   - `track 6 zorglub`, deja refuse par le repli final de l'analyseur —
 *     c'est justement la preuve que le defaut n'est pas l'absence d'un
 *     refus mais sa presence a un seul rang ;
 *   - le numero d'objet : `track zorglub` et `track 1001` etaient deja
 *     refuses des deux cotes, la plage etant DECLAREE dans l'aide et la
 *     regle « une plage annoncee est appliquee » s'en chargeant ; seul le
 *     MESSAGE differait, et ce cas-la tombe ;
 *   - les deux cas de non-regression (`no track`, `show track`).
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

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;
const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

async function suivis(d: Dev): Promise<string[]> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('track '));
}

describe('`track ... interface` — le type suivi est celui qu on a ecrit', () => {
  it('le routeur refuse un mot qui n est aucun des deux types', async () => {
    const d = routeur('RI');
    const [out] = await conf(d, 'track 1 interface GigabitEthernet0/0 zorglub');
    expect(out).toContain('%');
  });

  it('et il ne pose AUCUN objet', async () => {
    const d = routeur('RJ');
    await conf(d, 'track 1 interface GigabitEthernet0/0 zorglub');
    expect(await suivis(d)).toEqual([]);
  });

  it('le commutateur le refuse aussi', async () => {
    const d = commutateur('SI');
    const [out] = await conf(d, 'track 1 interface FastEthernet0/1 zorglub');
    expect(out).toContain('%');
  });

  it.each(['line-protocol', 'ip routing'])(
    'le type `%s` reste accepte et rendu', async (type) => {
      const d = routeur(`RT${type.length}`);
      const [out] = await conf(d, `track 1 interface GigabitEthernet0/0 ${type}`);
      expect(out).not.toContain('%');
      expect(await suivis(d)).toContain(`track 1 interface GigabitEthernet0/0 ${type}`);
    });

  it('un type OMIS reste incomplet, jamais substitue', async () => {
    const d = routeur('RO');
    const [out] = await conf(d, 'track 1 interface GigabitEthernet0/0');
    expect(out).toContain('%');
  });
});

describe('`track ... ip route` — reachability et metric ne se devinent pas', () => {
  it('un mot inconnu est refuse', async () => {
    const d = routeur('RR');
    const [out] = await conf(d, 'track 2 ip route 10.0.0.0 255.0.0.0 zorglub');
    expect(out).toContain('%');
    expect(await suivis(d)).toEqual([]);
  });

  it.each(['reachability', 'metric threshold'])(
    '`%s` reste accepte', async (forme) => {
      const d = routeur(`RM${forme.length}`);
      const [out] = await conf(d, `track 2 ip route 10.0.0.0 255.0.0.0 ${forme}`);
      expect(out).not.toContain('%');
    });
});

describe('`track ... ip sla` — l etat et la joignabilite sont deux faits', () => {
  it('un mot inconnu est refuse', async () => {
    const d = routeur('RS');
    const [out] = await conf(d, 'track 3 ip sla 1 zorglub');
    expect(out).toContain('%');
    expect(await suivis(d)).toEqual([]);
  });

  it.each(['state', 'reachability'])('`%s` reste accepte', async (forme) => {
    const d = routeur(`RL${forme.length}`);
    const [out] = await conf(d, `track 3 ip sla 1 ${forme}`);
    expect(out).not.toContain('%');
  });

  it('la forme SANS mot reste acceptee — IOS la prend', async () => {
    const d = routeur('RN');
    const [out] = await conf(d, 'track 3 ip sla 1');
    expect(out).not.toContain('%');
  });
});

describe('`track ... list boolean` — `and` et `or` sont deux operations', () => {
  it('un mot inconnu est refuse', async () => {
    const d = routeur('RB');
    const [out] = await conf(d, 'track 4 list boolean zorglub');
    expect(out).toContain('%');
    expect(await suivis(d)).toEqual([]);
  });

  it.each(['and', 'or'])('`%s` reste accepte et rendu', async (op) => {
    const d = routeur(`RC${op}`);
    const [out] = await conf(d, `track 4 list boolean ${op}`);
    expect(out).not.toContain('%');
    expect((await suivis(d)).join('\n')).toContain(`list boolean ${op}`);
  });

  it('`list threshold zorglub` est refuse aussi', async () => {
    const d = routeur('RD');
    const [out] = await conf(d, 'track 5 list threshold zorglub');
    expect(out).toContain('%');
    expect(await suivis(d)).toEqual([]);
  });

  it.each(['weight', 'percentage'])(
    '`list threshold %s` reste accepte', async (kind) => {
      const d = routeur(`RE${kind.length}`);
      const [out] = await conf(d, `track 5 list threshold ${kind}`);
      expect(out).not.toContain('%');
    });

  it('un mot qui n est aucune des formes de `track` est refuse', async () => {
    const d = routeur('RZ');
    const [out] = await conf(d, 'track 6 zorglub');
    expect(out).toContain('%');
    expect(await suivis(d)).toEqual([]);
  });
});

describe('le NUMERO d objet est un numero, et les deux plateformes le disent pareil', () => {
  it.each([
    ['routeur', routeur], ['commutateur', commutateur],
  ] as ReadonlyArray<[string, (n: string) => Dev]>)(
    '%s refuse `track zorglub`', async (nom, faire) => {
      const d = faire(`N${nom}`);
      const [out] = await conf(d, 'track zorglub interface GigabitEthernet0/0 line-protocol');
      expect(out).toContain('%');
    });

  it('et les deux refusent avec le MEME message', async () => {
    const r = routeur('U1');
    const s = commutateur('U2');
    const [depuisRouteur] = await conf(r, 'track zorglub interface GigabitEthernet0/0 line-protocol');
    const [depuisCommutateur] = await conf(s, 'track zorglub interface FastEthernet0/1 line-protocol');
    expect(depuisCommutateur.trim()).toBe(depuisRouteur.trim());
  });

  it.each([
    ['routeur', routeur], ['commutateur', commutateur],
  ] as ReadonlyArray<[string, (n: string) => Dev]>)(
    '%s refuse un numero hors de <1-1000>', async (nom, faire) => {
      const d = faire(`H${nom}`);
      const [out] = await conf(d, 'track 1001 interface GigabitEthernet0/0 line-protocol');
      expect(out).toContain('%');
    });

  it('la borne haute exacte reste acceptee', async () => {
    const d = routeur('HB');
    const [out] = await conf(d, 'track 1000 interface GigabitEthernet0/0 line-protocol');
    expect(out).not.toContain('%');
  });
});

/*
 * SUITE — la famille est passee au socle, et la migration a trouve deux
 * choses que cette sonde ne demandait pas. Elles sont ajoutees ICI
 * plutot que dans une seconde sonde : c'est la meme commande.
 *
 * (1) LA FORME `A.B.C.D/nn` ETAIT REFUSEE. L'analyse exigeait DEUX
 * jetons pour la destination d'une route suivie, alors qu'IOS accepte
 * aussi le prefixe barre — et c'est celui que la documentation
 * d'Enhanced Object Tracking emploie dans ses propres exemples. La
 * lecture de la longueur est confiee a `cidrPrefixLength`, deja ecrite
 * pour les listes de prefixes, plutot qu'a une seconde decoupe.
 *
 * (2) LES DEUX PLATEFORMES AVAIENT DEUX DECLARATIONS. La grammaire etait
 * partagee (`parseTrackDefinition`), mais chaque coquille enregistrait
 * sa propre entree, libre de borner son numero autrement ou d'ouvrir un
 * sous-mode ou non. Il n'y a plus qu'une declaration et deux CORPS —
 * ce qui est juste, un commutateur n'ayant ni table de routage complete
 * ni moteur IP SLA. Ce que la sonde demande est que le refus soit un
 * REFUS, non une acceptation muette.
 *
 * Discrimine dans un arbre de travail pose sur l'etat d'AVANT plutot
 * qu'en remisant : 4 des 10 cas ajoutes tombent, et ce sont les quatre
 * qui touchent au prefixe barre — les trois formes et le temoin du
 * routeur. Les six autres sont nommes ici : la forme a MASQUE et le
 * refus d'une longueur ou d'une adresse malformee etaient deja justes,
 * et le commutateur refusait deja la route, la sonde IP SLA et la liste
 * — ce qu'ils gardent est que la declaration PARTAGEE ne les lui ouvre
 * pas au passage.
 */
describe('la destination d une route suivie s ecrit des DEUX facons', () => {
  it.each(['track 2 ip route 10.9.0.0/16 reachability',
    'track 2 ip route 10.9.0.0 255.255.0.0 reachability',
    'track 3 ip route 10.9.0.0/16 metric threshold'])(
    '`%s` est accepte', async (cmd) => {
      const d = routeur(`BF${cmd.length}${cmd.slice(-3)}`);
      const [out] = await conf(d, cmd);
      expect(out, out).not.toContain('%');
    });

  it('et les deux ecritures posent la MEME destination', async () => {
    const barre = routeur('BA');
    const masque = routeur('BB');
    await conf(barre, 'track 2 ip route 10.9.0.0/16 reachability');
    await conf(masque, 'track 2 ip route 10.9.0.0 255.255.0.0 reachability');
    expect(await suivis(barre)).toEqual(await suivis(masque));
  });

  it.each(['track 2 ip route 10.9.0.0/33 reachability',
    'track 2 ip route zorglub/16 reachability'])(
    '`%s` est refuse', async (cmd) => {
      const d = routeur(`BR${cmd.length}${cmd.slice(-3)}`);
      const [out] = await conf(d, cmd);
      expect(out, out).toContain('%');
    });
});

describe('le commutateur REFUSE ce qu il ne sait pas suivre', () => {
  it.each(['track 2 ip route 10.9.0.0/16 reachability',
    'track 3 ip sla 1 reachability',
    'track 4 list boolean and'])('`%s`', async (cmd) => {
      const d = commutateur(`SC${cmd.length}${cmd.slice(-3)}`);
      const [out] = await conf(d, cmd);
      expect(out, out).toContain('%');
      expect(await suivis(d)).toEqual([]);
    });

  it('mais le ROUTEUR les accepte — le temoin', async () => {
    const d = routeur('SR');
    for (const cmd of ['track 2 ip route 10.9.0.0/16 reachability',
      'track 3 ip sla 1 reachability', 'track 4 list boolean and']) {
      const [out] = await conf(d, cmd, 'exit');
      expect(out, cmd).not.toContain('%');
    }
  });
});

describe('non-regression — ce que le suivi sait faire ne bouge pas', () => {
  it('un objet valide se relit et `no track` le retire', async () => {
    const d = routeur('NR');
    await conf(d, 'track 1 interface GigabitEthernet0/0 line-protocol');
    expect((await suivis(d)).length).toBe(1);
    await conf(d, 'no track 1');
    expect(await suivis(d)).toEqual([]);
  });

  it('`show track` decrit toujours l objet', async () => {
    const d = routeur('NS');
    await conf(d, 'track 1 interface GigabitEthernet0/0 line-protocol');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show track 1')))
      .toContain('GigabitEthernet0/0');
  });
});
