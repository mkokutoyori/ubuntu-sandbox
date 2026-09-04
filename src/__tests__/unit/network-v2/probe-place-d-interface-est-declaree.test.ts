/**
 * Une place qui nomme une INTERFACE la declare, et `zorglub` n'en est pas une.
 *
 * Sonde ecrite AVANT correction, contre le TEMOIN que la machine porte
 * deja : `snmp-server trap-source` declare son argument `INTERFACE`, et
 * il refuse `zorglub`. Quatre places soeurs — la meme question, le meme
 * socle, la meme machine — le declarent `WORD`, qui accepte tout mot.
 *
 * Mesure de depart, une commande par machine neuve, la configuration
 * relue apres chaque ligne :
 *
 *   snmp-server trap-source zorglub   -> REFUSE                 TEMOIN
 *   snmp-server trap-source Gi0/0     -> accepte et rendu       TEMOIN
 *   ntp source zorglub                -> accepte, RENDU tel quel
 *   logging source-interface zorglub  -> accepte, RENDU tel quel
 *   ip ssh source-interface zorglub   -> accepte, RENDU tel quel
 *   ip domain-lookup source-interface zorglub -> accepte
 *   logging source-interface Gi0/0 extra -> accepte, RENDU avec le mot
 *
 * CE QUE LA MESURE A CORRIGE, ET C'EST LE POINT DU LOT. Deux de ces
 * declarations portent un COMMENTAIRE qui explique le choix de `WORD` :
 * « la place accepte un nom d'interface abrege que le type `INTERFACE`
 * refuserait ». L'affirmation est FAUSSE, et le temoin de ce
 * laboratoire la contredit dans les deux sens :
 *
 *   - `snmp-server trap-source Gi0/0` est ACCEPTE aujourd'hui, sous
 *     `INTERFACE` — l'expression du type est `^[A-Za-z][A-Za-z-]*[0-9]+
 *     (\/[0-9]+)*(\.[0-9]+)?$`, qui reconnait `Gi0/0`, `Lo0`, `Fa0/1`,
 *     `Te1/0/1`, `Port-channel1` et `Vlan10` ;
 *   - la forme SCINDEE (`GigabitEthernet 0/0`), la seule que ce type
 *     refuse vraiment, est DEJA refusee par les cinq places, y compris
 *     celles en `WORD` : leur declaration ne prend qu'un jeton.
 *
 * Le commentaire decrivait donc un risque qui n'existe pas, et c'est ce
 * qui a laisse quatre places ouvertes. Un test l'avait fige avec lui —
 * `probe-cli-arguments-types` exigeait litteralement `WORD` pour
 * `logging source-interface`, sous un titre qui dit « une interface un
 * nom d'interface » : il encodait le defaut comme contrat, et il est
 * corrige plutot que le code.
 *
 * LA CONSEQUENCE N'EST PAS COSMETIQUE. Ces quatre lignes partent dans la
 * configuration rendue, qui est REJOUEE a l'import d'une topologie : une
 * faute de frappe sur le nom d'interface devient une ligne permanente
 * que rien ne signale, et le service concerne — NTP, syslog, le client
 * SSH, le resolveur — emet depuis l'adresse d'une interface qui n'existe
 * pas, c'est-a-dire depuis celle que le routage choisit, en silence.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que l'interface
 * EXISTE. Le temoin accepte `Loopback9` sur une machine qui n'en a pas,
 * et c'est la regle deja etablie de ce depot — la place controle la
 * FORME. Exiger l'existence est une autre decision, qui se prendrait
 * pour les cinq places ensemble et qu'aucune capture n'appuie ici.
 *
 * DEUX DEFAUTS TROUVES EN CHEMIN, ET SEUL LE SECOND EST FERME ICI.
 *
 * (a) `logging source-interface Gi0/0 extra` reste ACCEPTE et rendu avec
 *     le mot de trop. La declaration est pourtant juste et le socle
 *     refuse : c'est le glouton `logging` du TRIE qui reprend la frappe
 *     et joint le reste. La regle qui manque — « le socle a REFUSE cette
 *     ligne, le trie ne la reprend pas » — touche `tryMigratedCommand`
 *     et non cette famille ; inscrite au `TODO.md`.
 *
 * (b) `no ip domain-lookup source-interface`, tape SANS la valeur comme
 *     sur IOS, repondait `% Incomplete command.` alors que le
 *     gestionnaire du trie derriere accepte les deux formes : il n'etait
 *     jamais atteint, la place declaree etant EXIGEE des deux cotes.
 *     `AdapterKeyword.undoWithoutArgument` pose pour un mot-cle ce que
 *     le socle porte deja pour une commande entiere (`ip ospf cost` se
 *     nie sans son nombre), et il REUTILISE le meme mecanisme : un
 *     chemin nu qui n'existe QUE nie, dont la forme positive repond
 *     `% Incomplete command.`. La premiere version posait `undoArgs: []`
 *     sur la declaration, ce qui ne faisait RIEN — c'est une notion de
 *     `SequenceFamily`, que `CommandSpec` ne lit pas — soit exactement
 *     le critere range et jamais evalue que ce depot proscrit.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 13 des 36
 * cas tombent avant correctif. Les 23 autres sont nommes ici :
 *
 *   - les TROIS cas du TEMOIN, qui sont la PREUVE que la regle vaut deja
 *     sur cette machine et non des temoins au sens ordinaire — sans eux,
 *     rien ne dirait que le type etroit accepte `Gi0/0` ;
 *   - les DOUZE cas « une vraie interface reste acceptee », qui
 *     passaient parce que `WORD` accepte tout : ils gardent desormais
 *     que le resserrement n'a rien casse, ce qui est leur seul role ;
 *   - le cas d'aide du temoin, deja en `IFACE` ;
 *   - les SEPT cas de non-regression, dont trois formes `no` qui
 *     fonctionnaient deja et quatre commandes voisines de la meme
 *     famille — sans eux, un correctif qui refuserait toute la famille
 *     satisferait la sonde.
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

interface Dev {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
}

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

const PLACES: readonly string[] = [
  'ntp source',
  'logging source-interface',
  'ip ssh source-interface',
  'ip domain-lookup source-interface',
];

const TEMOIN = 'snmp-server trap-source';

describe('le TEMOIN dit ce que la regle vaut deja sur cette machine', () => {
  it(`\`${TEMOIN} zorglub\` est refuse`, async () => {
    const d = routeur('T1');
    expect(await conf(d, `${TEMOIN} zorglub`)).toContain('% Invalid input');
  });

  it(`\`${TEMOIN} Gi0/0\` — abrege — reste accepte et rendu`, async () => {
    const d = routeur('T2');
    expect(await conf(d, `${TEMOIN} Gi0/0`)).not.toContain('%');
    expect(await config(d)).toContain(`${TEMOIN} Gi0/0`);
  });

  it(`et \`${TEMOIN} GigabitEthernet 0/0\` — scinde — est refuse`, async () => {
    const d = routeur('T3');
    expect(await conf(d, `${TEMOIN} GigabitEthernet 0/0`)).toContain('% Invalid input');
  });
});

describe('les quatre places soeurs refusent ce qui n est pas une interface', () => {
  it.each(PLACES)('`%s zorglub` rend le caret', async (place) => {
    const d = routeur(`A${cle(place)}`);
    expect(await conf(d, `${place} zorglub`)).toContain('% Invalid input');
  });

  it.each(PLACES)('et `%s zorglub` ne laisse rien dans la configuration', async (place) => {
    const d = routeur(`B${cle(place)}`);
    await conf(d, `${place} zorglub`);
    expect(await config(d)).not.toContain('zorglub');
  });

});

describe('et elles acceptent toujours une vraie interface', () => {
  it.each(PLACES)('`%s GigabitEthernet0/0` reste accepte et rendu', async (place) => {
    const d = routeur(`C${cle(place)}`);
    expect(await conf(d, `${place} GigabitEthernet0/0`)).not.toContain('%');
    expect(await config(d)).toContain(`${place} GigabitEthernet0/0`);
  });

  it.each(PLACES)('`%s Gi0/0` — la forme abregee — aussi', async (place) => {
    const d = routeur(`D${cle(place)}`);
    expect(await conf(d, `${place} Gi0/0`)).not.toContain('%');
    expect(await config(d)).toContain(`${place} Gi0/0`);
  });

  it.each(PLACES)('`%s Loopback9` : la place controle la FORME, pas l existence',
    async (place) => {
      const d = routeur(`E${cle(place)}`);
      expect(await conf(d, `${place} Loopback9`)).not.toContain('%');
    });
});

describe('l aide annonce le meme type aux cinq places', () => {
  it.each([...PLACES, TEMOIN])('`%s ?` annonce IFACE', async (place) => {
    const d = routeur(`F${cle(place)}`);
    await conf(d);
    const aide = d.cliHelp(`${place} `);
    expect(aide).toContain('IFACE');
    expect(aide).not.toMatch(/^\s*WORD\b/m);
  });
});

describe('non-regression — la forme `no` et les autres arguments', () => {
  it.each(PLACES)('`no %s` retire la ligne', async (place) => {
    const d = routeur(`G${cle(place)}`);
    await conf(d, `${place} GigabitEthernet0/0`, `no ${place}`);
    expect(await config(d)).not.toContain(`${place} GigabitEthernet0/0`);
  });

  it('`ip domain-lookup` nu reste accepte', async () => {
    const d = routeur('HD');
    expect(await conf(d, 'ip domain-lookup')).not.toContain('%');
  });

  it('`ntp server 10.0.0.1` reste accepte', async () => {
    const d = routeur('HN');
    expect(await conf(d, 'ntp server 10.0.0.1')).not.toContain('%');
  });

  it('`logging host 10.0.0.1` reste accepte', async () => {
    const d = routeur('HL');
    expect(await conf(d, 'logging host 10.0.0.1')).not.toContain('%');
  });

  it('`ip ssh version 2` reste accepte', async () => {
    const d = routeur('HS');
    expect(await conf(d, 'ip ssh version 2')).not.toContain('%');
  });
});
