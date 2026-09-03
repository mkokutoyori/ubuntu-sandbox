/**
 * `execute batch` met les commandes EN FILE au lieu de les executer, et
 * `lastlog` rend le code de retour de chacune.
 *
 * La famille n'existait pas — « unknown action "batch" » — alors que
 * c'est le seul mecanisme de la CLI qui differe l'execution : entre
 * `execute batch start` et `execute batch end`, une vraie machine ne
 * REPOND rien et n'applique rien ; elle empile ce qu'on tape et le
 * deroule d'un coup a la sortie. La reference 6.0.4 donne les deux
 * annonces mot pour mot — « Enter batch mode... » a l'entree, « Exit and
 * run batch commands... » a la sortie — et son exemple montre un bloc
 * `config system global` / `set refresh 5` / `end` tape entre les deux.
 *
 * Le code de retour n'est pas invente : une transcription reelle montre
 * `lastlog` prefixant chaque ligne par `0: ` en cas de succes, et la
 * documentation dit que toute autre valeur est une erreur. Or ce
 * simulateur ECRIT deja ce nombre — `Command fail. Return code -61` est
 * la constante `FORTI_COMMAND_FAIL` que porte chaque refus —, donc le
 * code se LIT sur la sortie de la commande au lieu d'ouvrir une seconde
 * notion d'echec a cote de celle qui existe. Une commande refusee entre
 * au journal avec son -61, ce qu'un cas epingle.
 *
 * L'interception est posee AVANT le socle et avant le controle de mode,
 * et c'est necessaire : les lignes mises en file entrent dans des
 * sous-modes de configuration, donc `execute batch end` doit etre
 * reconnue depuis n'importe quel mode, sans quoi une file contenant
 * `config system interface` enfermerait la session. Elle est posee APRES
 * l'aide, `?` etant une touche d'edition et non une commande.
 *
 * Deux points ne sont attestes par aucune source et sont tranches ici
 * plutot que laisses au hasard, chacun du cote qui ne detruit rien :
 * `start` en mode batch est IDEMPOTENT (il ne vide pas la file qu'on
 * vient de remplir) et `end` hors mode batch est INERTE (il n'efface pas
 * le journal du batch precedent). La formulation de `status` est de meme
 * deduite : la reference dit qu'elle rapporte « running or stopped »,
 * donc ce sont ces deux mots.
 *
 * Discrimine par `git stash push` : 12 des 13 cas tombent. Le treizieme
 * est nomme ici plutot que laisse a decouvrir : « refuse une operation
 * qui n'existe pas » passait deja avant correctif, mais pour une raison
 * qui ne prouve rien de la famille — c'est `batch` lui-meme qui etait
 * une action inconnue, pas `zorglub`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function shell(): FortiShell {
  return new FortiShell(new FortiGate('firewall-fortinet', 'FGT', 0, 0));
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

describe('execute batch', () => {
  it('annonce l\'entree en mode batch avec les mots de la reference', () => {
    expect(run(shell(), 'execute batch start')).toBe('Enter batch mode...');
  });

  it('ne repond rien et n\'applique rien tant que le batch dure', () => {
    const sh = shell();
    run(sh, 'execute batch start');
    const echo = run(sh, 'config system global', 'set hostname "BATCHED"', 'end');
    expect(echo).toBe('');
    expect(run(sh, 'execute batch status')).toContain('running');
    expect(sh.execute('get system status')).not.toContain('BATCHED');
  });

  it('deroule la file a la sortie et configure pour de bon', () => {
    const sh = shell();
    run(sh, 'execute batch start',
      'config system global', 'set hostname "BATCHED"', 'end');
    expect(run(sh, 'execute batch end')).toBe('Exit and run batch commands...');
    expect(sh.execute('get system status')).toContain('Hostname: BATCHED');
  });

  it('rapporte running puis stopped', () => {
    const sh = shell();
    expect(run(sh, 'execute batch status')).toBe('Batch mode is stopped.');
    run(sh, 'execute batch start');
    expect(run(sh, 'execute batch status')).toBe('Batch mode is running.');
    run(sh, 'execute batch end');
    expect(run(sh, 'execute batch status')).toBe('Batch mode is stopped.');
  });

  it('prefixe chaque ligne du journal par son code de retour', () => {
    const sh = shell();
    run(sh, 'execute batch start',
      'config system global', 'set hostname "BATCHED"', 'end', 'execute batch end');
    expect(run(sh, 'execute batch lastlog')).toBe([
      '0: config system global',
      '0: set hostname "BATCHED"',
      '0: end',
    ].join('\n'));
  });

  it('porte au journal le code de retour reel d\'une commande refusee', () => {
    const sh = shell();
    run(sh, 'execute batch start', 'config system zorglub', 'execute batch end');
    expect(run(sh, 'execute batch lastlog')).toBe('-61: config system zorglub');
  });

  it('rend un journal vide tant qu\'aucun batch n\'a tourne', () => {
    expect(run(shell(), 'execute batch lastlog')).toBe('');
  });

  it('annonce ses quatre operations', () => {
    const aide = run(shell(), 'execute batch ?');
    for (const mot of ['start', 'end', 'lastlog', 'status']) {
      expect(aide).toContain(mot);
    }
  });

  it('refuse une operation qui n\'existe pas', () => {
    expect(run(shell(), 'execute batch zorglub')).toContain('Unknown action');
  });

  it('reclame une operation quand il n\'y en a pas', () => {
    expect(run(shell(), 'execute batch')).toContain('command parse error');
  });

  it('departage une abreviation ambigue entre start et status', () => {
    const sortie = run(shell(), 'exe bat sta');
    expect(sortie).toContain('start');
    expect(sortie).toContain('status');
  });

  it('reconnait sa sortie depuis un sous-mode ouvert par la file', () => {
    const sh = shell();
    run(sh, 'execute batch start',
      'config system interface', 'edit "port1"', 'set alias "LAN"', 'next', 'end');
    expect(run(sh, 'execute batch end')).toBe('Exit and run batch commands...');
    expect(sh.execute('show system interface port1')).toContain('set alias "LAN"');
  });

  it('une sortie hors mode batch n\'efface pas le journal precedent', () => {
    const sh = shell();
    run(sh, 'execute batch start', 'config system zorglub', 'execute batch end');
    run(sh, 'execute batch end');
    expect(run(sh, 'execute batch lastlog')).toBe('-61: config system zorglub');
  });
});
