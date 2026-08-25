/**
 * `interface <nom>` — la commande la plus tapee de toute la CLI, et la
 * seule que ce depot ecrit QUATRE fois.
 *
 * Elle est declaree en configuration globale ET en configuration
 * d'interface, sur le routeur comme sur le commutateur, parce qu'IOS
 * laisse passer d'une interface a l'autre sans repasser par `exit`. Ce
 * qui est mesure ici est que les quatre repondent la MEME chose : une
 * commande dont la reponse depend du mode d'ou on la tape est une
 * commande qui ment sur l'invite qu'elle affiche ensuite.
 *
 * Reference : Cisco, « Using the Cisco IOS Command-Line Interface »
 * (Configuration Fundamentals, 15.1S) — depuis le mode de configuration
 * d'interface, `interface fastethernet 0/0.100` fait passer l'invite a
 * `(config-subif)#`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  getPrompt?(): string;
  getPortNames(): string[];
}

let serial = 0;

async function routeur(...lignes: string[]): Promise<Cli> {
  const r = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  r.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await r.executeCommand(c);
  return r;
}

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|Invalid interface/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

/*
 * Les deux ORIGINES d'une meme frappe : depuis la configuration
 * globale, et depuis une interface deja selectionnee. Chaque cas est
 * joue des deux, et c'est la comparaison qui est le test.
 */
const DEPUIS_LA_CONFIGURATION = 'depuis la configuration globale';
const DEPUIS_UNE_INTERFACE = 'depuis une interface deja selectionnee';

async function routeurDepuis(origine: string): Promise<Cli> {
  const r = await routeur();
  if (origine === DEPUIS_UNE_INTERFACE) {
    await r.executeCommand(`interface ${r.getPortNames()[0]}`);
  }
  return r;
}

async function commutateurDepuis(origine: string): Promise<Cli> {
  const sw = await commutateur();
  if (origine === DEPUIS_UNE_INTERFACE) {
    await sw.executeCommand(`interface ${sw.getPortNames()[0]}`);
  }
  return sw;
}

const ORIGINES = [DEPUIS_LA_CONFIGURATION, DEPUIS_UNE_INTERFACE] as const;

describe('une sous-interface met dans le mode des SOUS-interfaces', () => {
  it.each(ORIGINES)('%s', async (origine) => {
    const r = await routeurDepuis(origine);
    const base = r.getPortNames()[1];

    expect(refuse(await r.executeCommand(`interface ${base}.10`)), origine).toBe(false);
    expect(r.getPrompt?.() ?? '', origine).toMatch(/config-subif/);
  });

  it.each(ORIGINES)('et `encapsulation dot1Q` y est acceptee — %s', async (origine) => {
    const r = await routeurDepuis(origine);
    const base = r.getPortNames()[1];
    await r.executeCommand(`interface ${base}.10`);

    expect(refuse(await r.executeCommand('encapsulation dot1Q 10')), origine).toBe(false);
  });
});

describe('les interfaces VIRTUELLES sont creees des deux origines', () => {
  it.each(ORIGINES)('`interface Loopback0` — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(refuse(await r.executeCommand('interface Loopback0')), origine).toBe(false);
    expect(r.getPrompt?.() ?? '', origine).toMatch(/config-if/);
  });

  it.each(ORIGINES)('`interface Tunnel0` — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(refuse(await r.executeCommand('interface Tunnel0')), origine).toBe(false);
  });

  /*
   * Un routeur IOS porte des EtherChannel comme un commutateur, et
   * `po1` est l'abreviation que tout le monde tape.
   */
  it.each(ORIGINES)('`interface Port-channel1` — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(refuse(await r.executeCommand('interface Port-channel1')), origine).toBe(false);
  });

  it.each(ORIGINES)('`interface po1`, la forme abregee — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(refuse(await r.executeCommand('interface po1')), origine).toBe(false);
  });
});

describe('sur le commutateur, une interface de VLAN', () => {
  it.each(ORIGINES)('`interface Vlan10` CREE le SVI — %s', async (origine) => {
    const sw = await commutateurDepuis(origine);

    expect(refuse(await sw.executeCommand('interface Vlan10')), origine).toBe(false);
    await sw.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show running-config'), origine)
      .toContain('interface Vlan10');
  });

  it.each(ORIGINES)('`interface Vlan5000` est refuse — %s', async (origine) => {
    const sw = await commutateurDepuis(origine);

    expect(refuse(await sw.executeCommand('interface Vlan5000')), origine).toBe(true);
  });
});

describe('ce qui est refuse l est des deux origines', () => {
  it.each(ORIGINES)('`interface` seul est incomplet — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(await r.executeCommand('interface'), origine).toContain('Incomplete');
  });

  it.each(ORIGINES)('un TYPE sans numero est incomplet, pas invalide — %s',
    async (origine) => {
      const r = await routeurDepuis(origine);

      expect(await r.executeCommand('interface GigabitEthernet'), origine)
        .toContain('Incomplete');
    });

  it.each(ORIGINES)('un nom inconnu est refuse — %s', async (origine) => {
    const r = await routeurDepuis(origine);

    expect(refuse(await r.executeCommand('interface Zorglub9')), origine).toBe(true);
  });

  it.each(ORIGINES)('sur le commutateur aussi, le type sans numero — %s',
    async (origine) => {
      const sw = await commutateurDepuis(origine);

      expect(await sw.executeCommand('interface FastEthernet'), origine)
        .toContain('Incomplete');
    });
});

describe('passer d une interface a l autre garde la configuration de la premiere', () => {
  it('le routeur', async () => {
    const r = await routeur();
    const [un, deux] = r.getPortNames();
    await r.executeCommand(`interface ${un}`);
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand(`interface ${deux}`);
    await r.executeCommand('ip address 10.0.1.1 255.255.255.0');
    await r.executeCommand('end');

    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('10.0.0.1');
    expect(cfg).toContain('10.0.1.1');
  });

  it('le commutateur', async () => {
    const sw = await commutateur();
    const [un, deux] = sw.getPortNames();
    await sw.executeCommand(`interface ${un}`);
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand(`interface ${deux}`);
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('end');

    const cfg = await sw.executeCommand('show running-config');
    expect(cfg).toContain('switchport mode access');
    expect(cfg).toContain('switchport mode trunk');
  });
});

describe('l aide annonce les memes types des deux origines', () => {
  it.each(ORIGINES)('sur le routeur — %s', async (origine) => {
    const r = await routeurDepuis(origine);
    const aide = r.cliHelp('interface ');

    for (const type of ['GigabitEthernet', 'Loopback', 'Tunnel']) {
      expect(aide, `${origine} / ${type}`).toContain(type);
    }
  });

  it.each(ORIGINES)('sur le commutateur — %s', async (origine) => {
    const sw = await commutateurDepuis(origine);
    const aide = sw.cliHelp('interface ');

    for (const type of ['FastEthernet', 'Vlan']) {
      expect(aide, `${origine} / ${type}`).toContain(type);
    }
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const r = await routeurDepuis(DEPUIS_UNE_INTERFACE);
    const nues: string[] = [];
    for (const ligne of r.cliHelp('interface ').split('\n')) {
      const texte = ligne.trim();
      if (texte === '' || texte === '<cr>') continue;
      if (!/\s{2,}\S/.test(texte)) nues.push(texte);
    }
    expect(nues).toEqual([]);
  });
});
