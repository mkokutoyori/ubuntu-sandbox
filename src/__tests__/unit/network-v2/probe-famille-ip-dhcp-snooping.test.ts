/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * L'espionnage DHCP est une fonction de COMMUTATION : le commutateur
 * observe les echanges DHCP qui traversent ses ports, distingue les
 * ports de CONFIANCE (vers le serveur legitime) des autres, et retient
 * dans une table de liaisons ce que chaque client a obtenu. C'est ce
 * qui empeche un serveur pirate de repondre a la place du vrai.
 *
 * `ip dhcp snooping` l'active globalement, `ip dhcp snooping vlan
 * <liste>` la porte sur des VLAN, `ip dhcp snooping trust` marque un
 * port en interface, `ip dhcp snooping limit rate <pps>` le borne.
 *
 * `show ip dhcp snooping` decrit l'etat : la fonction est active ou non,
 * sur quels VLAN, l'insertion de l'option 82, les verifications, puis un
 * tableau des interfaces de confiance. `show ip dhcp snooping binding`
 * rend la table de liaisons, dont l'en-tete et le pied sont attestes par
 * le gabarit `ntc-templates` (texte CAPTURE, pas un exemple de
 * documentation) :
 *
 *     MacAddress   IpAddress   Lease(sec)   Type   VLAN   Interface
 *     ----------   ---------   ----------   ----   ----   ---------
 *     ...
 *     Total number of bindings: N
 *
 * Ce que la sonde cherche, au-dela de la migration : une VUE et sa
 * CONFIGURATION doivent s'accorder sur la meme machine. Une plateforme
 * qui rend l'etat d'une fonction doit accepter de la configurer ; une
 * plateforme qui refuse de la configurer ne doit pas en decrire l'etat.
 * Decrire une fonction qu'on ne peut pas regler est un decor, et le
 * chassis modelise ici (`c2900`) est un routeur a configuration fixe,
 * sans module de commutation : l'espionnage DHCP n'y existe pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

async function enConfig(d: Cli): Promise<Cli> {
  await taper(d, ['enable', 'configure terminal']);
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

async function espionne(): Promise<Cli> {
  const s = await enConfig(catalyst());
  await taper(s, ['vlan 10', 'exit', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'end']);
  return s;
}

describe('`show ip dhcp snooping` decrit l etat de la fonction', () => {
  it('avant toute configuration, elle est ARRETEE', async () => {
    const s = catalyst();
    await s.executeCommand('enable');

    expect(await s.executeCommand('show ip dhcp snooping'))
      .toMatch(/snooping is (not enabled|disabled)/i);
  });

  it('apres `ip dhcp snooping`, elle est ACTIVE', async () => {
    const s = await enConfig(catalyst());
    await taper(s, ['ip dhcp snooping', 'end']);

    expect(await s.executeCommand('show ip dhcp snooping'))
      .toMatch(/snooping is enabled/i);
  });

  it('`no ip dhcp snooping` l arrete de nouveau', async () => {
    const s = await enConfig(catalyst());
    await taper(s, ['ip dhcp snooping', 'no ip dhcp snooping', 'end']);

    expect(await s.executeCommand('show ip dhcp snooping'))
      .toMatch(/snooping is (not enabled|disabled)/i);
  });

  it('le VLAN arme y figure', async () => {
    const s = await espionne();

    expect(await s.executeCommand('show ip dhcp snooping')).toContain('10');
  });

  it('un VLAN qu on n a PAS arme n y figure pas', async () => {
    const s = await espionne();
    const vue = await s.executeCommand('show ip dhcp snooping');
    const lignes = vue.split('\n')
      .filter(l => /VLAN/i.test(l) === false && /\b777\b/.test(l));

    expect(lignes).toEqual([]);
  });

  it('l insertion de l option 82 est decrite', async () => {
    const s = await espionne();

    expect(await s.executeCommand('show ip dhcp snooping'))
      .toMatch(/option 82 is (enabled|disabled)/i);
  });

  it('la verification du champ hwaddr est decrite', async () => {
    const s = await espionne();

    expect(await s.executeCommand('show ip dhcp snooping'))
      .toMatch(/hwaddr field is (enabled|disabled)/i);
  });
});

describe('`show ip dhcp snooping binding` rend la table de liaisons', () => {
  it('l en-tete porte les six intitules attestes', async () => {
    const s = await espionne();
    const vue = await s.executeCommand('show ip dhcp snooping binding');

    expect(vue).toMatch(/MacAddress\s+IpAddress\s+Lease\(sec\)\s+Type\s+VLAN\s+Interface/);
  });

  it('le pied compte les liaisons', async () => {
    const s = await espionne();

    expect(await s.executeCommand('show ip dhcp snooping binding'))
      .toMatch(/Total number of bindings\s*:\s*\d+/);
  });

  it('sans client, le compte est zero', async () => {
    const s = await espionne();

    expect(await s.executeCommand('show ip dhcp snooping binding'))
      .toMatch(/Total number of bindings\s*:\s*0/);
  });
});

describe('un port de CONFIANCE se declare en interface et se relit', () => {
  async function avecConfiance(): Promise<{ cli: Cli; port: string }> {
    const s = await espionne();
    const port = s.getPortNames()[0];
    await taper(s, [
      'configure terminal', `interface ${port}`,
      'ip dhcp snooping trust', 'end',
    ]);
    return { cli: s, port };
  }

  it('la ligne parait dans la configuration, sous son interface', async () => {
    const { cli, port } = await avecConfiance();
    const vue = await cli.executeCommand('show running-config');
    const bloc = vue.slice(vue.indexOf(`interface ${port}`));

    expect(bloc.slice(0, bloc.indexOf('\ninterface', 1)))
      .toContain('ip dhcp snooping trust');
  });

  it('`no ip dhcp snooping trust` la retire', async () => {
    const { cli, port } = await avecConfiance();
    await taper(cli, [
      'configure terminal', `interface ${port}`,
      'no ip dhcp snooping trust',
    ]);

    expect(await config(cli)).not.toContain('ip dhcp snooping trust');
  });

  it('le tableau de `show ip dhcp snooping` nomme l interface de confiance', async () => {
    const { cli, port } = await avecConfiance();
    const vue = await cli.executeCommand('show ip dhcp snooping');

    expect(vue).toContain(port);
  });

  it('`ip dhcp snooping limit rate` se relit', async () => {
    const s = await espionne();
    const port = s.getPortNames()[0];
    await taper(s, [
      'configure terminal', `interface ${port}`,
      'ip dhcp snooping limit rate 100',
    ]);

    expect(await config(s)).toContain('ip dhcp snooping limit rate 100');
  });
});

describe('la configuration globale se relit', () => {
  it('`ip dhcp snooping` y parait', async () => {
    const s = await enConfig(catalyst());
    await taper(s, ['ip dhcp snooping']);

    expect(await config(s)).toMatch(/^ip dhcp snooping$/m);
  });

  it('`ip dhcp snooping vlan 10` y parait avec son VLAN', async () => {
    const s = await enConfig(catalyst());
    await taper(s, ['vlan 10', 'exit', 'ip dhcp snooping', 'ip dhcp snooping vlan 10']);

    expect(await config(s)).toMatch(/^ip dhcp snooping vlan 10$/m);
  });

  it('arretee, elle ne laisse aucune ligne derriere elle', async () => {
    const s = await enConfig(catalyst());
    await taper(s, ['ip dhcp snooping', 'no ip dhcp snooping']);

    expect(await config(s)).not.toMatch(/^ip dhcp snooping$/m);
  });
});

describe('une valeur qu on ne sait pas evaluer est REFUSEE', () => {
  const FAUTIVES: ReadonlyArray<[string, string]> = [
    ['un mot inconnu apres `snooping`', 'ip dhcp snooping zorglub'],
    ['un VLAN qui n est pas un nombre', 'ip dhcp snooping vlan zorglub'],
  ];

  for (const [nom, saisie] of FAUTIVES) {
    it(`${nom} — \`${saisie}\``, async () => {
      const s = await enConfig(catalyst());

      expect(await s.executeCommand(saisie)).toMatch(REFUS);
    });

    it(`${nom} — et elle n entre pas dans la configuration`, async () => {
      const s = await enConfig(catalyst());
      await s.executeCommand(saisie);

      expect(await config(s)).not.toContain('zorglub');
    });
  }
});

describe('la vue et la configuration s accordent sur la MEME machine', () => {
  it('commutateur — il configure, donc il decrit', async () => {
    const s = await enConfig(catalyst());
    const pose = await s.executeCommand('ip dhcp snooping');
    await s.executeCommand('end');
    const vue = await s.executeCommand('show ip dhcp snooping');

    expect(pose).not.toMatch(REFUS);
    expect(vue).not.toMatch(REFUS);
  });

  it('routeur — ce qu il refuse de configurer, il ne le decrit pas', async () => {
    const r = await enConfig(routeur());
    const pose = await r.executeCommand('ip dhcp snooping');
    await r.executeCommand('end');
    const vue = await r.executeCommand('show ip dhcp snooping');

    expect(REFUS.test(vue)).toBe(REFUS.test(pose));
  });
});
