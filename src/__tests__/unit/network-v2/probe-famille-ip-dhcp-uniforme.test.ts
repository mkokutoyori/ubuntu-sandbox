/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `ip dhcp pool <nom>` entre dans le sous-mode d'un pool et le CREE ;
 * `network`, `default-router`, `dns-server`, `domain-name` et `lease` y
 * vivent. `ip dhcp excluded-address <basse> [<haute>]` retire des
 * adresses de l'attribution. `ip dhcp database <url>` designe l'agent
 * de sauvegarde des baux. `no ip dhcp pool <nom>` supprime le pool.
 *
 * Un Catalyst connait cette famille AUTANT qu'un routeur — les deux
 * savent servir le DHCP — donc chaque cas est joue des DEUX cotes et
 * doit y repondre pareil.
 *
 * UNE premisse a ete ECARTEE plutot qu'affirmee : la sonde exigeait
 * d'abord qu'un ROUTEUR refuse `ip dhcp snooping`. Ce depot l'accepte
 * et la rend — c'est une decision anterieure, epinglee par
 * `global-config-serialisation` — et elle n'est pas absurde, un ISR
 * portant un module EtherSwitch connaissant la commande. Faute d'une
 * capture atteignable depuis ce reseau, la sonde verifie ce qui EST
 * attestable : que chaque plateforme s'accorde avec elle-meme, c'est-a-
 * dire accepte ET rende.
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
  getPrompt(): string;
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

const PLATEFORMES: ReadonlyArray<[string, () => Cli]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

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

const POOL = [
  'ip dhcp pool LAN',
  'network 192.168.10.0 255.255.255.0',
  'default-router 192.168.10.1',
  'dns-server 8.8.8.8',
  'domain-name lab.local',
  'lease 0 12 0',
  'exit',
];

describe('`ip dhcp pool` ouvre le sous-mode des DEUX cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l invite passe en (dhcp-config)`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip dhcp pool LAN');

      expect(d.getPrompt()).toMatch(/\(dhcp-config\)#$/);
    });

    it(`${nom} — `.concat('`exit` revient en configuration globale'), async () => {
      const d = await enConfig(faire());
      await taper(d, ['ip dhcp pool LAN', 'exit']);

      expect(d.getPrompt()).toMatch(/\(config\)#$/);
    });

    it(`${nom} — sans nom, la commande est incomplete`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('ip dhcp pool')).toMatch(/Incomplete command/);
    });
  }
});

describe('ce que le pool recoit se relit dans la configuration', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — les cinq reglages y figurent`, async () => {
      const d = await enConfig(faire());
      await taper(d, POOL);
      const vue = await config(d);

      expect(vue).toContain('ip dhcp pool LAN');
      expect(vue).toContain('network 192.168.10.0 255.255.255.0');
      expect(vue).toContain('default-router 192.168.10.1');
      expect(vue).toContain('dns-server 8.8.8.8');
      expect(vue).toContain('domain-name lab.local');
    });

    it(`${nom} — `.concat('`show ip dhcp pool` decrit le pool'), async () => {
      const d = await enConfig(faire());
      await taper(d, [...POOL, 'end']);

      expect(await d.executeCommand('show ip dhcp pool')).toContain('LAN');
    });

    it(`${nom} — le nom du pool garde sa CASSE`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['ip dhcp pool Ventes-RH', 'exit']);

      expect(await config(d)).toContain('Ventes-RH');
    });
  }
});

describe('les deux plateformes rendent le MEME bloc pour la meme saisie', () => {
  it('caractere pour caractere', async () => {
    const blocs = await Promise.all(PLATEFORMES.map(async ([, faire]) => {
      const d = await enConfig(faire());
      await taper(d, POOL);
      return (await config(d)).split('\n')
        .filter(l => /^(ip dhcp|\s+(network|default-router|dns-server|domain-name|lease))/.test(l))
        .join('\n');
    }));

    expect(blocs[0].length).toBeGreaterThan(0);
    expect(blocs[1]).toBe(blocs[0]);
  });
});

describe('`no ip dhcp pool` supprime le pool', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — il disparait de la configuration`, async () => {
      const d = await enConfig(faire());
      await taper(d, [...POOL, 'no ip dhcp pool LAN']);

      expect(await config(d)).not.toContain('ip dhcp pool LAN');
    });
  }
});

describe('`ip dhcp excluded-address` retire des adresses', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — une adresse seule est acceptee et rendue`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip dhcp excluded-address 192.168.10.1');

      expect(await config(d)).toContain('ip dhcp excluded-address 192.168.10.1');
    });

    it(`${nom} — une plage aussi`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip dhcp excluded-address 192.168.10.1 192.168.10.9');

      expect(await config(d))
        .toContain('ip dhcp excluded-address 192.168.10.1 192.168.10.9');
    });

    it(`${nom} — une adresse malformee est REFUSEE`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('ip dhcp excluded-address zorglub'))
        .toMatch(REFUS);
    });

    it(`${nom} — et elle n entre pas dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip dhcp excluded-address zorglub');

      expect(await config(d)).not.toContain('zorglub');
    });
  }
});

describe('`ip dhcp database` designe l agent de sauvegarde', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l URL se relit`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip dhcp database tftp://10.0.0.9/dhcp');

      expect(await config(d)).toContain('ip dhcp database tftp://10.0.0.9/dhcp');
    });

    it(`${nom} — le `.concat('`no` la retire'), async () => {
      const d = await enConfig(faire());
      await taper(d, [
        'ip dhcp database tftp://10.0.0.9/dhcp',
        'no ip dhcp database tftp://10.0.0.9/dhcp',
      ]);

      expect(await config(d)).not.toContain('ip dhcp database');
    });
  }
});

describe('creer un pool ne RALLUME pas un service eteint', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — apres \`no service dhcp\`, le service reste eteint`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['no service dhcp', 'ip dhcp pool LAN', 'exit']);

      expect(await config(d)).toContain('no service dhcp');
    });
  }
});

describe('`ip dhcp ?` decrit ses suites, pareil des deux cotes', () => {
  async function aide(d: Cli): Promise<string> {
    await enConfig(d);
    return d.executeCommand('ip dhcp ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`pool` et `excluded-address` y sont decrits'), async () => {
      const vue = await aide(faire());

      expect(vue).toMatch(/^\s*pool\s+\S/m);
      expect(vue).toMatch(/^\s*excluded-address\s+\S/m);
    });
  }
});

describe('`ip dhcp snooping` est une fonction de COMMUTATION', () => {
  it('le commutateur l accepte', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('ip dhcp snooping')).not.toMatch(REFUS);
  });

  it('et la rend dans sa configuration', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['ip dhcp snooping', 'ip dhcp snooping vlan 10']);
    const vue = await config(sw);

    expect(vue).toContain('ip dhcp snooping');
    expect(vue).toContain('ip dhcp snooping vlan 10');
  });

  it('le routeur, lui, l accepte ET la rend — il s accorde avec lui-meme', async () => {
    const r = await enConfig(routeur());
    await r.executeCommand('ip dhcp snooping');

    expect(await config(r)).toContain('ip dhcp snooping');
  });
});
