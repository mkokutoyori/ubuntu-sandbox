/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation Catalyst, sur
 * `spanning-tree` en configuration d'INTERFACE — la derniere grande
 * commande que le commutateur sert par son trie.
 *
 * Ce que la reference dit, forme par forme :
 *   - `spanning-tree portfast [disable | trunk]`
 *   - `spanning-tree bpduguard { enable | disable }`
 *   - `spanning-tree bpdufilter { enable | disable }`
 *   - `spanning-tree guard { root | loop | none }`
 *   - `spanning-tree cost <1-200000000>`
 *   - `spanning-tree port-priority <0-240>`
 *   - `spanning-tree vlan <vlan> { cost <c> | port-priority <p> }`, la
 *     meme commande precedee d'un selecteur d'instance.
 *   - `spanning-tree link-type { point-to-point | shared }`
 *
 * Ce que la sonde cherche : qu'un mot-cle INVENTE soit refuse plutot
 * qu'accepte et RENDU dans la configuration — laquelle est rejouee a
 * l'import d'une topologie — et que `?` annonce ce que la machine
 * accepte vraiment.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

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

async function surPort(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/1']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

describe('les formes que la reference donne sont ACCEPTEES', () => {
  const FORMES = [
    'spanning-tree portfast',
    'spanning-tree portfast disable',
    'spanning-tree portfast trunk',
    'spanning-tree bpduguard enable',
    'spanning-tree bpduguard disable',
    'spanning-tree bpdufilter enable',
    'spanning-tree bpdufilter disable',
    'spanning-tree guard root',
    'spanning-tree guard loop',
    'spanning-tree guard none',
    'spanning-tree cost 100',
    'spanning-tree port-priority 64',
    'spanning-tree vlan 10 cost 100',
    'spanning-tree vlan 10 port-priority 64',
    'spanning-tree link-type point-to-point',
    'spanning-tree link-type shared',
  ];
  for (const forme of FORMES) {
    it(`\`${forme}\``, async () => {
      const s = await surPort();
      expect(await s.executeCommand(forme)).not.toMatch(REFUS);
    });
  }
});

describe('un mot-cle INVENTE est refuse et ne se range pas', () => {
  const SAISIES = [
    'spanning-tree zorglub',
    'spanning-tree guard zorglub',
    'spanning-tree bpduguard zorglub',
    'spanning-tree bpdufilter zorglub',
    'spanning-tree portfast zorglub',
    'spanning-tree link-type zorglub',
  ];
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const s = await surPort();
      expect(await s.executeCommand(saisie)).toMatch(REFUS);
      expect(await conf(s)).not.toMatch(/zorglub/);
    });
  }
});

describe('les valeurs NUMERIQUES sont bornees', () => {
  it('`cost 0` est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree cost 0')).toMatch(REFUS);
  });

  it('`cost 200000001` est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree cost 200000001')).toMatch(REFUS);
  });

  it('`cost zorglub` est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree cost zorglub')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/zorglub/);
  });

  it('`port-priority 241` est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree port-priority 241')).toMatch(REFUS);
  });

  it('`port-priority zorglub` est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree port-priority zorglub')).toMatch(REFUS);
  });

  it('un VLAN qui n est pas un nombre est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('spanning-tree vlan zorglub cost 100')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/zorglub/);
  });
});

describe('ce qui est pose se RELIT dans la configuration', () => {
  it('`cost` et `port-priority` y figurent', async () => {
    const s = await surPort();
    await jouer(s, ['spanning-tree cost 100', 'spanning-tree port-priority 64']);
    const texte = await conf(s);
    expect(texte).toMatch(/^\s*spanning-tree cost 100\s*$/m);
    expect(texte).toMatch(/^\s*spanning-tree port-priority 64\s*$/m);
  });

  it('la forme par VLAN y figure avec son selecteur', async () => {
    const s = await surPort();
    await s.executeCommand('spanning-tree vlan 10 cost 100');
    expect(await conf(s)).toMatch(/^\s*spanning-tree vlan 10 cost 100\s*$/m);
  });

  it('`portfast` y figure', async () => {
    const s = await surPort();
    await s.executeCommand('spanning-tree portfast');
    expect(await conf(s)).toMatch(/^\s*spanning-tree portfast\s*$/m);
  });
});

describe('l aide annonce ce que la machine accepte', () => {
  it('`spanning-tree ?` nomme les reglages d interface', async () => {
    const s = await surPort();
    const aide = s.cliHelp('spanning-tree ');
    for (const mot of ['bpdufilter', 'bpduguard', 'cost', 'guard',
      'link-type', 'port-priority', 'portfast', 'vlan']) {
      expect(aide, mot).toMatch(new RegExp(`^\\s+${mot}\\b`, 'm'));
    }
  });

  it('`guard ?` nomme ses trois valeurs', async () => {
    const s = await surPort();
    const aide = s.cliHelp('spanning-tree guard ');
    for (const mot of ['loop', 'none', 'root']) {
      expect(aide, mot).toMatch(new RegExp(`^\\s+${mot}\\b`, 'm'));
    }
  });

  it('`bpduguard ?` nomme enable et disable', async () => {
    const s = await surPort();
    const aide = s.cliHelp('spanning-tree bpduguard ');
    expect(aide).toMatch(/^\s+enable\b/m);
    expect(aide).toMatch(/^\s+disable\b/m);
  });

  it('`cost ?` annonce sa plage', async () => {
    const s = await surPort();
    expect(s.cliHelp('spanning-tree cost ')).toContain('<1-200000000>');
  });

  it('`port-priority ?` annonce sa plage', async () => {
    const s = await surPort();
    expect(s.cliHelp('spanning-tree port-priority ')).toContain('<0-240>');
  });
});

describe('la negation defait le reglage NOMME', () => {
  it('`no spanning-tree cost` retire la ligne', async () => {
    const s = await surPort();
    await s.executeCommand('spanning-tree cost 100');
    await jouer(s, ['configure terminal', 'interface FastEthernet0/1',
      'no spanning-tree cost']);
    expect(await conf(s)).not.toMatch(/spanning-tree cost 100/);
  });

  it('`no spanning-tree portfast` retire la ligne', async () => {
    const s = await surPort();
    await s.executeCommand('spanning-tree portfast');
    await jouer(s, ['configure terminal', 'interface FastEthernet0/1',
      'no spanning-tree portfast']);
    expect(await conf(s)).not.toMatch(/spanning-tree portfast/);
  });
});
