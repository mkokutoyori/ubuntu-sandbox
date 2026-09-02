/**
 * L'aide ne se derive plus du texte source des gestionnaires.
 *
 * Defaut mesure (audit completion, G1, et ses consequences M7 et M8) :
 * un noeud glouton sans suites declarees voit ses « continuations »
 * EXTRAITES du code source de son gestionnaire. La cause exacte, mesuree
 * plutot que supposee : les commandes du mode `line` sont enregistrees
 * dans une boucle sur `kw`, et la fermeture ainsi creee porte le MEME
 * corps pour les vingt-deux — un aiguillage qui cite forcement tous les
 * mots-cles. Chaque noeud recevait donc la liste des vingt et un autres.
 *
 *     ? «speed »      ->  authentication / autocommand / banner / …
 *     TAB «password a» -> password absolute-timeout / authentication / …
 *
 * Deux regles, et chacune dit une verite sur ce que le noeud attend.
 *
 * A — un corps de fonction partage par plusieurs noeuds ne peut pas
 *     attribuer ses mots-cles. Il ne sait pas lequel des noeuds il sert.
 *
 * B — un noeud qui declare un PARAMETRE attend une valeur, pas un
 *     mot-cle. `password ?` le disait deja correctement (`LINE`), et
 *     seule la tabulation l'ignorait : le garde existait sur le rendu de
 *     `?` et pas sur celui de `Tab`.
 *
 * Mesure avant de corriger, et elle a reduit le chantier : sur les 107
 * noeuds a corps partage de la plateforme, seuls QUATRE rendaient la
 * liste du mode — `speed`, `stopbits`, `flowcontrol`, `databits`. Tous
 * les autres portent deja un parametre declare ou des suites curatees
 * (`ntp server`, `debug vrrp`, `show ip vrf`, `mdix`…) et rendent la
 * bonne chose. Les quatre recoivent leurs vraies valeurs.
 *
 * Le repli `WORD` reste la pour les gloutons que personne n'a decrits :
 * il annonce qu'un mot est attendu sans pretendre savoir lequel, ce qui
 * est vrai, la ou la liste du mode etait fausse.
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

type Dev = {
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
  executeCommand(c: string): Promise<string>;
};

const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

async function ligneConsole(nom: string): Promise<Dev> {
  const r = new CiscoRouter(nom) as unknown as Dev;
  for (const c of ['enable', 'configure terminal', 'line console 0']) await r.executeCommand(c);
  return r;
}

/** Les mots-cles du MODE `line`, qui n'ont rien a faire sous une commande. */
const MOTS_DU_MODE = ['authentication', 'autocommand', 'banner', 'absolute-timeout',
  'escape-character', 'motd-banner', 'synchronous'];

describe('A — un corps partage n attribue plus ses mots-cles', () => {
  it.each(['speed', 'stopbits', 'flowcontrol', 'databits'])(
    '`%s ?` ne rend plus la liste du mode', async (cmd) => {
      const r = await ligneConsole(`R${cmd}`);
      const rendus = mots(r.cliHelp(`${cmd} `));
      for (const parasite of MOTS_DU_MODE) {
        expect(rendus, `${cmd} ? offre ${parasite}`).not.toContain(parasite);
      }
    });

  it.each(['speed', 'stopbits', 'flowcontrol', 'databits', 'password'])(
    'et `Tab` non plus, sur `%s`', async (cmd) => {
      const r = await ligneConsole(`T${cmd}`);
      for (const c of r.cliTabCandidates(`${cmd} a`)) {
        expect(c, c).not.toMatch(/\b(absolute-timeout|authentication|autocommand)\b/);
      }
    });
});

describe('les quatre commandes recoivent leurs vraies valeurs', () => {
  it('`stopbits ?` rend 1 et 2', async () => {
    const r = await ligneConsole('RS');
    expect(mots(r.cliHelp('stopbits '))).toEqual(expect.arrayContaining(['1', '2']));
  });

  it('`databits ?` rend 5 a 8', async () => {
    const r = await ligneConsole('RD');
    expect(mots(r.cliHelp('databits '))).toEqual(expect.arrayContaining(['5', '6', '7', '8']));
  });

  it('`parity ?` rend even, none, odd', async () => {
    const r = await ligneConsole('RP');
    expect(mots(r.cliHelp('parity '))).toEqual(expect.arrayContaining(['even', 'none', 'odd']));
  });

  it('`flowcontrol ?` rend hardware, none, software', async () => {
    const r = await ligneConsole('RF');
    expect(mots(r.cliHelp('flowcontrol ')))
      .toEqual(expect.arrayContaining(['hardware', 'none', 'software']));
  });

  it('`speed ?` rend les debits usuels', async () => {
    const r = await ligneConsole('RV');
    expect(mots(r.cliHelp('speed '))).toEqual(expect.arrayContaining(['9600', '115200']));
  });

  it('et ces valeurs sont acceptees par la machine', async () => {
    const r = await ligneConsole('RW');
    for (const c of ['stopbits 1', 'databits 8', 'parity none', 'speed 9600']) {
      expect(String(await r.executeCommand(c)), c).not.toContain('Invalid input');
    }
  });
});

describe('B — un parametre declare attend une valeur, dans les deux portes', () => {
  it('`password ?` rend `LINE`, comme avant', async () => {
    const r = await ligneConsole('RB1');
    expect(mots(r.cliHelp('password '))).toEqual(['LINE']);
  });

  it('et `Tab` ne propose plus rien a cette place', async () => {
    const r = await ligneConsole('RB2');
    expect(r.cliTabCandidates('password a')).toEqual([]);
  });
});

describe('non-regression — ce qui allait deja bien ne bouge pas', () => {
  it('les groupes a corps partage QUI SONT DECLARES gardent leur aide', async () => {
    const r = new CiscoRouter('RN1') as unknown as Dev;
    await r.executeCommand('enable');
    expect(mots(r.cliHelp('debug vrrp '))).toContain('LINE');
    expect(mots(r.cliHelp('show ip vrf '))).toContain('detail');
    await r.executeCommand('configure terminal');
    expect(mots(r.cliHelp('ntp server '))).toContain('A.B.C.D');
    expect(mots(r.cliHelp('ntp master '))).toContain('<1-15>');
    expect(mots(r.cliHelp('no ip domain-lookup '))).toContain('source-interface');
  });

  it('le commutateur garde les siens', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1') as unknown as Dev;
    for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/1']) {
      await s.executeCommand(c);
    }
    expect(mots(s.cliHelp('mdix '))).toContain('auto');
    expect(mots(s.cliHelp('switchport mode '))).toContain('access');
    expect(mots(s.cliHelp('switchport access vlan '))).toContain('<1-4094>');
  });

  it('les commandes du mode `line` fonctionnent toujours', async () => {
    const r = await ligneConsole('RN3');
    for (const c of ['password Secret123', 'login', 'exec-timeout 5 0', 'logging synchronous']) {
      expect(String(await r.executeCommand(c)), c).not.toContain('Invalid input');
    }
  });

  it('la liste du mode `line` reste entiere au premier rang', async () => {
    const r = await ligneConsole('RN4');
    const racine = mots(r.cliHelp(''));
    for (const m of ['password', 'login', 'speed', 'exec-timeout', 'logging']) {
      expect(racine, m).toContain(m);
    }
  });
});

describe('le commutateur partage le meme mode `line`', () => {
  async function ligneSwitch(nom: string): Promise<Dev> {
    const s = new CiscoSwitch('switch-cisco', nom) as unknown as Dev;
    for (const c of ['enable', 'configure terminal', 'line console 0']) await s.executeCommand(c);
    return s;
  }

  it.each(['speed', 'stopbits', 'flowcontrol', 'databits', 'parity'])(
    '`%s ?` y est declaree aussi', async (cmd) => {
      const s = await ligneSwitch(`SW${cmd}`);
      const rendus = mots(s.cliHelp(`${cmd} `));
      for (const parasite of MOTS_DU_MODE) expect(rendus, parasite).not.toContain(parasite);
      expect(rendus.length).toBeGreaterThan(0);
    });

  it('et `ip domain-lookup ?` garde `source-interface`', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SWD') as unknown as Dev;
    for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
    expect(mots(s.cliHelp('ip domain-lookup '))).toContain('source-interface');
  });
});
