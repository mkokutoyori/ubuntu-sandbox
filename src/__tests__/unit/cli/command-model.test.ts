/**
 * Le socle du nouveau moteur de commandes — les bases, avant migration.
 *
 * Mesure faite AVANT d'ecrire : ce depot porte deja `CommandTrie` (1762
 * lignes, 803 enregistrements, 46 fichiers). Ce socle ne le remplace pas
 * encore ; il pose ce que la mesure a montre manquant, de sorte que la
 * migration puisse etre incrementale, une famille de commandes a la fois.
 *
 * Les quatre decisions que ce fichier fixe, chacune contre un defaut
 * observe :
 *
 *   1. **Un seul arbre, construit une fois.** Aujourd'hui un
 *      `CiscoIOSShell` construit 54 tries, et `createVtyShell()` refait
 *      tout a CHAQUE session SSH. Le vocabulaire est une propriete de la
 *      PLATEFORME ; ce qui appartient a la session est le mode, le
 *      privilege et la vue. Une declaration en double est refusee au lieu
 *      d'ecraser silencieusement.
 *
 *   2. **L'abreviation et l'ambiguite sont le meme mecanisme.** `sh run`
 *      doit marcher, `s` doit repondre `% Ambiguous command`. Un moteur
 *      qui accepte l'abreviation a la completion mais exige le mot entier
 *      a l'execution ment sur ce qu'il comprend.
 *
 *   3. **Un argument type est PARSE, pas seulement decrit.** `ParamType`
 *      existe deja dans le trie et ne sert qu'a l'aide : `ip address
 *      zorglub` est accepte. Ici un type qui ne valide pas fait echouer la
 *      correspondance.
 *
 *   4. **Le gestionnaire peut etre asynchrone.** `CommandAction` rend une
 *      `string` synchrone, ce qui a oblige `_pendingAsync` et a fait vivre
 *      `test aaa group` dans le terminal graphique et NULLE PART ailleurs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommandTable,
  DuplicateCommandError,
  UnknownArgumentTypeError,
} from '@/cli/CommandTable';
import { newSession, type CliSession } from '@/cli/CliSession';
import { parseCommand } from '@/cli/CommandParser';

function session(over: { mode?: string; privilegeLevel?: number; device?: unknown } = {}): CliSession {
  const s = newSession('R1', over.device ?? {},
    { privilegeLevel: over.privilegeLevel ?? 15, initialMode: over.mode ?? 'privileged' });
  return s;
}

function table(): CommandTable {
  const t = new CommandTable();

  t.declare({
    id: 'show-running-config',
    path: ['show', 'running-config'],
    description: 'Current operating configuration',
    modes: ['privileged'],
    minPrivilege: 15,
    run: () => 'Building configuration...',
  });
  t.declare({
    id: 'show-version',
    path: ['show', 'version'],
    description: 'System hardware and software status',
    modes: ['user', 'privileged'],
    minPrivilege: 1,
    run: () => 'Cisco IOS Software',
  });
  t.declare({
    id: 'shutdown',
    path: ['shutdown'],
    description: 'Shutdown the selected interface',
    modes: ['config-if'],
    minPrivilege: 15,
    run: () => '',
  });
  t.declare({
    id: 'ip-address',
    path: ['ip', 'address', { name: 'address', type: 'IP_ADDR' }, { name: 'mask', type: 'SUBNET_MASK' }],
    description: 'Set the IP address of an interface',
    modes: ['config-if'],
    minPrivilege: 15,
    run: (_ctx, args) => `${args.address}/${args.mask}`,
  });
  return t;
}

beforeEach(() => { /* la table est reconstruite par cas */ });

describe('CommandTable — un seul arbre, construit une fois', () => {
  it('deux commandes partageant `show` partagent le NOEUD `show`', () => {
    const t = table();

    expect(t.childKeywordsOf(['show']).sort())
      .toEqual(['running-config', 'version']);
  });

  it('une declaration en double est REFUSEE, pas ecrasee en silence', () => {
    const t = table();

    expect(() => t.declare({
      id: 'autre', path: ['show', 'version'], description: 'x',
      modes: ['user'], minPrivilege: 1, run: () => '',
    })).toThrow(DuplicateCommandError);
  });

  it('un type d\'argument inconnu est refuse a la DECLARATION', () => {
    const t = new CommandTable();

    expect(() => t.declare({
      id: 'x', path: ['foo', { name: 'a', type: 'ZORGLUB' as never }],
      description: 'x', modes: ['user'], minPrivilege: 1, run: () => '',
    })).toThrow(UnknownArgumentTypeError);
  });

  it('elle enumere ses commandes comme des DONNEES', () => {
    expect(table().specs().map(s => s.id).sort())
      .toEqual(['ip-address', 'show-running-config', 'show-version', 'shutdown']);
  });
});

describe('parseCommand — abreviation et ambiguite, un seul mecanisme', () => {
  it('le mot entier fonctionne', () => {
    const result = parseCommand(table(), 'show version', session());

    expect(result.status).toBe('ok');
  });

  it('`sh ver` fonctionne — l\'abreviation est du Cisco quotidien', () => {
    const result = parseCommand(table(), 'sh ver', session());

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.spec.id).toBe('show-version');
  });

  it('une abreviation reste valide tant qu\'elle ne designe QU\'UNE commande', () => {
    const result = parseCommand(table(), 'sh r', session());

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.spec.id).toBe('show-running-config');
  });

  it('un mot ENTIER l\'emporte sur un prefixe plus long — `ip` bat `ip-helper`', () => {
    const t = new CommandTable();
    t.declare({
      id: 'court', path: ['ip'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => 'court',
    });
    t.declare({
      id: 'long', path: ['ipv6'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => 'long',
    });

    const result = parseCommand(t, 'ip', session());

    expect(result.status === 'ok' && result.spec.id).toBe('court');
  });

  it('l\'ambiguite NOMME les candidats', () => {
    const t = new CommandTable();
    t.declare({
      id: 'a', path: ['show', 'ip'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });
    t.declare({
      id: 'b', path: ['show', 'interfaces'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });

    const result = parseCommand(t, 'show i', session());

    expect(result.status === 'ambiguous' && result.candidates.sort())
      .toEqual(['interfaces', 'ip']);
  });

  it('une commande inconnue rend INVALID et dit OU', () => {
    const result = parseCommand(table(), 'show zorglub', session());

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.token).toBe('zorglub');
  });

  it('un chemin incomplet rend INCOMPLETE, ce qui n\'est pas la meme erreur', () => {
    const result = parseCommand(table(), 'show', session());

    expect(result.status).toBe('incomplete');
  });

  it('une ligne vide ne produit rien', () => {
    expect(parseCommand(table(), '   ', session()).status).toBe('empty');
  });
});

describe('parseCommand — un argument type est PARSE', () => {
  function interfaceSession() {
    return session({ mode: 'config-if' });
  }

  it('des arguments valides sont acceptes et NOMMES', () => {
    const result = parseCommand(
      table(), 'ip address 192.168.1.1 255.255.255.0', interfaceSession());

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.args).toEqual({
      address: '192.168.1.1', mask: '255.255.255.0',
    });
  });

  it('une adresse invalide fait ECHOUER la correspondance', () => {
    const result = parseCommand(
      table(), 'ip address zorglub 255.255.255.0', interfaceSession());

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.token).toBe('zorglub');
  });

  it('un masque qui n\'en est pas un echoue aussi — le temoin', () => {
    const result = parseCommand(
      table(), 'ip address 192.168.1.1 255.0.255.0', interfaceSession());

    expect(result.status).toBe('invalid');
  });

  it('un argument manquant rend INCOMPLETE, pas INVALID', () => {
    const result = parseCommand(table(), 'ip address 192.168.1.1', interfaceSession());

    expect(result.status).toBe('incomplete');
  });
});

describe('l\'acces est une DONNEE de la commande', () => {
  it('un mode qui ne convient pas rend la commande INVISIBLE, comme IOS', () => {
    const result = parseCommand(table(), 'shutdown', session());

    expect(result.status).toBe('invalid');
  });

  it('dans le bon mode, elle existe', () => {
    const result = parseCommand(
      table(), 'shutdown', session({ mode: 'config-if' }));

    expect(result.status).toBe('ok');
  });

  it('un privilege insuffisant la rend invisible aussi', () => {
    const result = parseCommand(
      table(), 'show running-config', session({ privilegeLevel: 5 }));

    expect(result.status).toBe('invalid');
  });

  it('le meme utilisateur voit ce que son niveau permet — le temoin', () => {
    const result = parseCommand(
      table(), 'show version', session({ privilegeLevel: 5 }));

    expect(result.status).toBe('ok');
  });

  it('`privilege exec level N` DEPLACE une commande, comme sur un vrai IOS', () => {
    const t = table();
    t.setPrivilegeOverride(['show', 'running-config'], 5);

    const result = parseCommand(t, 'show running-config', session({ privilegeLevel: 5 }));

    expect(result.status).toBe('ok');
  });

  it('et l\'inverse : un niveau releve la retire a qui l\'avait', () => {
    const t = table();
    t.setPrivilegeOverride(['show', 'version'], 15);

    expect(parseCommand(t, 'show version', session({ privilegeLevel: 5 })).status)
      .toBe('invalid');
  });
});

describe('le gestionnaire peut etre asynchrone', () => {
  it('un gestionnaire synchrone rend sa chaine', async () => {
    const result = parseCommand(table(), 'show version', session());
    if (result.status !== 'ok') throw new Error('attendu ok');

    expect(await result.spec.run(session(), result.args)).toBe('Cisco IOS Software');
  });

  it('un gestionnaire asynchrone est attendu, sans ecoutille', async () => {
    const t = new CommandTable();
    t.declare({
      id: 'ping', path: ['ping', { name: 'target', type: 'IP_ADDR' }],
      description: 'Send echo messages',
      modes: ['privileged'], minPrivilege: 1,
      run: async (_ctx, args) => `pinging ${args.target}`,
    });

    const result = parseCommand(t, 'ping 10.0.0.1', session());
    if (result.status !== 'ok') throw new Error('attendu ok');

    expect(await result.spec.run(session(), result.args)).toBe('pinging 10.0.0.1');
  });
});

describe('le port d\'autorisation — le socle DEMANDE, il ne decide pas', () => {
  it('sans port, la regle simple du socle s\'applique', () => {
    const t = table();

    expect(parseCommand(t, 'show running-config', session({ privilegeLevel: 5 })).status)
      .toBe('invalid');
  });

  it('un port branche REMPLACE la comparaison de niveau', () => {
    const t = table();
    t.attachAuthorization({ authorizes: () => true });

    expect(parseCommand(t, 'show running-config', session({ privilegeLevel: 1 })).status)
      .toBe('ok');
  });

  it('et il peut REFUSER ce que le niveau aurait permis', () => {
    const t = table();
    t.attachAuthorization({ authorizes: () => false });

    expect(parseCommand(t, 'show version', session({ privilegeLevel: 15 })).status)
      .toBe('invalid');
  });

  it('le port recoit le chemin CANONIQUE et le niveau requis', () => {
    const t = table();
    const vus: Array<[string, number]> = [];
    t.attachAuthorization({
      authorizes: (command, level) => { vus.push([command, level]); return true; },
    });

    parseCommand(t, 'show version', session());

    expect(vus).toContainEqual(['show version', 1]);
  });

  it('le MODE reste decide par le socle, jamais par le port', () => {
    const t = table();
    t.attachAuthorization({ authorizes: () => true });

    expect(parseCommand(t, 'shutdown', session()).status).toBe('invalid');
  });

  it('`privilege exec level` passe au port comme niveau requis', () => {
    const t = table();
    const vus: number[] = [];
    t.setPrivilegeOverride(['show', 'running-config'], 5);
    t.attachAuthorization({ authorizes: (_c, level) => { vus.push(level); return true; } });

    parseCommand(t, 'show running-config', session());

    expect(vus).toContain(5);
  });

  it('le detacher rend la regle simple', () => {
    const t = table();
    t.attachAuthorization({ authorizes: () => false });
    t.attachAuthorization(null);

    expect(parseCommand(t, 'show version', session()).status).toBe('ok');
  });
});
