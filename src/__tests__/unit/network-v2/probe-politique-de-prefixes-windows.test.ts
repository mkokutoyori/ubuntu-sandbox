/**
 * La table de politique des prefixes de Windows a UN proprietaire : `PrefixPolicyStore`, que `netsh interface ipv6 show|add|set|delete
 * prefixpolic(y|ies)` lit et ecrit, et que `WindowsPC.destinationPolicy()` donne a l'ordre des destinations (RFC 6724 / rfc3484_sort
 * des lots voisins). Deux magasins, comme la commande : `active` (ce que la pile utilise, perdu au demarrage suivant) et `persistent`
 * (par defaut pour une ecriture, qui touche alors les deux). Un demarrage de la machine remet l'actif a l'etat persistant.
 *
 * Mesure de depart (0c2dc24d, un WindowsPC) : `netsh interface ipv6 show prefixpolicies` et `set prefixpolicy ::/96 3 4` repondent
 * l'aide du contexte (douze lignes, la table n'est ni affichee ni lue), `add prefixpolicy ::/96 3 4` repond
 * `Usage: netsh interface ipv6 add address|route ...` et `delete prefixpolicy ::/96` `Usage: netsh interface ipv6 delete route|address ...` :
 * la table est inaccessible, donc l'administrateur ne peut pas changer l'ordre d'un nom a deux familles.
 *
 * Autorites : les aides de `netsh interface ipv6 add|set|delete prefixpolicy` et `show prefixpolicies` d'une console reelle (Windows
 * Vista 6.0.6001, page colorconsole.de : usage, parametres, remarques et exemples, repris mot pour mot, y compris `store` et son
 * defaut `persistent`) ; la syntaxe de `official_docs/microsoft/windows-server/windows-commands-part002.pdf` (`[store=]active|persistent`,
 * l'exemple `add prefixpolicy prefix=2001:db8::/32 precedence=40 label=2 store=persistent`) ; deux captures de `show prefixpolicies`
 * (think.unblog.ch, techjourney.net) pour la forme de la table : la ligne `Querying active state...`, l'en-tete
 * `Precedence  Label  Prefix`, le trait `----------  -----  --------------------------------`, la precedence et l'etiquette alignees
 * a droite sur 10 et 5 colonnes, les lignes classees par precedence decroissante. Les valeurs d'usine sont celles de la RFC 6724 §2.1
 * (neuf lignes) ; les captures trouvees d'une ancienne version de Windows 10 portent la table de la RFC 3484 (six lignes), aucune
 * capture d'un Windows recent n'a ete atteinte : la table d'usine et l'ordre des lignes de meme precedence (fec0::/10, 3ffe::/16, puis
 * ::/96) ne sont pas figes. Les mots des erreurs (`The object already exists.`, `Element not found.`, `The parameter is incorrect.`,
 * `The requested operation requires elevation.`) sont ceux que le reste de `netsh` de ce depot emploie ; le texte de l'en-tete du
 * magasin persistant (`Querying persistent state...`) est deduit de celui du magasin actif et n'est pas attesté.
 *
 * Discrimination : les 32 cas tombent contre 0c2dc24d (les sources de la machine remises a leur etat, la sonde conservee) : aucune des
 * quatre commandes n'y existe et `WindowsPC.destinationPolicy()` n'y lit aucune table. Aucun temoin de banc : aucun cas n'est un refus
 * sans son pendant qui reussit (chaque refus a, dans le meme `describe`, la commande correcte qui change la table).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { labelOf, orderDestinations, precedenceOf, RFC6724_POLICY, type SelectableAddress } from '@/network/layers/internet/DestinationSelection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const machine = (user: 'Administrator' | 'User' = 'Administrator'): WindowsPC => {
  const windows = new WindowsPC('windows-pc', 'WIN', 0, 0);
  windows.powerOn();
  windows.setCurrentUser(user);
  return windows;
};

const TABLE_HEADER = 'Precedence  Label  Prefix\n----------  -----  --------------------------------';

const FACTORY_ROWS = [
  '        50      0  ::1/128',
  '        40      1  ::/0',
  '        35      4  ::ffff:0:0/96',
  '        30      2  2002::/16',
  '         5      5  2001::/32',
  '         3     13  fc00::/7',
  '         1     11  fec0::/10',
  '         1     12  3ffe::/16',
  '         1      3  ::/96',
];

const table = (state: 'active' | 'persistent', rows: readonly string[]): string =>
  `Querying ${state} state...\n\n${TABLE_HEADER}\n${rows.join('\n')}\n`;

const show = (windows: WindowsPC, suffix = ''): Promise<string> =>
  windows.executeCommand(`netsh interface ipv6 show prefixpolicies${suffix}`);

describe('show prefixpolicies prints the table the way netsh prints it', () => {
  it('the factory table, in the layout of a console: state line, header, rule, rows by decreasing precedence', async () => {
    const windows = machine();
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS));
  });

  it('store=active and store=persistent name their state, and the two stores start equal', async () => {
    const windows = machine();
    expect(await show(windows, ' store=active')).toBe(table('active', FACTORY_ROWS));
    expect(await show(windows, ' persistent')).toBe(table('persistent', FACTORY_ROWS));
  });

  it('a store that does not exist is a parameter error', async () => {
    const windows = machine();
    expect(await show(windows, ' store=volatile')).toBe('The parameter is incorrect.');
  });
});

describe('add, set and delete change the table the stack uses', () => {
  it('add puts a row where its precedence puts it, in the three spellings of the arguments', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2')).toBe('Ok.');
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy prefix=2001:db8:1::/48 precedence=45 label=14')).toBe('Ok.');
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy label=15 2001:db8:2::/48 precedence=44')).toBe('Ok.');
    expect(await show(windows)).toBe(table('active', [
      FACTORY_ROWS[0],
      '        45     14  2001:db8:1::/48',
      '        44     15  2001:db8:2::/48',
      FACTORY_ROWS[1],
      '        40      2  2001:db8::/32',
      ...FACTORY_ROWS.slice(2),
    ]));
  });

  it('add refuses a prefix the table already holds', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy ::ffff:0:0/96 46 4')).toBe('The object already exists.');
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2')).toBe('Ok.');
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 41 2')).toBe('The object already exists.');
  });

  it('set rewrites the precedence and the label of an existing prefix and refuses a missing one', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 46 4')).toBe('Ok.');
    expect(await show(windows)).toBe(table('active', [
      '        50      0  ::1/128',
      '        46      4  ::ffff:0:0/96',
      '        40      1  ::/0',
      ...FACTORY_ROWS.slice(3),
    ]));
    expect(await windows.executeCommand('netsh interface ipv6 set prefixpolicy 2001:db8::/32 40 2')).toBe('Element not found.');
  });

  it('delete removes a row and refuses a row that is not there', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 delete prefixpolicy 3ffe::/16')).toBe('Ok.');
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS.filter((row) => !row.endsWith('3ffe::/16'))));
    expect(await windows.executeCommand('netsh interface ipv6 delete prefixpolicy 3ffe::/16')).toBe('Element not found.');
    expect(await windows.executeCommand('netsh interface ipv6 delete prefixpolicy prefix=fec0::/10')).toBe('Ok.');
  });

  it('the table the stack uses is the one the commands change: the ordering follows set prefixpolicy', async () => {
    const windows = machine();
    const sources = new Map<string, SelectableAddress>([['2001:db8::1', new IPv6Address('2001:db8::2')], ['10.0.0.1', new IPAddress('10.0.0.2')]]);
    const port = { sourceFor: (destination: SelectableAddress) => ({ address: sources.get(destination.toString())! }) };
    const ordered = () => orderDestinations(
      [new IPv6Address('2001:db8::1'), new IPAddress('10.0.0.1')], (candidate) => candidate, port, windows.destinationPolicy(),
    ).map(String);
    for (const text of ['::1', '::2', '2001:db8::1', '2001:0:1::1', '2002::1', 'fc00::1', 'fec0::1', '3ffe::1', '10.0.0.1']) {
      const address = text.includes(':') ? new IPv6Address(text) : new IPAddress(text);
      expect(labelOf(address, windows.destinationPolicy())).toBe(labelOf(address, RFC6724_POLICY));
      expect(precedenceOf(address, windows.destinationPolicy())).toBe(precedenceOf(address, RFC6724_POLICY));
    }
    expect(ordered()).toEqual(['2001:db8::1', '10.0.0.1']);
    await windows.executeCommand('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 46 4');
    expect(precedenceOf(new IPAddress('10.0.0.1'), windows.destinationPolicy())).toBe(46);
    expect(ordered()).toEqual(['10.0.0.1', '2001:db8::1']);
    await windows.executeCommand('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 35 4');
    expect(ordered()).toEqual(['2001:db8::1', '10.0.0.1']);
  });
});

describe('the store decides how long a change lasts', () => {
  it('store=active changes only the active table; a boot gives the persistent table back', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 46 4 store=active')).toBe('Ok.');
    expect(precedenceOf(new IPAddress('10.0.0.1'), windows.destinationPolicy())).toBe(46);
    expect(await show(windows, ' store=persistent')).toBe(table('persistent', FACTORY_ROWS));
    windows.powerOff();
    windows.powerOn();
    expect(precedenceOf(new IPAddress('10.0.0.1'), windows.destinationPolicy())).toBe(35);
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS));
  });

  it('the default store is persistent: the change shows in both tables and survives a boot', async () => {
    const windows = machine();
    await windows.executeCommand('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 46 4');
    const changed = table('active', ['        50      0  ::1/128', '        46      4  ::ffff:0:0/96', '        40      1  ::/0', ...FACTORY_ROWS.slice(3)]);
    expect(await show(windows)).toBe(changed);
    expect(await show(windows, ' store=persistent')).toBe(changed.replace('active', 'persistent'));
    windows.powerOff();
    windows.powerOn();
    expect(precedenceOf(new IPAddress('10.0.0.1'), windows.destinationPolicy())).toBe(46);
  });

  it('store=active on add and delete are lost at the next boot too', async () => {
    const windows = machine();
    await windows.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2 store=active');
    await windows.executeCommand('netsh interface ipv6 delete prefixpolicy 2001::/32 store=active');
    expect(labelOf(new IPv6Address('2001:db8::1'), windows.destinationPolicy())).toBe(2);
    expect(labelOf(new IPv6Address('2001:0:1::1'), windows.destinationPolicy())).toBe(1);
    windows.powerOff();
    windows.powerOn();
    expect(labelOf(new IPv6Address('2001:db8::1'), windows.destinationPolicy())).toBe(1);
    expect(labelOf(new IPv6Address('2001:0:1::1'), windows.destinationPolicy())).toBe(5);
  });

  it('a change made to the persistent store alone is read back by show and absent from the stack until a boot', async () => {
    const windows = machine();
    await windows.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2');
    await windows.executeCommand('netsh interface ipv6 delete prefixpolicy 2001:db8::/32 store=active');
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS));
    expect(await show(windows, ' store=persistent')).toContain('2001:db8::/32');
    windows.powerOff();
    windows.powerOn();
    expect(await show(windows)).toContain('2001:db8::/32');
  });
});

describe('what netsh says when the command is wrong', () => {
  it.each([
    ['add', 'netsh interface ipv6 add prefixpolicy', 'Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>'],
    ['add', 'netsh interface ipv6 add prefixpolicy ::/96 3', 'Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>'],
    ['add', 'netsh interface ipv6 add prefixpolicy ::/96 3 4 5 6', 'Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>'],
    ['add', 'netsh interface ipv6 add prefixpolicy ::/96 3 4 colour=red', 'Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>'],
    ['set', 'netsh interface ipv6 set prefixpolicy ::/96 3', 'Usage: set prefixpolicy [prefix=]<IPv6 address>/<integer> [precedence=]<integer>'],
    ['delete', 'netsh interface ipv6 delete prefixpolicy', 'Usage: delete prefixpolicy [prefix=]<IPv6 address>/<integer>'],
  ])('%s without the arguments it needs gets the sentence and the usage: %s', async (_verb, command, usageFirstLine) => {
    const windows = machine();
    const out = await windows.executeCommand(command);
    expect(out.startsWith(
      'The syntax supplied for this command is not valid. Check help for the correct syntax.\n\n' + usageFirstLine)).toBe(true);
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS));
  });

  it.each([
    ['a prefix without a length', 'add prefixpolicy 2001:db8:: 40 2'],
    ['a length above 128', 'add prefixpolicy 2001:db8::/129 40 2'],
    ['an IPv4 prefix', 'add prefixpolicy 10.0.0.0/8 40 2'],
    ['a precedence that is not a number', 'add prefixpolicy 2001:db8::/32 high 2'],
    ['a label above 4294967295', 'add prefixpolicy 2001:db8::/32 40 4294967296'],
    ['a store that does not exist', 'add prefixpolicy 2001:db8::/32 40 2 store=volatile'],
    ['a negative label', 'set prefixpolicy ::/96 3 -4'],
    ['a prefix with a zone', 'delete prefixpolicy fe80::1%4/10'],
  ])('%s is a parameter error and changes nothing', async (_name, command) => {
    const windows = machine();
    expect(await windows.executeCommand(`netsh interface ipv6 ${command}`)).toBe('The parameter is incorrect.');
    expect(await show(windows)).toBe(table('active', FACTORY_ROWS));
  });

  it('a user who is not an administrator is refused, and the same command works for an administrator', async () => {
    const user = machine('User');
    expect(await user.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2'))
      .toBe('The requested operation requires elevation.');
    expect(await user.executeCommand('netsh interface ipv6 set prefixpolicy ::/96 3 4'))
      .toBe('The requested operation requires elevation.');
    expect(await user.executeCommand('netsh interface ipv6 delete prefixpolicy ::/96'))
      .toBe('The requested operation requires elevation.');
    expect(await show(user)).toBe(table('active', FACTORY_ROWS));
    const administrator = machine('Administrator');
    expect(await administrator.executeCommand('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2')).toBe('Ok.');
  });

  it.each(['add', 'set', 'delete', 'show'])('%s ? prints the usage a console prints', async (verb) => {
    const windows = machine();
    const noun = verb === 'show' ? 'prefixpolicies' : 'prefixpolicy';
    const out = await windows.executeCommand(`netsh interface ipv6 ${verb} ${noun} ?`);
    expect(out.startsWith(`Usage: ${verb} ${noun} `)).toBe(true);
    expect(out).toContain('Remarks:');
    expect(out).toContain(verb === 'show' ? 'active: Show information in the stack (default).' : 'persistent:');
  });

  it('the usage of add is the text of the console, word for word', async () => {
    const windows = machine();
    expect(await windows.executeCommand('netsh interface ipv6 add prefixpolicy ?')).toBe(`Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>
             [precedence=]<integer> [label=]<integer>
             [[store=]active|persistent]

Parameters:

       Tag              Value
       prefix         - Prefix for which to add a policy.
       precedence     - Precedence value in the policy table, used for
                        sorting destination addresses.
       label          - Label value that allows for policies that prefer a
                        particular source address prefix for use with a
                        destination address prefix.
       store          - One of the following values:
                        active: Change only lasts until next boot.
                        persistent: Change is persistent (default).

Remarks: Adds a source and destination address selection policy for
         a given prefix.

Example:

       add prefixpolicy ::/96 3 4
`);
  });
});
