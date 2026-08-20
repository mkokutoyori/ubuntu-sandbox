import { describe, it, expect } from 'vitest';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { CommandSpecError } from '@/network/devices/shells/cli/CommandSpec';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

const motsAide = (trie: CommandTrie, entree: string): string[] =>
  trie.getCompletions(entree).map((c) => c.keyword);

describe('`declare` construit le même nœud que `register`', () => {
  it('la commande déclarée s\'exécute, se propose et se complète', () => {
    const trie = new CommandTrie();
    trie.declare({
      path: 'service password-encryption',
      description: 'Encrypt system passwords',
      run: () => 'fait',
    });
    expect(trie.match('service password-encryption').status).toBe('ok');
    expect(motsAide(trie, 'service ')).toContain('password-encryption');
    expect(trie.tabCandidates('service pass')).toEqual(['service password-encryption']);
  });

  it('les arguments déclarés sont annoncés par `?` sans seconde table', () => {
    const trie = new CommandTrie();
    trie.declare({
      path: 'vlan',
      description: 'Create a VLAN',
      args: [{ name: 'id', type: 'INT', description: 'VLAN identifier', range: [1, 4094] }],
      run: (args) => args[0] ?? '',
    });
    expect(motsAide(trie, 'vlan ')).toContain('<1-4094>');
  });

  it('un mot-clé qui suit une commande gloutonne se DÉCLARE', () => {
    const trie = new CommandTrie();
    trie.declare({
      path: 'show interfaces',
      description: 'Display interfaces',
      continuations: [{ keyword: 'summary', description: 'Interface summary' }],
      run: (args) => args.join(' '),
    });
    expect(motsAide(trie, 'show interfaces ')).toContain('summary');
    expect(trie.tabCandidates('show interfaces sum')).toEqual(['show interfaces summary']);
  });
});

describe('une déclaration incomplète est refusée à la construction', () => {
  it('sans description', () => {
    const trie = new CommandTrie();
    expect(() => trie.declare({ path: 'hostname', description: '', run: () => '' }))
      .toThrow(CommandSpecError);
  });

  it('sans chemin', () => {
    const trie = new CommandTrie();
    expect(() => trie.declare({ path: '  ', description: 'x', run: () => '' }))
      .toThrow(CommandSpecError);
  });

  it('un gestionnaire qui LIT des arguments doit dire lesquels', () => {
    const trie = new CommandTrie();
    expect(() => trie.declare({
      path: 'service',
      description: 'Service configuration',
      run: (args) => args.join(' '),
    })).toThrow(/declare args, continuations, or freeform/);
  });

  it('un argument libre se déclare libre, et passe', () => {
    const trie = new CommandTrie();
    trie.declare({
      path: 'banner motd',
      description: 'Set message of the day banner',
      freeform: true,
      run: (args) => args.join(' '),
    });
    expect(trie.match('banner motd bonjour tout le monde').status).toBe('ok');
  });

  it('un argument sans description est refusé', () => {
    const trie = new CommandTrie();
    expect(() => trie.declare({
      path: 'vlan',
      description: 'Create a VLAN',
      args: [{ name: 'id', type: 'INT', description: '' }],
      run: (args) => args[0] ?? '',
    })).toThrow(/needs a description/);
  });

  it('une énumération sans valeurs est refusée', () => {
    const trie = new CommandTrie();
    expect(() => trie.declare({
      path: 'switchport mode',
      description: 'Set the port mode',
      args: [{ name: 'mode', type: 'ENUM', description: 'Port mode', values: [] }],
      run: (args) => args[0] ?? '',
    })).toThrow(/ENUM with no values/);
  });
});

describe('la plateforme se déclare sur la commande', () => {
  it('une commande réservée au routeur n\'existe pas sur le commutateur', () => {
    const commutateur = new CommandTrie();
    commutateur.setPlatform('switch');
    commutateur.declare({
      path: 'config-register',
      description: 'Set the configuration register',
      platforms: ['router'],
      args: [{ name: 'value', type: 'WORD', description: 'Register value' }],
      run: (args) => args[0] ?? '',
    });
    expect(commutateur.match('config-register 0x2102').status).not.toBe('ok');
    expect(motsAide(commutateur, '')).not.toContain('config-register');
  });

  it('la même déclaration existe sur le routeur', () => {
    const routeur = new CommandTrie();
    routeur.setPlatform('router');
    routeur.declare({
      path: 'config-register',
      description: 'Set the configuration register',
      platforms: ['router'],
      args: [{ name: 'value', type: 'WORD', description: 'Register value' }],
      run: (args) => args[0] ?? '',
    });
    expect(routeur.match('config-register 0x2102').status).toBe('ok');
  });

  it('sans plateforme déclarée, la commande vaut partout', () => {
    const trie = new CommandTrie();
    trie.setPlatform('switch');
    trie.declare({ path: 'hostname', description: 'Set the hostname', freeform: true, run: () => '' });
    expect(motsAide(trie, '')).toContain('hostname');
  });
});

describe('la sérialisation est le troisième coin du triangle', () => {
  it('une commande déclarée rend sa ligne de configuration', () => {
    const trie = new CommandTrie();
    let actif = false;
    trie.declare({
      path: 'service password-encryption',
      description: 'Encrypt system passwords',
      run: () => { actif = true; return ''; },
      serialize: () => (actif ? ['service password-encryption'] : []),
    });
    expect(trie.declaredConfigLines(null)).toEqual([]);
    const resultat = trie.match('service password-encryption');
    expect(resultat.status).toBe('ok');
    resultat.node!.action!([], 'service password-encryption');
    expect(actif).toBe(true);
    expect(trie.declaredConfigLines(null)).toEqual(['service password-encryption']);
  });

  it('une commande sans sérialiseur n\'écrit rien', () => {
    const trie = new CommandTrie();
    trie.declare({ path: 'show version', description: 'Display version', run: () => 'v' });
    expect(trie.declaredConfigLines(null)).toEqual([]);
  });
});

describe('le chemin déclaratif sert une vraie machine', () => {
  it('`show startup-config` du commutateur passe par `declare`', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show startup-config'))
      .toContain('startup-config is not present');
    await sw.executeCommand('write memory');
    const apres = await sw.executeCommand('show startup-config');
    expect(apres).toContain('Using ');
    expect(apres).toContain('hostname SW');
    expect(await sw.executeCommand('show configuration')).toBe(apres);
  }, 30_000);

  it('et reste découvrable par les deux portes', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    await sw.executeCommand('enable');
    expect(sw.cliHelp('show ')).toContain('startup-config');
    expect(sw.cliTabCandidates('show startup-')).toContain('show startup-config');
  }, 30_000);
});
