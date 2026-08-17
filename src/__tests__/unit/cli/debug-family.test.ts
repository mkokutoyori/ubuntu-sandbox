/**
 * La famille `debug` — une paire, une declaration.
 *
 * C'est la premiere famille migree dont chaque commande a une NEGATION,
 * et c'est ce qui la rend interessante : le trie enregistrait `debug X`
 * et `no debug X` comme deux chemins sans lien entre eux. Rien
 * n'obligeait la negation a exister, ni a viser la meme categorie que
 * l'activation, ni a etre retiree quand l'activation l'etait. La trace
 * de ce defaut est ecrite dans le depot : `undebug domain` echouait
 * parce que `no debug domain` n'avait jamais ete enregistre, alors que
 * `debug domain` fonctionnait et que l'aide proposait `domain` sous
 * `undebug`.
 *
 * Le socle declare la paire une fois — `run` allume, `undo` eteint —
 * donc les deux moities ne peuvent plus diverger. Le gain est mesurable
 * et ce fichier le mesure : deux chemins de trie deviennent une
 * declaration.
 *
 * Ce que ce fichier verifie AUSSI, parce que la migration seule ne le
 * garantit pas : `undebug X` continue de marcher. Le repartiteur le
 * reecrit en `no debug X`, et cette reecriture avait lieu APRES la
 * consultation du socle — donc sur une famille elaguee, `undebug` serait
 * tombe dans un trie vide. L'ordre compte, et il est fixe ici.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CommandTable } from '@/cli/CommandTable';
import { newSession } from '@/cli/CliSession';
import { parseCommand } from '@/cli/CommandParser';
import { debugFamily, debugPairPaths, type DebugPair } from '@/cli/commands/debug/debugFamily';

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(inputBeforeQuestion: string): string;
}

async function router(): Promise<Cli> {
  const device = createDevice('router-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

function pair(over: Partial<DebugPair> = {}): DebugPair {
  return {
    path: ['debug', 'arp'], description: 'Enable ARP debug',
    undoDescription: 'Disable ARP debug', takesArguments: false,
    enable: () => 'on', disable: () => 'off',
    ...over,
  };
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

describe('une paire est UNE declaration', () => {
  it('`run` allume et `undo` eteint la meme commande', () => {
    const table = new CommandTable();
    for (const spec of debugFamily([pair()])) table.declare(spec);
    const session = newSession('R1', {}, { initialMode: 'privileged', privilegeLevel: 15 });

    const allume = parseCommand(table, 'debug arp', session);
    const eteint = parseCommand(table, 'no debug arp', session);

    expect(allume.status).toBe('ok');
    expect(eteint.status).toBe('ok');
    if (allume.status === 'ok' && eteint.status === 'ok') {
      expect(allume.spec).toBe(eteint.spec);
      expect(eteint.negated).toBe(true);
    }
  });

  it('elle remplace DEUX chemins de trie — le gain, mesure', () => {
    expect(debugPairPaths([pair()])).toEqual(['debug arp', 'no debug arp']);
  });

  it('les arguments arrivent au gestionnaire, dans les deux sens', () => {
    const vus: string[][] = [];
    const table = new CommandTable();
    for (const spec of debugFamily([pair({
      path: ['debug', 'ip'], takesArguments: true,
      enable: (a) => { vus.push(a); return ''; },
      disable: (a) => { vus.push(a); return ''; },
    })])) table.declare(spec);
    const session = newSession('R1', {}, { initialMode: 'privileged', privilegeLevel: 15 });

    for (const line of ['debug ip packet detail', 'no debug ip packet']) {
      const parsed = parseCommand(table, line, session);
      if (parsed.status === 'ok') {
        (parsed.negated ? parsed.spec.undo! : parsed.spec.run)(session, parsed.args);
      }
    }

    expect(vus).toEqual([['packet', 'detail'], ['packet']]);
  });

  it('sans argument le gestionnaire recoit un tableau VIDE', () => {
    const vus: string[][] = [];
    const table = new CommandTable();
    for (const spec of debugFamily([pair({
      path: ['debug', 'ip'], takesArguments: true,
      enable: (a) => { vus.push(a); return ''; },
    })])) table.declare(spec);
    const session = newSession('R1', {}, { initialMode: 'privileged', privilegeLevel: 15 });

    const parsed = parseCommand(table, 'debug ip', session);
    if (parsed.status === 'ok') parsed.spec.run(session, parsed.args);

    expect(vus).toEqual([[]]);
  });
});

describe('sur la machine, les deux sens marchent', () => {
  it('`debug arp` puis `no debug arp` allument et eteignent pour de bon', async () => {
    const r = await router();

    const allume = await r.executeCommand('debug arp');
    const etat = await r.executeCommand('show debugging');
    const eteint = await r.executeCommand('no debug arp');
    const apres = await r.executeCommand('show debugging');

    expect(allume).not.toContain('Invalid input');
    expect(eteint).not.toContain('Invalid input');
    expect(etat).not.toBe(apres);
  });

  it('`debug ip packet` prend son argument', async () => {
    const r = await router();

    const out = await r.executeCommand('debug ip packet');

    expect(out).not.toContain('Invalid input');
    expect(await r.executeCommand('show debugging')).toContain('packet');
  });

  it('`undebug domain` marche encore — la reecriture precede le socle', async () => {
    const r = await router();
    await r.executeCommand('debug domain');

    const out = await r.executeCommand('undebug domain');

    expect(out).not.toContain('Invalid input');
    expect(await r.executeCommand('show debugging')).not.toContain('Domain Name System');
  });

  it('un sous-mot inconnu reste REFUSE — le socle ne rend pas laxiste', async () => {
    const r = await router();

    expect(await r.executeCommand('debug ip zorglub')).toContain('Invalid input');
  });

  it('`debug ?` decrit la famille au lieu de la nier', async () => {
    const r = await router();

    const aide = await r.executeCommand('debug ?');

    expect(aide).not.toContain('Invalid input');
    expect(aide).toContain('arp');
    expect(aide).toContain('condition');
  });

  it('le commutateur garde sa famille `debug` — les deux plateformes', async () => {
    const sw = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await sw.executeCommand('enable');

    const out = await sw.executeCommand('debug arp');

    expect(out).not.toContain('Invalid input');
  });
});

describe('le registre de migration nomme les DEUX moities', () => {
  it('un chemin migre et sa negation sortent du trie ensemble', async () => {
    const r = await router();
    const shell = (r as unknown as { getShell(): { enumerateAllCommandPaths(): string[] } }).getShell();

    const restants = shell.enumerateAllCommandPaths()
      .filter(path => path === 'debug arp' || path === 'no debug arp');

    expect(restants).toEqual([]);
  });
});

describe('la famille `clear` migre sans masquer ses voisines', () => {
  it('`clear counters` compte les interfaces qu\'il a remises a zero', async () => {
    const r = await router();

    const out = await r.executeCommand('clear counters');

    expect(out).toContain('all interfaces');
  });

  it('`clear counters <iface>` vise UNE interface', async () => {
    const r = await router();

    const out = await r.executeCommand('clear counters GigabitEthernet0/0');

    expect(out).toContain('interface GigabitEthernet0/0');
  });

  it('une interface inconnue est refusee, pas ignoree', async () => {
    const r = await router();

    expect(await r.executeCommand('clear counters Zorglub0/0')).toContain('No matching');
  });

  it('`clear logging persistent` reste au TRIE, il n\'est pas avale', async () => {
    const r = await router();
    const shell = (r as unknown as {
      getShell(): { enumerateAllCommandPaths(): string[]; migratedPaths(): readonly string[] };
    }).getShell();

    const chemins = shell.enumerateAllCommandPaths();
    const migres = shell.migratedPaths();

    expect(migres).toContain('clear logging');
    expect(migres).not.toContain('clear logging persistent');
    expect(chemins).toContain('clear logging persistent');
  });

  it('et les deux s\'executent, chacune par son moteur', async () => {
    const r = await router();

    expect(await r.executeCommand('clear logging persistent')).not.toContain('Invalid input');
    expect(await r.executeCommand('clear logging')).not.toContain('Invalid input');
  });

  it('`clear ip arp <ip>` inconnue est refusee', async () => {
    const r = await router();

    expect(await r.executeCommand('clear ip arp 203.0.113.9')).toContain('No matching ARP');
  });

  it('`clear ?` decrit encore la famille entiere, socle et trie melanges', async () => {
    const r = await router();

    const aide = await r.executeCommand('clear ?');

    expect(aide).toContain('counters');
    expect(aide).toContain('logging');
    expect(aide).toContain('line');
  });
});
