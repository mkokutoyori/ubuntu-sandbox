/**
 * Les changements de mode — sur la hierarchie DU DEPOT, pas une nouvelle.
 *
 * Correction d'un doublon que j'ai introduit moi-meme il y a une heure :
 * mon enum `CliMode` (7 valeurs) redoublait `CISCO_IOS_MODES` (20+ modes,
 * avec parents et `clearOnExit`) et `CLIStateMachine`, qui existent depuis
 * longtemps et sont meilleurs. Le socle les ADOPTE : un mode est une
 * chaine, la hierarchie est une donnee, et la navigation `exit`/`end` est
 * deleguee a la machine a etats existante. L'invite vient de
 * `buildPrompt` + `CISCO_IOS_PROMPTS`, pour la meme raison.
 *
 * Ce que ce fichier fixe, et qui n'existait pas :
 *
 *   1. **Une transition est DECLARATIVE.** `configure terminal` declare
 *      `enters: 'config'` ; le moteur n'a aucun `if` par commande. C'est ce
 *      qui permet d'ajouter `interface`, `line`, `router` sans le toucher.
 *   2. **Un sous-mode retient SON contexte.** `interface Gi0/0` entre en
 *      `config-if` en retenant l'interface : sans cela, `ip address` ne
 *      saurait pas quoi configurer.
 *   3. **`exit` remonte d'un cran, `end` revient a l'EXEC**, et le champ de
 *      contexte est OUBLIE en sortant — sinon un `ip address` tape plus
 *      tard atterrirait sur une interface qu'on croyait avoir quittee.
 *   4. **Une transition refusee ne change pas le mode.** Une commande qui
 *      echoue ne doit pas laisser l'operateur ailleurs qu'ou il croyait.
 */

import { describe, it, expect } from 'vitest';
import { CliEngine } from '@/cli/CliEngine';
import { CommandTable } from '@/cli/CommandTable';
import { newSession, promptOf, type CliSession } from '@/cli/CliSession';
import { NAVIGATION_COMMANDS } from '@/cli/commands/navigation';

function table(): CommandTable {
  const t = new CommandTable();

  t.declare({
    id: 'enable', path: ['enable'], description: 'Turn on privileged commands',
    modes: ['user'], minPrivilege: 1, enters: 'privileged',
    run: () => '',
  });
  t.declare({
    id: 'configure-terminal', path: ['configure', 'terminal'],
    description: 'Configure from the terminal',
    modes: ['privileged'], minPrivilege: 15, enters: 'config',
    run: () => '',
  });
  t.declare({
    id: 'interface', path: ['interface', { name: 'name', type: 'INTERFACE' }],
    description: 'Select an interface to configure',
    modes: ['config'], minPrivilege: 15,
    enters: 'config-if', contextField: 'selectedInterface', contextFrom: 'name',
    run: () => '',
  });
  t.declare({
    id: 'line', path: ['line', { name: 'kind', type: 'WORD' }, { name: 'index', type: 'INT' }],
    description: 'Configure a terminal line',
    modes: ['config'], minPrivilege: 15, enters: 'config-line',
    run: () => '',
  });
  t.declare({
    id: 'ip-address',
    path: ['ip', 'address',
      { name: 'address', type: 'IP_ADDR' }, { name: 'mask', type: 'SUBNET_MASK' }],
    description: 'Set the IP address of an interface',
    modes: ['config-if'], minPrivilege: 15,
    run: (session, args) =>
      `${session.fields.selectedInterface}=${args.address}/${args.mask}`,
  });
  for (const spec of NAVIGATION_COMMANDS) t.declare(spec);
  t.declare({
    id: 'show-version', path: ['show', 'version'], description: 'Version',
    modes: ['user', 'privileged'], minPrivilege: 1,
    run: () => 'Cisco IOS Software',
  });
  return t;
}

function lab(): { engine: CliEngine; session: CliSession } {
  return { engine: new CliEngine(table()), session: newSession('R1', {}) };
}

describe('l\'invite vient du depot, pas d\'une seconde table', () => {
  it('une session neuve demarre en EXEC utilisateur', () => {
    const { session } = lab();

    expect(promptOf(session)).toBe('R1>');
  });

  it('chaque mode a l\'invite que `CISCO_IOS_PROMPTS` declare', async () => {
    const { engine, session } = lab();

    await engine.execute('enable', session);
    expect(promptOf(session)).toBe('R1#');

    await engine.execute('configure terminal', session);
    expect(promptOf(session)).toBe('R1(config)#');

    await engine.execute('interface GigabitEthernet0/0', session);
    expect(promptOf(session)).toBe('R1(config-if)#');
  });
});

describe('une transition est DECLARATIVE', () => {
  it('`enable` fait passer en mode privilegie', async () => {
    const { engine, session } = lab();

    await engine.execute('enable', session);

    expect(session.mode).toBe('privileged');
  });

  it('`configure terminal` descend en configuration', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);

    await engine.execute('configure terminal', session);

    expect(session.mode).toBe('config');
  });

  it('l\'abreviation transitionne aussi — `conf t`', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);

    await engine.execute('conf t', session);

    expect(session.mode).toBe('config');
  });

  it('ajouter un mode ne demande pas de toucher le moteur', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);
    await engine.execute('configure terminal', session);

    await engine.execute('line vty 0', session);

    expect(session.mode).toBe('config-line');
  });
});

describe('un sous-mode retient SON contexte', () => {
  async function inInterface() {
    const { engine, session } = lab();
    await engine.execute('enable', session);
    await engine.execute('configure terminal', session);
    await engine.execute('interface GigabitEthernet0/0', session);
    return { engine, session };
  }

  it('l\'interface choisie est retenue', async () => {
    const { session } = await inInterface();

    expect(session.fields.selectedInterface).toBe('GigabitEthernet0/0');
  });

  it('la commande du sous-mode LIT ce contexte', async () => {
    const { engine, session } = await inInterface();

    const out = await engine.execute('ip address 192.168.1.1 255.255.255.0', session);

    expect(out).toBe('GigabitEthernet0/0=192.168.1.1/255.255.255.0');
  });

  it('changer d\'interface change le contexte', async () => {
    const { engine, session } = await inInterface();

    await engine.execute('interface GigabitEthernet0/1', session);

    expect(session.fields.selectedInterface).toBe('GigabitEthernet0/1');
  });
});

describe('`exit` remonte, `end` revient a l\'EXEC', () => {
  async function inInterface() {
    const { engine, session } = lab();
    await engine.execute('enable', session);
    await engine.execute('configure terminal', session);
    await engine.execute('interface GigabitEthernet0/0', session);
    return { engine, session };
  }

  it('`exit` remonte d\'UN cran', async () => {
    const { engine, session } = await inInterface();

    await engine.execute('exit', session);

    expect(session.mode).toBe('config');
  });

  it('`end` revient directement en EXEC privilegie, de trois crans', async () => {
    const { engine, session } = await inInterface();

    await engine.execute('end', session);

    expect(session.mode).toBe('privileged');
  });

  it('le contexte est OUBLIE en sortant — sinon on configure a l\'aveugle', async () => {
    const { engine, session } = await inInterface();

    await engine.execute('exit', session);

    expect(session.fields.selectedInterface).toBeUndefined();
  });

  it('`end` l\'oublie aussi', async () => {
    const { engine, session } = await inInterface();

    await engine.execute('end', session);

    expect(session.fields.selectedInterface).toBeUndefined();
  });

  it('`exit` au sommet ne fait pas sortir de la machine', async () => {
    const { engine, session } = lab();

    await engine.execute('exit', session);

    expect(session.mode).toBe('user');
  });
});

describe('une commande refusee ne DEPLACE pas l\'operateur', () => {
  it('un mode qui ne convient pas laisse la session ou elle etait', async () => {
    const { engine, session } = lab();

    await engine.execute('configure terminal', session);

    expect(session.mode).toBe('user');
  });

  it('un privilege insuffisant non plus', async () => {
    const { engine } = lab();
    const session = newSession('R1', {}, { privilegeLevel: 1 });
    await engine.execute('enable', session);

    await engine.execute('configure terminal', session);

    expect(session.mode).toBe('privileged');
  });

  it('un argument invalide n\'entre pas dans le sous-mode', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);
    await engine.execute('configure terminal', session);

    await engine.execute('interface zorglub!!', session);

    expect(session.mode).toBe('config');
    expect(session.fields.selectedInterface).toBeUndefined();
  });
});

describe('la completion suit le mode courant', () => {
  it('en EXEC utilisateur, `configure` n\'est pas propose', () => {
    const { engine, session } = lab();

    const result = engine.complete('', session, 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).not.toContain('configure');
  });

  it('en EXEC privilegie, il l\'est', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);

    const result = engine.complete('', session, 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('configure');
  });

  it('en `config-if`, on voit `ip` et plus `show version`', async () => {
    const { engine, session } = lab();
    await engine.execute('enable', session);
    await engine.execute('configure terminal', session);
    await engine.execute('interface GigabitEthernet0/0', session);

    const result = engine.complete('', session, 'QUESTION_MARK');
    const words = result.suggestions.map(s => s.value);

    expect(words).toContain('ip');
    expect(words).not.toContain('show');
  });
});
