/**
 * Le garde-fou de migration — un chemin appartient a UN moteur, jamais deux.
 *
 * C'est la condition pour migrer famille par famille sans perdre le fil :
 * si `show version` etait declare a la fois dans le socle et dans
 * `CommandTrie`, deux moteurs repondraient a la meme frappe et plus rien
 * ne dirait lequel a parle. Le registre `MIGRATION_LEDGER` nomme ce qui a
 * traverse ; le garde-fou verifie les deux moities de l'invariant :
 *
 *   1. tout chemin du registre EST declare dans le socle ;
 *   2. aucun chemin du registre n'est RESTE dans un trie.
 *
 * La seconde est celle qui coute : elle oblige a vider le trie de la
 * famille dans le meme commit, ce qui est precisement ce qu'on veut —
 * une migration a moitie faite est un simulateur qui repond deux fois.
 *
 * Ce fichier mesure aussi ce que la migration RAPPORTE, parce que le
 * chiffre justifie le travail : une commande disponible en EXEC
 * utilisateur ET en EXEC privilegie est aujourd'hui enregistree DEUX fois
 * dans deux tries, la ou le socle la declare une fois avec
 * `modes: ['user', 'privileged']`.
 */

import { describe, it, expect } from 'vitest';
import { CommandTable } from '@/cli/CommandTable';
import {
  MIGRATION_LEDGER, SHOW_SLICE, SHOW_SLICE_PATHS, pathTextOf,
} from '@/cli/commands/show/showSlice';
import { ALL_TUNNEL } from '@/cli/commands/tunnel/tunnelFamily';
import { CLEAR_CRYPTO_FAMILY } from '@/cli/commands/clear/clearCrypto';
import { SHOW_CRYPTO_FAMILY } from '@/cli/commands/show/showCrypto';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

function socle(): CommandTable {
  const table = new CommandTable();
  for (const spec of [...SHOW_SLICE, ...ALL_TUNNEL, ...CLEAR_CRYPTO_FAMILY, ...SHOW_CRYPTO_FAMILY]) table.declare(spec);
  return table;
}

function legacyPaths(): Set<string> {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();

  const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const shell = router.getShell() as unknown as {
    enumerateAllExecutablePaths?: () => string[];
  };

  return new Set(shell.enumerateAllExecutablePaths?.() ?? []);
}

describe('un chemin appartient a UN moteur', () => {
  it('tout chemin du registre est declare dans le socle', () => {
    const declared = new Set(socle().specs().map(pathTextOf));

    for (const path of MIGRATION_LEDGER) expect(declared.has(path)).toBe(true);
  });

  it('aucun chemin du registre n\'est RESTE dans un trie', () => {
    const legacy = legacyPaths();

    const survivants = MIGRATION_LEDGER.filter(path => legacy.has(path));

    expect(survivants).toEqual([]);
  });

  it('le garde-fou saurait attraper une double declaration — il se teste lui-meme', () => {
    const legacy = new Set(['show version', 'show clock']);

    const survivants = SHOW_SLICE_PATHS.filter(path => legacy.has(path));

    expect(survivants).toContain('show version');
    expect(survivants).not.toContain('show clock');
  });
});

describe('ce que la migration rapporte, mesure', () => {
  it('le socle declare UNE fois ce que le trie enregistre par mode', () => {
    const table = socle();
    const multiMode = table.specs().filter(spec => spec.modes.length > 1);

    expect(multiMode.length).toBeGreaterThan(0);
  });

  it('la tranche couvre quatre commandes, prete a traverser', () => {
    expect(SHOW_SLICE_PATHS).toHaveLength(4);
  });

  it('elle est ENCORE dans le trie — c\'est le travail qui reste, mesure', () => {
    const legacy = legacyPaths();

    const restants = SHOW_SLICE_PATHS.filter(path => legacy.has(path));

    expect(restants.length).toBeGreaterThan(0);
  });

  it('l\'inventaire du trie n\'est pas vide — sinon le garde-fou ne lirait rien', () => {
    expect(legacyPaths().size).toBeGreaterThan(100);
  });
});

describe('elaguer un chemin ne touche PAS ce qui pend dessous', () => {
  it('la famille `clear` a ete RENDUE au trie — trois regressions pour six chemins', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const shell = router.getShell() as unknown as {
      enumerateAllExecutablePaths(): string[];
      migratedPaths(): readonly string[];
    };

    expect(shell.migratedPaths()).not.toContain('clear logging');
    for (const chemin of ['clear logging', 'clear logging persistent', 'clear counters']) {
      expect(shell.enumerateAllExecutablePaths(), chemin).toContain(chemin);
    }
  });

  it('le noeud parent perd son ACTION, pas ses enfants', () => {
    const trie = new CommandTrie();
    trie.register('clear logging', 'Clear the buffer', () => 'tampon');
    trie.register('clear logging persistent', 'Clear the files', () => 'fichiers');

    trie.prunePaths(['clear logging']);

    expect(trie.enumerateExecutablePaths()).toContain('clear logging persistent');
    expect(trie.enumerateExecutablePaths()).not.toContain('clear logging');
  });

  it('une FEUILLE migree disparait pour de bon — le temoin', () => {
    const trie = new CommandTrie();
    trie.register('show version', 'Version', () => 'x');

    trie.prunePaths(['show version']);

    expect(trie.enumerateExecutablePaths()).not.toContain('show version');
  });
});

describe('un descendant n\'est pas un CONCURRENT', () => {
  it('`show crypto ipsec sa` s\'execute malgre `show crypto ipsec sa interface`', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const cli = router as unknown as { executeCommand(c: string): Promise<string> };
    await cli.executeCommand('enable');

    const out = await cli.executeCommand('show crypto ipsec sa');

    expect(out).not.toContain('Incomplete');
    expect(out).not.toContain('Invalid input');
  });

  it('le descendant EXISTE bien dans le trie — sans lui le cas ne prouve rien', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const shell = router.getShell() as unknown as { enumerateAllCommandPaths(): string[] };

    expect(shell.enumerateAllCommandPaths()).toContain('show crypto ipsec sa interface');
  });

  it('une correspondance EXACTE l\'emporte sur un prefixe concurrent', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const cli = router as unknown as { executeCommand(c: string): Promise<string> };
    await cli.executeCommand('enable');

    const exact = await cli.executeCommand('show crypto ipsec sa');
    const autre = await cli.executeCommand('show crypto ipsec security-association lifetime');

    expect(exact).not.toContain('Incomplete');
    expect(autre).not.toContain('Incomplete');
    expect(exact).not.toBe(autre);
  });
});

describe('une commande d\'EXEC migree perdrait sa DELEGATION', () => {
  async function commutateurDelegue() {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const device = createDevice('switch-cisco', 0, 0) as unknown as {
      executeCommand(c: string): Promise<string>;
      loginAs(user: string, secret: string): Promise<boolean>;
    };
    await device.executeCommand('enable');
    await device.executeCommand('configure terminal');
    await device.executeCommand('username noc privilege 7 secret Noc@2026');
    await device.executeCommand('privilege exec level 7 clear counters');
    await device.executeCommand('end');
    return device;
  }

  it('`clear counters` delegue au niveau 7 repond a un utilisateur de niveau 7', async () => {
    const device = await commutateurDelegue();

    await device.loginAs('noc', 'Noc@2026');

    expect(await device.executeCommand('show privilege')).toContain('level is 7');
    expect(await device.executeCommand('clear counters')).not.toContain('Invalid input');
  });

  it('et reste refuse SANS la delegation — le temoin', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const device = createDevice('switch-cisco', 0, 0) as unknown as {
      executeCommand(c: string): Promise<string>;
    };

    expect(await device.executeCommand('clear counters')).toContain('Invalid input');
  });

  it('la famille `clear` est donc RESTEE au trie', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const shell = router.getShell() as unknown as {
      enumerateAllExecutablePaths(): string[];
      migratedPaths(): readonly string[];
    };

    expect(shell.migratedPaths()).not.toContain('clear counters');
    expect(shell.enumerateAllExecutablePaths()).toContain('clear counters');
  });
});
