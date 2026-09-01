/*
 * Sonde ECRITE A L'AVEUGLE, avant toute lecture du code, depuis la
 * documentation IOS des controles ICMP/ARP portes par une interface :
 * `ip redirects`, `ip unreachables`, `ip proxy-arp` et `ip mask-reply`.
 *
 * Ce que la reference dit :
 *   - les trois premiers sont ACTIVES par defaut, `mask-reply` est
 *     DESACTIVE (« by default, the router does not respond to ICMP mask
 *     requests ») ; seul l'ECART au defaut paraît dans la configuration.
 *   - un Catalyst porte les memes commandes sur sa SVI, l'IOS etant le
 *     meme : `no ip redirects` / `no ip proxy-arp` sur une `interface
 *     Vlan` sont meme la recommandation de durcissement la plus
 *     repandue, et les guides STIG imposent `no ip mask-reply` sur un
 *     COMMUTATEUR comme sur un routeur.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     ce qui n'y paraît pas est perdu.
 *
 * Ce fichier ne REDIT pas ce que d'autres pinnent deja : le va-et-vient
 * des trois controles du routeur appartient a
 * `interface-icmp-proxyarp-toggle.test.ts`, et leur EFFET sur le plan de
 * donnees a `icmp-no-ip-unreachables.test.ts`. Ce qui est eprouve ici
 * est ce qu'aucun des deux ne couvre : `mask-reply`, le commutateur, et
 * l'accord des deux plateformes.
 *
 * Discrimine par `git stash` : 19 des 26 cas tombent avant correctif.
 * Les 7 qui passent des DEUX cotes sont nommes ici plutot que laisses a
 * decouvrir, chacun avec la raison pour laquelle il ne pouvait pas
 * discriminer :
 *   - « le defaut ne paraît pas » et « la remettre au defaut la fait
 *     DISPARAITRE » passaient VACUEMENT : `ip mask-reply` n'existait
 *     pas, donc rien n'etait range et rien ne pouvait paraître. Ils
 *     gardent la convention, ils ne prouvent pas la commande.
 *   - « TEMOIN : sans la commande, le commutateur repond bien un
 *     inatteignable » : c'est son objet. Sans lui, un laboratoire mal
 *     bati et une coupure reussie seraient indiscernables.
 *   - « `ip unreachables` remet le message » passait parce que rien ne
 *     faisait taire quoi que ce soit avant.
 *   - les trois derniers sont les cas de NON-REGRESSION du routeur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

async function jouer(d: Cli, lignes: string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

function routeur(): Cli {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  return r;
}

function commutateur(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  return s;
}

const IF_ROUTEUR = 'GigabitEthernet0/0';
const IF_COMMUTATEUR = 'Vlan1';

const ENTREE_ROUTEUR = [
  'enable', 'configure terminal', `interface ${IF_ROUTEUR}`,
  'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
];
const ENTREE_COMMUTATEUR = [
  'enable', 'configure terminal', `interface ${IF_COMMUTATEUR}`,
  'ip address 10.0.0.2 255.255.255.0', 'no shutdown',
];

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

async function vueIp(d: Cli, nom: string): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand(`show ip interface ${nom}`);
}

const CONTROLES = ['redirects', 'unreachables', 'proxy-arp', 'mask-reply'] as const;

/*
 * La DESCRIPTION seule, sans le rembourrage de colonne. Comparer la
 * ligne entiere serait comparer une LARGEUR : IOS dimensionne la
 * colonne sur le plus long mot-cle de la liste, et les deux plateformes
 * n'ont pas les memes enfants sous `ip` — le routeur en a de plus longs.
 * Une premiere version de cette sonde comparait la ligne et echouait sur
 * l'ecart de blancs, en accusant le produit d'une divergence de texte
 * qui n'existait pas.
 */
function ligneDecrivant(aide: string, mot: string): string {
  const ligne = aide.split('\n').find((l) => new RegExp(`^\\s+${mot}\\s`).test(l)) ?? '';
  return ligne.trim().replace(new RegExp(`^${mot}\\s+`), '');
}

describe('`ip mask-reply` existe et suit la convention d IOS', () => {
  it('la commande est acceptee sur le routeur', async () => {
    const r = routeur();
    await jouer(r, ENTREE_ROUTEUR);
    expect(await r.executeCommand('ip mask-reply')).not.toMatch(/Invalid input|Incomplete/);
    expect(await r.executeCommand('no ip mask-reply')).not.toMatch(/Invalid input|Incomplete/);
  });

  it('desactive par defaut, c est son ACTIVATION qui paraît dans la configuration', async () => {
    const r = routeur();
    await jouer(r, [...ENTREE_ROUTEUR, 'ip mask-reply']);
    expect(await conf(r)).toMatch(/^\s*ip mask-reply\s*$/m);
  });

  it('le defaut ne paraît pas', async () => {
    const r = routeur();
    await jouer(r, ENTREE_ROUTEUR);
    expect(await conf(r)).not.toMatch(/mask-reply/);
  });

  it('la remettre au defaut la fait DISPARAITRE de la configuration', async () => {
    const r = routeur();
    await jouer(r, [...ENTREE_ROUTEUR, 'ip mask-reply', 'no ip mask-reply']);
    expect(await conf(r)).not.toMatch(/mask-reply/);
  });

  it('`show ip interface` en rend compte dans les deux sens', async () => {
    const r = routeur();
    await jouer(r, ENTREE_ROUTEUR);
    expect(await vueIp(r, IF_ROUTEUR)).toContain('ICMP mask replies are never sent');
    await jouer(r, ['configure terminal', `interface ${IF_ROUTEUR}`, 'ip mask-reply']);
    expect(await vueIp(r, IF_ROUTEUR)).toContain('ICMP mask replies are always sent');
  });

  it('elle ne prend aucun argument', async () => {
    const r = routeur();
    await jouer(r, ENTREE_ROUTEUR);
    expect(r.cliHelp('ip mask-reply ')).toContain('<cr>');
    expect(await r.executeCommand('ip mask-reply zorglub')).toMatch(/Invalid input/);
  });

  /*
   * La SECONDE interface porte une adresse, et il le faut : sans elle
   * `show ip interface` s'arrete a « Internet protocol processing
   * disabled », ce que fait un vrai IOS, et la sonde accusait le produit
   * de ne pas rendre une ligne qu'aucune machine ne rend.
   */
  it('elle est PROPRE A L INTERFACE', async () => {
    const r = routeur();
    await jouer(r, [...ENTREE_ROUTEUR, 'ip mask-reply',
      'exit', 'interface GigabitEthernet0/1',
      'ip address 10.0.1.1 255.255.255.0', 'no shutdown']);
    expect(await vueIp(r, 'GigabitEthernet0/0')).toContain('ICMP mask replies are always sent');
    expect(await vueIp(r, 'GigabitEthernet0/1')).toContain('ICMP mask replies are never sent');
  });
});

describe('un Catalyst porte les memes controles sur sa SVI', () => {
  for (const mot of CONTROLES) {
    it(`\`no ip ${mot}\` est ACCEPTE`, async () => {
      const s = commutateur();
      await jouer(s, ENTREE_COMMUTATEUR);
      expect(await s.executeCommand(`no ip ${mot}`))
        .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
      expect(await s.executeCommand(`ip ${mot}`))
        .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
    });
  }

  it('`no ip redirects` paraît dans la configuration du commutateur', async () => {
    const s = commutateur();
    await jouer(s, [...ENTREE_COMMUTATEUR, 'no ip redirects']);
    expect(await conf(s)).toMatch(/^\s*no ip redirects\s*$/m);
  });

  it('`no ip proxy-arp` paraît dans la configuration du commutateur', async () => {
    const s = commutateur();
    await jouer(s, [...ENTREE_COMMUTATEUR, 'no ip proxy-arp']);
    expect(await conf(s)).toMatch(/^\s*no ip proxy-arp\s*$/m);
  });

  it('les quatre coexistent sur une meme SVI', async () => {
    const s = commutateur();
    await jouer(s, [...ENTREE_COMMUTATEUR,
      'no ip redirects', 'no ip unreachables', 'no ip proxy-arp', 'ip mask-reply']);
    const texte = await conf(s);
    expect(texte).toMatch(/no ip redirects/);
    expect(texte).toMatch(/no ip unreachables/);
    expect(texte).toMatch(/no ip proxy-arp/);
    expect(texte).toMatch(/ip mask-reply/);
  });

  it('`show ip interface Vlan1` LIT la configuration au lieu de reciter des constantes', async () => {
    const s = commutateur();
    await jouer(s, ENTREE_COMMUTATEUR);
    const avant = await vueIp(s, IF_COMMUTATEUR);
    expect(avant).toContain('ICMP redirects are always sent');
    expect(avant).toContain('ICMP unreachables are always sent');
    expect(avant).toContain('Proxy ARP is enabled');
    expect(avant).toContain('ICMP mask replies are never sent');

    await jouer(s, ['configure terminal', `interface ${IF_COMMUTATEUR}`,
      'no ip redirects', 'no ip unreachables', 'no ip proxy-arp', 'ip mask-reply']);
    const apres = await vueIp(s, IF_COMMUTATEUR);
    expect(apres).toContain('ICMP redirects are never sent');
    expect(apres).toContain('ICMP unreachables are never sent');
    expect(apres).toContain('Proxy ARP is disabled');
    expect(apres).toContain('ICMP mask replies are always sent');
  });

  it('le controle est propre a UNE SVI, pas au commutateur', async () => {
    const s = commutateur();
    await jouer(s, ['enable', 'configure terminal', 'vlan 20', 'exit',
      'interface Vlan1', 'ip address 10.0.0.2 255.255.255.0', 'no ip redirects',
      'exit', 'interface Vlan20', 'ip address 10.0.20.2 255.255.255.0']);
    expect(await vueIp(s, 'Vlan1')).toContain('ICMP redirects are never sent');
    expect(await vueIp(s, 'Vlan20')).toContain('ICMP redirects are always sent');
  });
});

describe('les deux plateformes repondent la MEME chose', () => {
  let r: Cli; let s: Cli;
  beforeEach(async () => {
    r = routeur(); s = commutateur();
    await jouer(r, ENTREE_ROUTEUR);
    await jouer(s, ENTREE_COMMUTATEUR);
  });

  it('l aide de `ip ?` annonce les quatre controles des deux cotes', () => {
    for (const mot of CONTROLES) {
      expect(r.cliHelp('ip ')).toMatch(new RegExp(`^\\s+${mot}\\b`, 'm'));
      expect(s.cliHelp('ip ')).toMatch(new RegExp(`^\\s+${mot}\\b`, 'm'));
    }
  });

  it('la DESCRIPTION de chaque controle est la meme sur les deux', () => {
    for (const mot of CONTROLES) {
      const cote = ligneDecrivant(r.cliHelp('ip '), mot);
      expect(cote.length).toBeGreaterThan(mot.length);
      expect(ligneDecrivant(s.cliHelp('ip '), mot)).toBe(cote);
    }
  });

  it('chaque controle porte une description PROPRE, jamais celle d un voisin', () => {
    const vues = new Set<string>();
    for (const mot of CONTROLES) {
      const d = ligneDecrivant(r.cliHelp('ip '), mot).replace(new RegExp(`^${mot}\\s+`), '');
      expect(d.length).toBeGreaterThan(0);
      expect(vues.has(d)).toBe(false);
      vues.add(d);
    }
  });

  it('les quatre lignes de `show ip interface` sont ECRITES PAREIL des deux cotes', async () => {
    const extrait = (texte: string): string[] => texte.split('\n')
      .filter((l) => /ICMP redirects|ICMP unreachables|Proxy ARP is|ICMP mask replies/.test(l))
      .map((l) => l.trim());
    expect(extrait(await vueIp(s, IF_COMMUTATEUR)))
      .toEqual(extrait(await vueIp(r, IF_ROUTEUR)));
  });
});

/*
 * Une commande acceptee, rangee et affichee sans EFFET serait le defaut
 * que ce depot referme sans cesse. Le laboratoire fait donc traverser un
 * VRAI paquet vers une destination que le commutateur ne sait pas
 * joindre, et compte les messages ICMP que le poste recoit en retour.
 * Le cas SANS la commande est le TEMOIN : sans lui, un laboratoire mal
 * bati et une coupure reussie seraient indiscernables.
 */
describe('sur un Catalyst, `no ip unreachables` fait vraiment taire l ICMP', () => {
  const attendre = (ms = 80) => new Promise<void>((r) => setTimeout(r, ms));

  async function laboratoire() {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
    sw.powerOn(); pc.powerOn();
    new Cable('a').connect(pc.getPort('eth0')!, sw.getPorts()[0]!);
    await jouer(sw as unknown as Cli, [
      'enable', 'configure terminal', 'ip routing', 'vlan 10', 'exit',
      `interface ${sw.getPorts()[0]!.getName()}`,
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
    ]);
    await jouer(pc as unknown as Cli, ['ip link set eth0 up']);
    pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    await jouer(pc as unknown as Cli, ['ip route add default via 10.0.0.1']);
    return { sw, pc };
  }

  function guetterIcmp(pc: LinuxPC): string[] {
    const vus: string[] = [];
    (pc as unknown as { getBus(): { subscribe(t: string, f: (e: unknown) => void): void } })
      .getBus().subscribe('host.icmp.echo-failed', (e: unknown) => {
        const raison = (e as { payload?: { reason?: string } }).payload?.reason;
        if (raison) vus.push(raison);
      });
    return vus;
  }

  it('TEMOIN : sans la commande, le commutateur repond bien un inatteignable', async () => {
    const { pc } = await laboratoire();
    const vus = guetterIcmp(pc);
    await pc.executeCommand('ping -c 1 -W 1 10.9.9.9');
    await attendre();
    expect(vus.length).toBeGreaterThan(0);
  });

  it('avec `no ip unreachables` sur la SVI d entree, plus rien ne revient', async () => {
    const { sw, pc } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal', 'interface Vlan10',
      'no ip unreachables', 'end']);
    const vus = guetterIcmp(pc);
    await pc.executeCommand('ping -c 1 -W 1 10.9.9.9');
    await attendre();
    expect(vus).toEqual([]);
  });

  it('`ip unreachables` remet le message', async () => {
    const { sw, pc } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal', 'interface Vlan10',
      'no ip unreachables', 'ip unreachables', 'end']);
    const vus = guetterIcmp(pc);
    await pc.executeCommand('ping -c 1 -W 1 10.9.9.9');
    await attendre();
    expect(vus.length).toBeGreaterThan(0);
  });
});

describe('TEMOINS — le routeur garde ce qu il savait deja', () => {
  it('`no ip redirects` paraît toujours dans la configuration du routeur', async () => {
    const r = routeur();
    await jouer(r, [...ENTREE_ROUTEUR, 'no ip redirects']);
    expect(await conf(r)).toMatch(/^\s*no ip redirects\s*$/m);
  });

  it('`no ip proxy-arp` se relit toujours dans `show ip interface`', async () => {
    const r = routeur();
    await jouer(r, [...ENTREE_ROUTEUR, 'no ip proxy-arp']);
    expect(await vueIp(r, IF_ROUTEUR)).toContain('Proxy ARP is disabled');
  });

  it('une route statique se pose et se relit', async () => {
    const r = routeur();
    await jouer(r, ['enable', 'configure terminal',
      'ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
    expect(await conf(r)).toMatch(/ip route 10\.9\.0\.0 255\.255\.0\.0 10\.0\.0\.254/);
  });
});
