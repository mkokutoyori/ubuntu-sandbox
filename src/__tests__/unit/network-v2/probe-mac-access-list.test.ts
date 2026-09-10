/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation Cisco, avant toute
 * ligne de code.
 *
 * cisco.com est bloque par le mandataire de sortie de ce reseau, mais
 * la RECHERCHE, elle, l'atteint : la grammaire ci-dessous vient des
 * guides Cisco eux-memes (Access Control List Configuration Guide,
 * « MAC Access Control Lists » ; LAN Switching Command Reference,
 * « mac access-group ») et non d'une page d'un autre constructeur — un
 * `mac-access-list` Aruba ou HPE ne s'ecrit pas pareil, et les
 * confondre serait invoquer une autorite qui ne s'applique pas.
 *
 * Ce que la reference dit :
 *   `mac access-list extended <nom>` — depuis la configuration globale,
 *   ouvre le sous-mode dont l'invite est `(config-ext-macl)#` ;
 *   `{permit | deny} {any | host <src-mac>} {any | host <dst-mac>}` ;
 *   exemples cites : `permit any host 0000.0000.0009`,
 *   `permit host 00aa.bbcc.ddeb host 00bb.bbcc.ddeb` ;
 *   `mac access-group <nom> in` sur une interface — les MAC ACL ne
 *   s'appliquent QU'EN ENTREE, il n'y a pas de sens `out`.
 *
 * Une adresse MAC s'y ecrit en triplets pointes, `xxxx.xxxx.xxxx`.
 *
 * POURQUOI CELA COMPTE : une liste MAC est le seul filtre d'un
 * commutateur qui decide sur la couche 2. Une liste acceptee par la CLI
 * mais qu'aucune trame ne traverse n'est pas une demi-fonction, c'est un
 * port qu'on croit protege. La sonde exige donc que la trame TOMBE
 * vraiment — mesuree par la difference entre le meme echange avec et
 * sans la liaison.
 *
 * Discriminee contre l'etat d'avant : 28 des 38 cas tombaient — la
 * famille n'existait pas. Les 10 autres sont nommes ici plutot que
 * laisses a decouvrir : ce sont les REFUS, les INCOMPLETUDES et les
 * deux TEMOINS. Les refus passaient pour la MAUVAISE raison — `permit
 * zorglub any` etait bien refuse au caret, mais parce que `mac
 * access-list` n'existait pas et qu'on ne pouvait donc pas entrer dans
 * la liste : le refus portait sur la commande d'avant. Ils gardent
 * aujourd'hui ce qu'ils pretendent mesurer. Les deux temoins, eux,
 * doivent passer des deux cotes : sans eux, un simulateur qui aurait
 * simplement casse le commutateur satisferait toute la sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import {
  MACAddress, IPAddress, resetCounters, ETHERTYPE_ARP, type EthernetFrame,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

const jouer = async (d: Cmd, lignes: readonly string[]): Promise<string> => {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
};

type Cli = Cmd & {
  cliHelp: (s: string) => string;
  getPrompt: () => string;
  powerOn: () => void;
  getPort: (nom: string) => Port | undefined;
};

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

describe('`mac access-list extended` se declare', () => {
  it('ouvre son sous-mode, dont l invite est `(config-ext-macl)`', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('mac access-list extended MACL'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(d.getPrompt()).toMatch(/\(config-ext-macl\)#$/);
  });

  it('`exit` en ressort', async () => {
    const d = await commutateur();
    await d.executeCommand('mac access-list extended MACL');
    await d.executeCommand('exit');
    expect(d.getPrompt()).toMatch(/\(config\)#$/);
  });

  it('sans nom, elle est INCOMPLETE', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('mac access-list extended'))
      .toMatch(/Incomplete command/);
  });

  it('`mac access-list` seul est INCOMPLET', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('mac access-list')).toMatch(/Incomplete command/);
  });

  it('`mac access-list ?` annonce `extended`', async () => {
    const d = await commutateur();
    expect(mots(d.cliHelp('mac access-list '))).toContain('extended');
  });

  it('une sorte inventee est refusee', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('mac access-list zorglub MACL'))
      .toMatch(/Invalid input/);
  });

  it('la liste vide se relit dans la configuration', async () => {
    const d = await commutateur();
    await d.executeCommand('mac access-list extended MACL');
    expect(await conf(d)).toContain('mac access-list extended MACL');
  });

  it('`no mac access-list extended` la retire', async () => {
    const d = await commutateur();
    await jouer(d, ['mac access-list extended MACL', 'exit']);
    expect(await d.executeCommand('no mac access-list extended MACL'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('mac access-list extended MACL');
  });
});

describe('les entrees d une liste MAC', () => {
  const dansLaListe = async (): Promise<Cli> => {
    const d = await commutateur();
    await d.executeCommand('mac access-list extended MACL');
    return d;
  };

  const ACCEPTEES: readonly string[] = [
    'permit any any',
    'deny any any',
    'permit any host 0000.0000.0009',
    'permit host 00aa.bbcc.ddeb host 00bb.bbcc.ddeb',
    'deny host 00aa.bbcc.ddeb any',
  ];
  for (const ligne of ACCEPTEES) {
    it(`\`${ligne}\` se pose et se relit`, async () => {
      const d = await dansLaListe();
      expect(await d.executeCommand(ligne)).not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain(` ${ligne}`);
    });
  }

  const REFUSEES: readonly string[] = [
    'permit zorglub any',
    'permit any zorglub',
    'permit host zorglub any',
    'permit host 00aa.bbcc.ddeb zorglub',
  ];
  for (const ligne of REFUSEES) {
    it(`\`${ligne}\` est refusee au caret`, async () => {
      const d = await dansLaListe();
      expect(await d.executeCommand(ligne))
        .toMatch(/Invalid input detected at '\^' marker/);
      expect(await conf(d)).not.toContain('zorglub');
    });
  }

  const INCOMPLETES: readonly string[] = ['permit', 'deny', 'permit any', 'permit host'];
  for (const ligne of INCOMPLETES) {
    it(`\`${ligne}\` est INCOMPLETE`, async () => {
      const d = await dansLaListe();
      expect(await d.executeCommand(ligne)).toMatch(/Incomplete command/);
    });
  }

  it('`?` annonce `any` et `host` a la source', async () => {
    const d = await dansLaListe();
    expect(mots(d.cliHelp('permit '))).toEqual(expect.arrayContaining(['any', 'host']));
  });

  it('`?` annonce `any` et `host` a la destination', async () => {
    const d = await dansLaListe();
    expect(mots(d.cliHelp('permit any '))).toEqual(expect.arrayContaining(['any', 'host']));
  });

  it('`no` retire l entree', async () => {
    const d = await dansLaListe();
    await d.executeCommand('permit any any');
    expect(await d.executeCommand('no permit any any')).not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('permit any any');
  });
});

describe('`mac access-group` lie la liste a un port', () => {
  const surUnPort = async (): Promise<Cli> => {
    const d = await commutateur();
    await jouer(d, [
      'mac access-list extended MACL', 'permit any any', 'exit',
      'interface FastEthernet0/1',
    ]);
    return d;
  };

  it('le sens `in` est accepte et se relit', async () => {
    const d = await surUnPort();
    expect(await d.executeCommand('mac access-group MACL in'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).toContain('mac access-group MACL in');
  });

  it('le sens `out` est REFUSE — une MAC ACL ne filtre qu en entree', async () => {
    const d = await surUnPort();
    expect(await d.executeCommand('mac access-group MACL out')).toMatch(/Invalid input/);
    expect(await conf(d)).not.toContain('mac access-group');
  });

  it('`?` n annonce que `in`', async () => {
    const d = await surUnPort();
    expect(mots(d.cliHelp('mac access-group MACL '))).toEqual(['in']);
  });

  it('une liste INCONNUE ne se lie pas', async () => {
    const d = await surUnPort();
    expect(await d.executeCommand('mac access-group ABSENTE in')).toMatch(/^%/);
    expect(await conf(d)).not.toContain('mac access-group ABSENTE');
  });

  it('sans sens, la commande est INCOMPLETE', async () => {
    const d = await surUnPort();
    expect(await d.executeCommand('mac access-group MACL')).toMatch(/Incomplete command/);
  });

  it('`no mac access-group` delie', async () => {
    const d = await surUnPort();
    await d.executeCommand('mac access-group MACL in');
    expect(await d.executeCommand('no mac access-group MACL in'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('mac access-group MACL in');
  });
});

/*
 * Le filtrage est-il REEL, et filtre-t-il ce qu'il DOIT filtrer ?
 *
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE, et c'est la reference qui
 * l'a corrigee, non le code. J'avais ecrit qu'une liste MAC refusant la
 * source de H1 ferait tomber son ping. Elle le fait — mais pas pour la
 * raison que je croyais, et la nuance est tout le sujet :
 *
 *   « The IP access list filters only IP packets, and the MAC access
 *     list filters non-IP packets. […] you can apply it to a Layer 2
 *     interface to filter non-IP traffic coming in that interface. »
 *     (Cisco, Configuring Network Security with ACLs, Catalyst 2960 ;
 *     meme phrase dans les guides Catalyst 9300 et 3650)
 *
 * Une liste MAC ne voit donc JAMAIS un paquet IPv4. Ce qu'elle bloque,
 * c'est l'ARP — et le ping tombe faute de resolution, pas parce que
 * l'echo a ete filtre. La difference se mesure : avec une entree ARP
 * STATIQUE des deux cotes, la meme liste laisse passer le meme ping.
 *
 * Implanter la premisse fausse aurait donne un simulateur ou l'on
 * apprend qu'une MAC ACL filtre l'IP — exactement ce qu'un vrai
 * Catalyst ne fait pas, et le genre d'erreur qu'un eleve emporte.
 */
describe('une liste MAC posee sur un port filtre vraiment', () => {
  async function laboratoire(): Promise<{
    sw: Cli; h1: LinuxPC; h2: LinuxPC; macH1: string; macH2: string;
  }> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
    sw.powerOn();
    const h1 = new LinuxPC('linux-pc', 'H1', -100, 0);
    const h2 = new LinuxPC('linux-pc', 'H2', 100, 0);
    new Cable('a').connect(h1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(h2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await jouer(h1 as unknown as Cmd, ['ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up']);
    await jouer(h2 as unknown as Cmd, ['ip addr add 10.0.0.2/24 dev eth0', 'ip link set eth0 up']);
    await jouer(sw, ['enable', 'configure terminal']);
    const macH1 = h1.getPort('eth0')!.getMAC().toString();
    const macH2 = h2.getPort('eth0')!.getMAC().toString();
    return { sw, h1, h2, macH1, macH2 };
  }

  const enPointille = (mac: string): string => {
    const hex = mac.replace(/[:.-]/g, '').toLowerCase();
    return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
  };

  it('TEMOIN : sans liste, le ping passe', async () => {
    const { h1 } = await laboratoire();
    const out = await pingOnSimulatedClock(
      h1 as unknown as Parameters<typeof pingOnSimulatedClock>[0],
      'ping -c 2 10.0.0.2');
    expect(out).toContain('0% packet loss');
  });

  const poser = (sw: Cli, nom: string, entrees: readonly string[]) => jouer(sw, [
    `mac access-list extended ${nom}`,
    ...entrees,
    'exit',
    'interface FastEthernet0/1',
    `mac access-group ${nom} in`,
    'end',
  ]);

  /**
   * Une trame ARP REELLE, poussee sur le cable par le port de H1.
   *
   * C'est bien le fil qui la porte — `Port.sendFrame` la remet au cable,
   * qui la remet au port d'en face. On observe si elle ATTEINT H2. Ce
   * chemin-la isole le filtre : il montre la trame arretee elle-meme,
   * la ou le ping ci-dessous montre ce que l'operateur en subit.
   */
  async function arpTraverse(
    h1: LinuxPC, h2: LinuxPC, srcMac: MACAddress,
  ): Promise<boolean> {
    let recue = false;
    const port2 = h2.getPort('eth0')!;
    const original = port2.receiveFrame.bind(port2);
    (port2 as unknown as { receiveFrame: (f: EthernetFrame) => void }).receiveFrame =
      (f: EthernetFrame) => {
        if (f.etherType === ETHERTYPE_ARP) recue = true;
        original(f);
      };
    const trame: EthernetFrame = {
      srcMAC: srcMac,
      dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'),
      etherType: ETHERTYPE_ARP,
      payload: {
        operation: 1,
        senderMAC: srcMac, senderIP: new IPAddress('10.0.0.1'),
        targetMAC: new MACAddress('00:00:00:00:00:00'),
        targetIP: new IPAddress('10.0.0.2'),
      } as unknown as EthernetFrame['payload'],
    };
    h1.getPort('eth0')!.sendFrame(trame);
    await Promise.resolve();
    return recue;
  }

  it('TEMOIN : sans liste, une trame ARP traverse', async () => {
    const { h1, h2, macH1 } = await laboratoire();
    expect(await arpTraverse(h1, h2, new MACAddress(macH1))).toBe(true);
  });

  it('une liste qui REFUSE la source arrete sa trame ARP', async () => {
    const { sw, h1, h2, macH1 } = await laboratoire();
    await poser(sw, 'BLOQUE', [`deny host ${enPointille(macH1)} any`, 'permit any any']);
    expect(await arpTraverse(h1, h2, new MACAddress(macH1))).toBe(false);
  });

  it('une liste qui PERMET la source laisse passer sa trame ARP', async () => {
    const { sw, h1, h2, macH1 } = await laboratoire();
    await poser(sw, 'PASSE', [`permit host ${enPointille(macH1)} any`]);
    expect(await arpTraverse(h1, h2, new MACAddress(macH1))).toBe(true);
  });

  it('une liste VIDE arrete tout le non-IP, comme le deny implicite d IOS', async () => {
    const { sw, h1, h2, macH1 } = await laboratoire();
    await poser(sw, 'VIDE', []);
    expect(await arpTraverse(h1, h2, new MACAddress(macH1))).toBe(false);
  });

  /*
   * LA nuance de fidelite : meme une liste qui refuse TOUT laisse
   * passer l'IP, parce qu'une liste MAC ne filtre que le non-IP. Un
   * simulateur qui bloquerait le ping ici apprendrait le contraire de
   * ce que fait un vrai Catalyst.
   *
   * Le cache ARP de H1 est CHAUD : les deux postes se sont annonces en
   * montant leur lien, comme le fait un hote reel. C'est ce qui rend ce
   * cas lisible — l'echo part sans resolution a faire, donc ce qu'on
   * observe est bien le sort du paquet IP et rien d'autre.
   */
  it('une liste qui refuse TOUT ne filtre pas l IP : le ping passe', async () => {
    const { sw, h1 } = await laboratoire();
    await poser(sw, 'RIEN', ['deny any any']);
    const out = await pingOnSimulatedClock(
      h1 as unknown as Parameters<typeof pingOnSimulatedClock>[0],
      'ping -c 2 10.0.0.2');
    expect(out).toContain('0% packet loss');
  });

  /*
   * Et le bout de la chaine, celui que l'operateur voit : cache VIDE,
   * donc une resolution a faire. La liste arrete l'ARP, la resolution
   * echoue, et le ping rend `Destination Host Unreachable` — pas une
   * perte muette. C'est la difference entre les deux cas suivants qui
   * mesure le filtre de bout en bout, pas le refus seul.
   */
  it('TEMOIN : cache vide et sans liste, la resolution aboutit', async () => {
    const { h1 } = await laboratoire();
    await h1.executeCommand('arp -d 10.0.0.2');
    const out = await pingOnSimulatedClock(
      h1 as unknown as Parameters<typeof pingOnSimulatedClock>[0],
      'ping -c 1 10.0.0.2');
    expect(out).toContain('0% packet loss');
  });

  it('cache vide, la liste arrete la resolution : hote INJOIGNABLE', async () => {
    const { sw, h1, macH1 } = await laboratoire();
    await poser(sw, 'BLOQUE', [`deny host ${enPointille(macH1)} any`, 'permit any any']);
    await h1.executeCommand('arp -d 10.0.0.2');
    const out = await pingOnSimulatedClock(
      h1 as unknown as Parameters<typeof pingOnSimulatedClock>[0],
      'ping -c 1 10.0.0.2');
    expect(out).toContain('Destination Host Unreachable');
    expect(out).toContain('100% packet loss');
  });
});
