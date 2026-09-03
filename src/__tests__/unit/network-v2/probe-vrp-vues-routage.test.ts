/**
 * Un voisin BGP est une ADRESSE, et une aire OSPF est un identifiant.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   [bgp]   router-id <A.B.C.D>
 *           peer <adresse> as-number <numero d AS>
 *           timer keepalive <duree> hold <duree>
 *
 *   [ospf]  area { <0-4294967295> | <A.B.C.D> }
 *           import-route { direct | static | rip | isis | bgp | ospf | unr }
 *           network <adresse> <masque generique>   (vue d'aire)
 *
 *   [interface] ospf network-type { broadcast | nbma | p2mp | p2p }
 *
 * Les bornes viennent du PROTOCOLE : l'identifiant d'un routeur BGP fait
 * QUATRE octets (RFC 4271 §4.2) — c'est ce qui distingue deux routeurs
 * dans une session, et un mot n'en est pas un — la duree de maintien
 * tient sur seize bits (§4.2 encore), et un identifiant d'aire OSPF fait
 * trente-deux bits (RFC 2328 §C.2), ecrit en decimal ou en quadruplet
 * pointe.
 *
 * Mesure de depart sur un routeur Huawei, en relisant la configuration :
 *
 *   peer zorglub as-number 65002   -> ACCEPTE, et rendu DEUX FOIS
 *   peer 10.0.0.2 as-number zorglub-> ACCEPTE, et rendu DEUX FOIS,
 *                                     `as-number NaN` PUIS `as-number zorglub`
 *   router-id zorglub              -> ACCEPTE, et RENDU
 *   timer keepalive zorglub hold 180 -> ACCEPTE, et RENDU
 *   area zorglub                   -> ACCEPTE
 *   import-route zorglub           -> ACCEPTE
 *   network 10.0.0.0 zorglub       -> ACCEPTE, et RENDU
 *   ospf network-type zorglub      -> ACCEPTE, et RENDU
 *
 * LE DEUXIEME EST LE PLUS GRAVE, et il ne s'agit plus seulement d'une
 * valeur avalee : la MEME configuration porte deux lignes CONTRADICTOIRES
 * pour un seul voisin, `as-number NaN` et `as-number zorglub`. Elle est
 * REJOUEE a l'import d'une topologie, donc la machine se relit
 * elle-meme en se contredisant, et rien ne dit laquelle des deux gagne.
 *
 * `area zorglub` est le pendant VRP d'un defaut que ce depot a deja
 * ferme cote IOS : `parseAreaId` EXISTE dans `ospf/types.ts`, il rend
 * `null` sur ce qui n'est pas un identifiant d'aire, et cette vue-ci ne
 * le lit pas. Le vocabulaire etait ecrit ; l'analyseur ne l'ouvrait pas.
 *
 * TROUVE EN ECRIVANT LA SONDE, et corrige avec : la contradiction ne
 * venait pas de l'analyse mais du MAGASIN. Un voisin BGP etait retenu
 * DEUX fois — en champs structures (`asNumber`, `groupName`) et en texte
 * brut (`rawLines`) — et le rendu emettait les deux, donc `as-number`
 * paraissait toujours en double, meme bien forme. `gardeLigneNonRendue`
 * ne garde en texte que ce que la structure ne rend PAS ; les deux
 * ecritures d'un meme fait n'en font plus qu'une.
 *
 * ET UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE, corrigee dans la sonde et
 * non dans le code : elle exigeait que `ospf network-type broadcast`
 * paraisse dans la configuration. C'est le DEFAUT du protocole, et une
 * configuration ne rend pas ses defauts — le code avait raison. Le cas
 * verifie desormais l'inverse, et les trois autres types, eux, sont bien
 * rendus.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 19 des 36
 * cas tombent avant correctif. Les 17 autres sont nommes ici :
 *
 *   - les DOUZE cas de valeur juste — l'identifiant de routeur, les
 *     minuteurs, les trois aires, le reseau d'aire, les quatre
 *     protocoles importables, les trois types de reseau : un analyseur
 *     qui acceptait TOUT les acceptait deja. Ce sont les TEMOINS, et ce
 *     sont eux qui verifient que le vocabulaire declare est COMPLET —
 *     sans eux, oublier `unr` ou `p2mp` satisferait la sonde ;
 *   - `ospf network-type broadcast`, le cas dont la premisse a ete
 *     corrigee, qui passait deja et le devait ;
 *   - `import-route rip` et `import-route bgp`, acceptes des deux cotes,
 *     et dont l'en-tete du `TODO.md` dit qu'ils sont acceptes puis JETES
 *     — un autre defaut, laisse a son propre lot ;
 *   - les trois cas de non-regression, dont `sysname zorglub`.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, mesure plutot que
 * suppose : que `sysname zorglub` soit refuse. C'est un nom d'hote
 * parfaitement legitime, et le balayage, qui marque tout `zorglub`
 * survivant dans la configuration, me l'avait fait compter comme un
 * defaut. Un cas de non-regression l'epingle ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

const routeur = (n: string) => new HuaweiRouter(n) as unknown as Dev;

async function dansLaVue(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['system-view', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('quit');
  await d.executeCommand('quit');
  return String(await d.executeCommand('display current-configuration'));
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('un voisin BGP est une adresse et son AS un nombre', () => {
  it.each(['zorglub', '999.1.1.1'])('`peer %s as-number 65002` est refuse', async (p) => {
    const d = routeur(`P${cle(p)}`);
    expect(await dansLaVue(d, 'bgp 65001', `peer ${p} as-number 65002`)).toContain('Error');
  });

  it.each(['zorglub', '4294967296'])(
    '`peer 10.0.0.2 as-number %s` est refuse', async (as) => {
      const d = routeur(`A${cle(as)}`);
      expect(await dansLaVue(d, 'bgp 65001',
        `peer 10.0.0.2 as-number ${as}`)).toContain('Error');
    });

  it('et la configuration ne porte pas deux lignes contradictoires', async () => {
    const d = routeur('PC');
    await dansLaVue(d, 'bgp 65001', 'peer 10.0.0.2 as-number zorglub');
    const cfg = await config(d);
    expect(cfg).not.toContain('NaN');
    expect(cfg).not.toContain('zorglub');
  });

  it('`peer 10.0.0.2 as-number 65002` reste accepte et n est rendu QU UNE fois', async () => {
    const d = routeur('PO');
    expect(await dansLaVue(d, 'bgp 65001',
      'peer 10.0.0.2 as-number 65002')).not.toContain('Error');
    const lignes = (await config(d)).split('\n')
      .filter((l) => l.includes('peer 10.0.0.2 as-number 65002'));
    expect(lignes).toHaveLength(1);
  });
});

describe('un identifiant de routeur BGP fait quatre octets', () => {
  it.each(['zorglub', '999.1.1.1'])('`router-id %s` est refuse', async (id) => {
    const d = routeur(`R${cle(id)}`);
    expect(await dansLaVue(d, 'bgp 65001', `router-id ${id}`)).toContain('Error');
  });

  it('`router-id 1.1.1.1` reste accepte et RELU', async () => {
    const d = routeur('RO');
    expect(await dansLaVue(d, 'bgp 65001', 'router-id 1.1.1.1')).not.toContain('Error');
    expect(await config(d)).toContain('router-id 1.1.1.1');
  });
});

describe('les minuteurs BGP tiennent sur seize bits', () => {
  it.each(['zorglub', '65536'])('`timer keepalive %s hold 180` est refuse', async (k) => {
    const d = routeur(`T${cle(k)}`);
    expect(await dansLaVue(d, 'bgp 65001',
      `timer keepalive ${k} hold 180`)).toContain('Error');
  });

  it('`timer keepalive 60 hold 180` reste accepte et RELU', async () => {
    const d = routeur('TO');
    expect(await dansLaVue(d, 'bgp 65001',
      'timer keepalive 60 hold 180')).not.toContain('Error');
    expect(await config(d)).toContain('timer keepalive 60 hold 180');
  });
});

describe('une aire OSPF est un nombre ou un quadruplet pointe', () => {
  it.each(['zorglub', '999.1.1.1'])('`area %s` est refuse', async (a) => {
    const d = routeur(`Z${cle(a)}`);
    expect(await dansLaVue(d, 'ospf 1', `area ${a}`)).toContain('Error');
  });

  it.each(['0', '1', '0.0.0.1'])('`area %s` reste accepte', async (a) => {
    const d = routeur(`ZO${cle(a)}`);
    expect(await dansLaVue(d, 'ospf 1', `area ${a}`)).not.toContain('Error');
  });

  it('`network 10.0.0.0 zorglub` est refuse', async () => {
    const d = routeur('N1');
    expect(await dansLaVue(d, 'ospf 1', 'area 0',
      'network 10.0.0.0 zorglub')).toContain('Error');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('N2');
    await dansLaVue(d, 'ospf 1', 'area 0', 'network 10.0.0.0 zorglub');
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`network 10.0.0.0 0.0.0.255` reste accepte et RELU', async () => {
    const d = routeur('N3');
    expect(await dansLaVue(d, 'ospf 1', 'area 0',
      'network 10.0.0.0 0.0.0.255')).not.toContain('Error');
    expect(await config(d)).toContain('network 10.0.0.0 0.0.0.255');
  });
});

describe('un protocole redistribue est l un de ceux que la machine connait', () => {
  it.each(['zorglub', 'eigrp'])('`import-route %s` est refuse', async (p) => {
    const d = routeur(`I${cle(p)}`);
    expect(await dansLaVue(d, 'ospf 1', `import-route ${p}`)).toContain('Error');
  });

  it.each(['direct', 'static', 'bgp', 'rip'])(
    '`import-route %s` reste accepte', async (p) => {
      const d = routeur(`IO${cle(p)}`);
      expect(await dansLaVue(d, 'ospf 1', `import-route ${p}`)).not.toContain('Error');
    });
});

describe('un type de reseau OSPF est l un des quatre', () => {
  const IF = 'interface GigabitEthernet0/0/0';

  it.each(['zorglub', 'point-to-point'])('`ospf network-type %s` est refuse', async (t) => {
    const d = routeur(`W${cle(t)}`);
    expect(await dansLaVue(d, IF, `ospf network-type ${t}`)).toContain('Error');
  });

  it.each(['nbma', 'p2mp', 'p2p'])(
    '`ospf network-type %s` reste accepte et RELU', async (t) => {
      const d = routeur(`WO${cle(t)}`);
      expect(await dansLaVue(d, IF, `ospf network-type ${t}`)).not.toContain('Error');
      expect(await config(d)).toContain(`ospf network-type ${t}`);
    });

  it('`ospf network-type broadcast` est accepte et n est PAS rendu', async () => {
    const d = routeur('WObro');
    expect(await dansLaVue(d, IF, 'ospf network-type broadcast')).not.toContain('Error');
    expect(await config(d)).not.toContain('ospf network-type');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('WN');
    await dansLaVue(d, IF, 'ospf network-type zorglub');
    expect(await config(d)).not.toContain('zorglub');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`sysname zorglub` reste accepte : c est un nom d hote legitime', async () => {
    const d = routeur('XA');
    expect(await dansLaVue(d, 'sysname zorglub')).not.toContain('Error');
  });

  it('un laboratoire BGP + OSPF bien forme reste RELU', async () => {
    const d = routeur('XB');
    await dansLaVue(d, 'bgp 65001', 'router-id 1.1.1.1',
      'peer 10.0.0.2 as-number 65002', 'quit',
      'ospf 1', 'area 0', 'network 10.0.0.0 0.0.0.255');
    const cfg = await config(d);
    expect(cfg).toContain('bgp 65001');
    expect(cfg).toContain('router-id 1.1.1.1');
    expect(cfg).toContain('ospf 1');
  });

  it('et `ip address` comme `mtu` restent juges', async () => {
    const d = routeur('XC');
    expect(await dansLaVue(d, 'interface GigabitEthernet0/0/0',
      'ip address zorglub 24')).toContain('Error');
    expect(await dansLaVue(d, 'interface GigabitEthernet0/0/0',
      'mtu zorglub')).toContain('Error');
  });
});
