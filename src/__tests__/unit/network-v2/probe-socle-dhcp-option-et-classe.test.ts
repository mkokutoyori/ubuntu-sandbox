/**
 * Une option DHCP porte un CODE, et une classe porte un NOM.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   option <0-254> {ascii <chaine> | hex <chaine> | ip <adresse> …}
 *   client-identifier <chaine hexadecimale>
 *   class-map [type inspect] [match-all | match-any] <nom>
 *   policy-map [type inspect] <nom>
 *   match access-group {<1-2799> | name <liste>}
 *
 * Le code d'une option DHCP tient sur UN octet (RFC 2132 §2) et les
 * valeurs 0 et 255 sont reservees au bourrage et a la fin de liste,
 * d'ou la plage `<0-254>` qu'IOS annonce lui-meme.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   option zorglub ip 10.0.0.1  -> ACCEPTE, rendu ` option NaN ip 10.0.0.1`
 *   option 150 ip zorglub       -> ACCEPTE, rendu tel quel
 *   option 150 zorglub 10.0.0.1 -> ACCEPTE (le TYPE n'est pas juge)
 *   client-identifier zorglub   -> ACCEPTE, rendu tel quel
 *   class-map zorglub CM        -> ACCEPTE, rendu `class-map match-all zorglub`
 *   policy-map type zorglub PM  -> ACCEPTE, rendu NULLE PART
 *   match access-group zorglub  -> ACCEPTE, rendu tel quel
 *
 * Le reste de la famille DHCP est DEJA juge — `network`, `default-router`,
 * `dns-server`, `next-server`, `lease`, `netbios-node-type`,
 * `hardware-address` et `host` refusent tous leur mot invente — donc ce
 * lot ne fait que finir un travail commence, et c'est ce qui rend les
 * quatre trous surprenants : ils sont dans la MEME vue.
 *
 * `class-map zorglub CM` est le plus retors des sept : la machine ne
 * refuse pas, elle prend `zorglub` pour le nom et JETTE `CM`. La
 * configuration ne reproduit donc pas ce qui a ete tape, et comme elle
 * est REJOUEE a l'import d'une topologie, l'operateur retrouve une
 * classe qu'il n'a jamais nommee — pendant que celle qu'il croyait avoir
 * creee n'existe pas.
 *
 * `match access-group` porte deja son vocabulaire : `CMAP_KEYWORDS`
 * DECLARE `<1-2799>` et `name` pour l'aide, et l'analyseur ne les lit
 * pas. Meme forme que les clauses `set` d'une carte de routage, les
 * modes de tunnel et les jours d'une plage horaire.
 *
 * Discrimine par `git stash` sur les quatre fichiers cables : 14 des 39
 * cas tombent avant correctif. Les 25 autres sont nommes ici :
 *
 *   - les DIX-SEPT cas de valeur juste — trois codes d'option, les
 *     quatre formes de valeur, deux identifiants de client, six en-tetes
 *     de classe et de politique, les deux groupes d'acces, `match
 *     protocol` et `match any` : un analyseur qui acceptait TOUT les
 *     acceptait deja. Ce sont les TEMOINS, et ce sont eux qui verifient
 *     que le correctif n'a pas ferme la porte au lieu de la border —
 *     sans eux, refuser toute option satisferait la moitie de la sonde ;
 *   - les HUIT cas de non-regression, qui epinglent le travail que la
 *     famille avait DEJA fait sur `network`, `default-router`,
 *     `dns-server`, `next-server`, `lease`, `netbios-node-type`,
 *     `hardware-address` et un pool bien forme. Ce sont eux qui montrent
 *     que les quatre trous fermes ici etaient des trous dans une vue par
 *     ailleurs gardee, et non l'etat general de la commande.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, chacun mesure plutot
 * que suppose :
 *
 *   - que `match dscp ef` soit ACCEPTE. Il est refuse aujourd'hui, et
 *     c'est JUSTE : `ClassMapMatch` ne connait que quatre genres
 *     (`access-group-name`, `access-group-num`, `protocol`, `any`) et
 *     rien n'evalue une classe QoS ici, donc l'accepter rangerait un
 *     critere que personne ne lit — exactement ce que la regle du depot
 *     interdit. Inscrit au `TODO.md` avec ce qui manquerait ;
 *   - que `match protocol zorglub` soit refuse. Le nom vient de NBAR,
 *     dont la liste depend de la plateforme et des modules charges ;
 *     aucune source atteignable depuis ce reseau ne l'atteste, et une
 *     liste ecrite de memoire refuserait des protocoles reels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

describe('un code d option DHCP tient sur un octet', () => {
  it.each(['zorglub', '255', '256', '-1'])('`option %s ip 10.0.0.1` est refuse', async (code) => {
    const d = routeur(`O${cle(code)}`);
    expect(await conf(d, 'ip dhcp pool P', `option ${code} ip 10.0.0.1`)).toContain('% Invalid');
  });

  it('et aucun `NaN` n entre dans la configuration', async () => {
    const d = routeur('ON');
    await conf(d, 'ip dhcp pool P', 'option zorglub ip 10.0.0.1');
    const cfg = await config(d);
    expect(cfg).not.toContain('NaN');
    expect(cfg).not.toContain('zorglub');
  });

  it.each(['0', '150', '254'])('`option %s ip 10.0.0.1` reste accepte et RELU', async (code) => {
    const d = routeur(`OO${code}`);
    expect(await conf(d, 'ip dhcp pool P', `option ${code} ip 10.0.0.1`)).not.toContain('%');
    expect(await config(d)).toContain(`option ${code} ip 10.0.0.1`);
  });
});

describe('une option DHCP porte un TYPE et une valeur de ce type', () => {
  it('`option 150 zorglub 10.0.0.1` est refuse', async () => {
    const d = routeur('T1');
    expect(await conf(d, 'ip dhcp pool P',
      'option 150 zorglub 10.0.0.1')).toContain('% Invalid');
  });

  it.each(['zorglub', '999.1.1.1'])('`option 150 ip %s` est refuse', async (val) => {
    const d = routeur(`T${cle(val)}`);
    expect(await conf(d, 'ip dhcp pool P', `option 150 ip ${val}`)).toContain('% Invalid');
  });

  it('`option 150 ip 10.0.0.1 10.0.0.2` reste accepte et RELU', async () => {
    const d = routeur('TM');
    expect(await conf(d, 'ip dhcp pool P',
      'option 150 ip 10.0.0.1 10.0.0.2')).not.toContain('%');
    expect(await config(d)).toContain('option 150 ip 10.0.0.1 10.0.0.2');
  });

  it.each(['ascii lab.local', 'hex 0a000001'])(
    '`option 150 %s` reste accepte et RELU', async (reste) => {
      const d = routeur(`TA${cle(reste)}`);
      expect(await conf(d, 'ip dhcp pool P', `option 150 ${reste}`)).not.toContain('%');
      expect(await config(d)).toContain(`option 150 ${reste}`);
    });
});

describe('un identifiant de client est hexadecimal', () => {
  it.each(['zorglub', '01aa.bbcc.ddgg'])('`client-identifier %s` est refuse', async (id) => {
    const d = routeur(`C${cle(id)}`);
    expect(await conf(d, 'ip dhcp pool P', `client-identifier ${id}`)).toContain('% Invalid');
  });

  it.each(['01aa.bbcc.ddee.ff', '0100.5056.1234'])(
    '`client-identifier %s` reste accepte et RELU', async (id) => {
      const d = routeur(`CO${cle(id)}`);
      expect(await conf(d, 'ip dhcp pool P',
        `client-identifier ${id}`)).not.toContain('%');
      expect(await config(d)).toContain(`client-identifier ${id}`);
    });
});

describe('une classe et une politique portent le nom qu on leur donne', () => {
  it('`class-map zorglub CM` est refuse au lieu de nommer la classe `zorglub`', async () => {
    const d = routeur('K1');
    expect(await conf(d, 'class-map zorglub CM')).toContain('% Invalid');
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`policy-map type zorglub PM` est refuse', async () => {
    const d = routeur('K2');
    expect(await conf(d, 'policy-map type zorglub PM')).toContain('% Invalid');
  });

  it.each(['class-map match-all CM', 'class-map match-any CM', 'class-map CM',
    'class-map type inspect match-all CM'])('`%s` reste accepte', async (ligne) => {
    const d = routeur(`KO${cle(ligne)}`);
    expect(await conf(d, ligne)).not.toContain('%');
  });

  it.each(['policy-map PM', 'policy-map type inspect PM'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`KP${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
    });
});

describe('un groupe d acces de classe est un numero ou un nom', () => {
  it.each(['zorglub', '2800'])('`match access-group %s` est refuse', async (val) => {
    const d = routeur(`A${cle(val)}`);
    expect(await conf(d, 'class-map match-all CM',
      `match access-group ${val}`)).toContain('% Invalid');
  });

  it('`match access-group 101` reste accepte et RELU', async () => {
    const d = routeur('AO');
    expect(await conf(d, 'class-map match-all CM',
      'match access-group 101')).not.toContain('%');
    expect(await config(d)).toContain('match access-group 101');
  });

  it('`match access-group name BLOQUE` reste accepte et RELU', async () => {
    const d = routeur('AN');
    expect(await conf(d, 'class-map match-all CM',
      'match access-group name BLOQUE')).not.toContain('%');
    expect(await config(d)).toContain('match access-group name BLOQUE');
  });

  it('et `match protocol http` comme `match any` restent acceptes', async () => {
    const d = routeur('AP');
    expect(await conf(d, 'class-map match-all CM', 'match protocol http')).not.toContain('%');
    expect(await conf(d, 'class-map match-all CM2', 'match any')).not.toContain('%');
  });
});

describe('non-regression — ce que la famille jugeait deja', () => {
  it.each(['network zorglub 255.255.255.0', 'default-router zorglub',
    'dns-server zorglub', 'next-server zorglub', 'lease zorglub',
    'netbios-node-type zorglub', 'hardware-address zorglub'])(
    '`%s` reste refuse', async (ligne) => {
      const d = routeur(`X${cle(ligne)}`);
      expect(await conf(d, 'ip dhcp pool P', ligne)).toContain('%');
    });

  it('et un pool bien forme reste RELU', async () => {
    const d = routeur('XP');
    await conf(d, 'ip dhcp pool P', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'dns-server 8.8.8.8');
    const cfg = await config(d);
    expect(cfg).toContain('network 10.0.0.0 255.255.255.0');
    expect(cfg).toContain('default-router 10.0.0.1');
  });
});
