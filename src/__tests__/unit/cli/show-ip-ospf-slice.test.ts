import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

async function avecOspf(): Promise<Cli> {
  const device = await privilegie();
  for (const c of ['configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.255 area 0', 'end']) {
    await device.executeCommand(c);
  }
  return device;
}

const VUES = [
  'show ip ospf',
  'show ip ospf border-routers',
  'show ip ospf database',
  'show ip ospf database router',
  'show ip ospf database network',
  'show ip ospf database external',
  'show ip ospf database summary',
  'show ip ospf database asbr-summary',
  'show ip ospf database nssa-external',
  'show ip ospf database self-originate',
  'show ip ospf database database-summary',
  'show ip ospf events',
  'show ip ospf flood-list',
  'show ip ospf interface',
  'show ip ospf interface brief',
  'show ip ospf max-metric',
  'show ip ospf neighbor',
  'show ip ospf neighbor detail',
  'show ip ospf request-list',
  'show ip ospf retransmission-list',
  'show ip ospf rib',
  'show ip ospf segment-routing',
  'show ip ospf statistics',
  'show ip ospf summary-address',
  'show ip ospf timers',
  'show ip ospf traffic',
  'show ip ospf virtual-links',
];

describe('une machine sans OSPF se TAIT, comme un vrai routeur', () => {
  it.each(VUES)('`%s` ne rend rien', async (command) => {
    expect(await nu().executeCommand(command)).toBe('');
  });

  it('les vingt-sept vues sont litteralement d\'accord', async () => {
    const device = nu();
    const reponses = new Set<string>();

    for (const command of VUES) reponses.add(await device.executeCommand(command));

    expect([...reponses]).toEqual(['']);
  });

  it('et aucune n\'invente de message', async () => {
    const device = nu();

    for (const command of VUES) {
      expect(await device.executeCommand(command), command).not.toMatch(/OSPF is not/);
    }
  });
});

describe('les vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('`clear ip ospf` passe au niveau 15 — elle REDEMARRE un processus', () => {
  it.each(['clear ip ospf', 'clear ip ospf process', 'clear ip ospf counters'])(
    '`%s` est refusee en EXEC utilisateur', async (command) => {
      expect(await nu().executeCommand(command)).toContain('Invalid input');
    });

  it.each(['clear ip ospf process', 'clear ip ospf counters', 'clear ip ospf force-spf'])(
    'et acceptee en EXEC privilegie — `%s`', async (command) => {
      expect(await (await avecOspf()).executeCommand(command)).toBe('');
    });
});

describe('les vues repondent vraiment quand OSPF tourne', () => {
  it('`show ip ospf` decrit le processus', async () => {
    expect(await (await avecOspf()).executeCommand('show ip ospf'))
      .toContain('Routing Process');
  });

  it.each(['show ip ospf interface', 'show ip ospf neighbor', 'show ip ospf database'])(
    '`%s` ne rend plus le message d\'absence', async (command) => {
      expect(await (await avecOspf()).executeCommand(command)).not.toBe('');
    });
});

describe('un mot inconnu est REFUSE, pas avale', () => {
  it.each(['show ip ospf zorglub', 'show ip ospf detail'])(
    '`%s` recoit le caret', async (command) => {
      expect(await (await avecOspf()).executeCommand(command)).toContain('Invalid input');
    });

  it('`show ip ospf detail` n\'est plus PROPOSEE non plus', async () => {
    expect((await avecOspf()).cliHelp('show ip ospf ')).not.toContain('detail');
  });

  it('un identifiant de processus reste accepte — le temoin', async () => {
    expect(await (await avecOspf()).executeCommand('show ip ospf 1'))
      .toContain('Routing Process');
  });

  it('et une sous-commande reelle aussi', async () => {
    expect(await (await avecOspf()).executeCommand('show ip ospf rib'))
      .not.toContain('Invalid input');
  });
});

describe('l\'aide nomme ce que chaque commande attend', () => {
  it.each([
    ['show ip ospf ', 'Process ID number'],
    ['show ip ospf interface ', 'Interface name'],
    ['show ip ospf neighbor ', 'Neighbor ID'],
    ['show ip ospf database router ', 'Link-state ID, or detail'],
  ])('`%s?` annonce `%s`', async (frappe, attendu) => {
    expect((await avecOspf()).cliHelp(frappe)).toContain(attendu);
  });

  it('`clear ip ospf ?` propose ses quatre actions, une seule fois chacune', async () => {
    const aide = (await avecOspf()).cliHelp('clear ip ospf ');

    for (const mot of ['process', 'counters', 'force-spf', 'redistribution']) {
      expect(aide.split('\n').filter(l => l.trim().startsWith(mot)), mot).toHaveLength(1);
    }
  });

  it.each([
    ['show ip ospf neigh', 'show ip ospf neighbor'],
    ['show ip ospf inter', 'show ip ospf interface'],
    ['show ip ospf data', 'show ip ospf database'],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    expect((await avecOspf()).cliTabCandidates(frappe)).toContain(attendu);
  });
});

describe('le commutateur n\'a pas OSPF, et ne l\'a toujours pas', () => {
  it.each(['show ip ospf', 'show ip ospf neighbor', 'clear ip ospf process'])(
    '`%s` y reste refusee', async (command) => {
      const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
      await device.executeCommand('enable');

      expect(await device.executeCommand(command)).toContain('Invalid input');
    });
});

describe('`show ip ospf interface <nom>` distingue les deux absences', () => {
  it('une interface qui N\'EXISTE PAS est refusee, comme sur `show interfaces`', async () => {
    const sortie = await (await avecOspf()).executeCommand('show ip ospf interface zorglub');

    expect(sortie).toContain('Invalid input');
  });

  it('et la meme frappe est refusee de la meme facon par la commande voisine', async () => {
    const device = await avecOspf();

    const ospf = await device.executeCommand('show ip ospf interface zorglub');
    const brut = await device.executeCommand('show interfaces zorglub');

    expect(ospf).toContain('Invalid input');
    expect(brut).toContain('Invalid input');
  });

  it('une interface qui EXISTE sans OSPF le dit, dans les mots d\'IOS', async () => {
    const sortie = await (await avecOspf())
      .executeCommand('show ip ospf interface GigabitEthernet0/1');

    expect(sortie).toBe('%OSPF: OSPF not enabled on GigabitEthernet0/1');
  });

  it('une interface qui porte OSPF rend sa vue — le temoin', async () => {
    const sortie = await (await avecOspf())
      .executeCommand('show ip ospf interface GigabitEthernet0/0');

    expect(sortie).toContain('GigabitEthernet0/0');
    expect(sortie).toContain('Internet address');
    expect(sortie).not.toContain('not enabled');
  });

  it('`brief` reste une sous-commande, pas un nom d\'interface', async () => {
    const sortie = await (await avecOspf()).executeCommand('show ip ospf interface brief');

    expect(sortie).not.toContain('Invalid input');
    expect(sortie).not.toContain('not enabled on brief');
  });

  it('sans argument, la vue liste ce qui tourne', async () => {
    const sortie = await (await avecOspf()).executeCommand('show ip ospf interface');

    expect(sortie).toContain('GigabitEthernet0/0');
    expect(sortie).not.toContain('Invalid input');
  });
});
