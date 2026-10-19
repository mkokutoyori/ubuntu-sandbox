/**
 * `/etc/gai.conf` est la table de politique de Linux : `parseGaiConf` lit ses lignes `label`, `precedence` et `scopev4` comme
 * `gaiconf_init` de glibc 2.35 (sysdeps/posix/getaddrinfo.c), et `LinuxMachine.destinationPolicy()` la relit a chaque appel, comme
 * le fait un processus `getaddrinfo` qui demarre. Un hote Linux livre le fichier d'usine d'Ubuntu 22.04 (celui de glibc, 65 lignes de
 * commentaires) et le supprimer rend les tables internes.
 *
 * Mesure de depart (5797b862) : aucun fichier `/etc/gai.conf` n'existe sur un LinuxPC et aucun code ne lit une table de politique ;
 * l'ordre d'un nom a deux familles ne pouvait donc pas etre change par l'administrateur, alors que la ligne
 * `precedence ::ffff:0:0/96 100` du fichier d'usine est la recette de glibc pour preferer l'IPv4.
 *
 * Autorites : le code de `gaiconf_init` et de `match_prefix` (glibc 2.35, lu sur GitHub) pour la grammaire et ses regles ; le fichier
 * `posix/gai.conf` de glibc 2.35 pour le contenu d'usine. Ce que glibc fait et qu'un lecteur ne devinerait pas est fige ici : des
 * qu'une ligne `label` (ou `precedence`, ou `scopev4`) existe, la table interne correspondante n'est plus utilisee et une ligne `::/0`
 * par defaut (etiquette 1, precedence 40, portee 14) est ajoutee si le fichier n'en donne pas ; les lignes invalides sont ignorees en
 * silence ; une valeur absente se lit 0 (strtoul de la chaine vide) ; une casse differente n'est pas une commande ; `reload` est lue
 * et n'a aucun effet visible d'une commande d'un seul appel a getaddrinfo, ce qu'est un ping. L'ordre des lignes d'un meme prefixe
 * est conserve (tri stable par longueur de prefixe decroissante) : la premiere gagne. Le comportement d'une adresse sans `/` (glibc
 * lit alors un pointeur non initialise) n'est pas fige : elle est lue comme /128.
 *
 * Discrimination : tous les cas, dont aucun ne peut passer contre 5797b862 : ni `GaiConf` ni `destinationPolicy` n'y existent, la
 * sonde ne se charge pas (« Cannot find package »). Aucun temoin de banc : aucun cas n'est un refus, chacun affirme une table, une
 * precedence, une etiquette, une portee ou un ordre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { GAI_CONF_FACTORY, GAI_CONF_PATH, parseGaiConf } from '@/network/devices/linux/network/GaiConf';
import {
  addressScope, DEFAULT_IPV4_SCOPES, GLIBC_LABELS, GLIBC_POLICY, GLIBC_PRECEDENCES, labelOf, orderDestinations, precedenceOf,
  RFC6724_POLICY, type DestinationPolicy, type SelectableAddress,
} from '@/network/layers/internet/DestinationSelection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const v6 = (text: string): IPv6Address => new IPv6Address(text);
const v4 = (text: string): IPAddress => new IPAddress(text);

describe('the lines of /etc/gai.conf are read as gaiconf_init reads them', () => {
  it('a file with no definition leaves the built-in tables in place: the factory file is only comments', () => {
    const policy = parseGaiConf(GAI_CONF_FACTORY);
    expect(policy.labels).toBe(GLIBC_LABELS);
    expect(policy.precedences).toBe(GLIBC_PRECEDENCES);
    expect(policy.ipv4Scopes).toBe(DEFAULT_IPV4_SCOPES);
    expect(parseGaiConf('')).toEqual(GLIBC_POLICY);
  });

  it('one precedence line replaces the whole built-in precedence table and adds ::/0 at 40', () => {
    const policy = parseGaiConf('precedence ::ffff:0:0/96 100\n');
    expect(precedenceOf(v4('10.0.0.1'), policy)).toBe(100);
    expect(precedenceOf(v6('::1'), policy)).toBe(40);
    expect(precedenceOf(v6('2002:c633:6401::1'), policy)).toBe(40);
    expect(precedenceOf(v6('2001:db8::1'), policy)).toBe(40);
    expect(policy.labels).toBe(GLIBC_LABELS);
  });

  it('the recipe of the factory file (the default lines with the last one raised to 100) prefers IPv4', () => {
    const recipe = [
      'precedence ::1/128 50', 'precedence ::/0 40', 'precedence 2002::/16 30', 'precedence ::/96 20',
      'precedence ::ffff:0:0/96 100',
    ].join('\n');
    const policy = parseGaiConf(recipe);
    expect(precedenceOf(v6('::1'), policy)).toBe(50);
    expect(precedenceOf(v6('2002:c633:6401::1'), policy)).toBe(30);
    expect(precedenceOf(v6('::2'), policy)).toBe(20);
    expect(precedenceOf(v4('10.0.0.1'), policy)).toBe(100);
    const sources = new Map<string, SelectableAddress>([['2001:db8::1', v6('2001:db8::2')], ['10.0.0.1', v4('10.0.0.2')]]);
    const port = { sourceFor: (destination: SelectableAddress) => ({ address: sources.get(destination.toString())! }) };
    const ordered = (policyToUse: DestinationPolicy) =>
      orderDestinations([v6('2001:db8::1'), v4('10.0.0.1')], (candidate) => candidate, port, policyToUse).map(String);
    expect(ordered(policy)).toEqual(['10.0.0.1', '2001:db8::1']);
    expect(ordered(GLIBC_POLICY)).toEqual(['2001:db8::1', '10.0.0.1']);
  });

  it('a label line replaces the whole built-in label table and adds ::/0 at 1; precedences stay built in', () => {
    const policy = parseGaiConf('label 2001:db8::/32 9\n');
    expect(labelOf(v6('2001:db8::1'), policy)).toBe(9);
    expect(labelOf(v6('::1'), policy)).toBe(1);
    expect(labelOf(v6('fd00::1'), policy)).toBe(1);
    expect(policy.precedences).toBe(GLIBC_PRECEDENCES);
  });

  it('a ::/0 line of its own is kept and no default is added after it', () => {
    const policy = parseGaiConf('precedence ::/0 10\nlabel ::/0 7\n');
    expect(precedenceOf(v6('2001:db8::1'), policy)).toBe(10);
    expect(precedenceOf(v6('::1'), policy)).toBe(10);
    expect(labelOf(v4('10.0.0.1'), policy)).toBe(7);
    expect(policy.precedences).toHaveLength(1);
    expect(policy.labels).toHaveLength(1);
  });

  it('the most specific prefix wins whatever the order of the lines, and the first of two equal prefixes counts', () => {
    const policy = parseGaiConf('precedence ::/0 10\nprecedence 2001:db8::/32 20\nprecedence 2001:db8::/32 30\nprecedence 2001:db8:1::/48 40\n');
    expect(precedenceOf(v6('2001:db8:1::1'), policy)).toBe(40);
    expect(precedenceOf(v6('2001:db8:2::1'), policy)).toBe(20);
    expect(precedenceOf(v6('2001:dba::1'), policy)).toBe(10);
  });

  it('blanks, tabs, comments and trailing words do not matter', () => {
    const policy = parseGaiConf('   precedence\t\t::ffff:0:0/96   100   extra words # and a comment\n# precedence ::/0 1\n\n');
    expect(precedenceOf(v4('10.0.0.1'), policy)).toBe(100);
    expect(precedenceOf(v6('2001:db8::1'), policy)).toBe(40);
  });

  it.each([
    ['a prefix length above 128', 'precedence ::ffff:0:0/129 100'],
    ['an IPv4 prefix', 'precedence 10.0.0.0/8 100'],
    ['a malformed address', 'precedence zz::/0 5'],
    ['an address with a zone', 'precedence fe80::1%eth0/10 5'],
    ['a value that is not a number', 'precedence ::/0 abc'],
    ['a value with trailing characters', 'precedence ::/0 5x'],
    ['a negative value', 'precedence ::/0 -5'],
    ['a value above INT_MAX', 'precedence ::/0 2147483648'],
    ['a prefix length with trailing characters', 'precedence ::/0x 5'],
    ['a command in capitals', 'Precedence ::/0 5'],
    ['a command that does not exist', 'prefer ::/0 5'],
    ['a command alone', 'precedence'],
  ])('%s is ignored in silence', (_name, line) => {
    expect(parseGaiConf(line + '\n')).toEqual(GLIBC_POLICY);
  });

  it('an invalid line does not stop the lines after it', () => {
    const policy = parseGaiConf('precedence ::/0 abc\nprecedence ::ffff:0:0/96 100\n');
    expect(precedenceOf(v4('10.0.0.1'), policy)).toBe(100);
  });

  it('a value that is absent reads 0, the way strtoul reads an empty string', () => {
    const policy = parseGaiConf('precedence ::ffff:0:0/96\n');
    expect(precedenceOf(v4('10.0.0.1'), policy)).toBe(0);
    expect(precedenceOf(v6('2001:db8::1'), policy)).toBe(40);
  });

  it('reload is read and changes nothing a one-shot command can see', () => {
    expect(parseGaiConf('reload yes\n')).toEqual(GLIBC_POLICY);
    expect(parseGaiConf('reload no\nprecedence ::ffff:0:0/96 100\n')).toEqual(parseGaiConf('precedence ::ffff:0:0/96 100\n'));
  });
});

describe('scopev4 lines (the IPv4 scope table of RFC 6724 §3.2)', () => {
  it('the dotted form and the IPv4-mapped form describe the same entry', () => {
    const dotted = parseGaiConf('scopev4 10.0.0.0/8 5\n');
    const mapped = parseGaiConf('scopev4 ::ffff:10.0.0.0/104 5\n');
    for (const policy of [dotted, mapped]) {
      expect(addressScope(v4('10.9.9.9'), policy.ipv4Scopes)).toBe(5);
      expect(addressScope(v4('11.9.9.9'), policy.ipv4Scopes)).toBe(14);
      expect(addressScope(v4('127.0.0.1'), policy.ipv4Scopes)).toBe(14);
    }
  });

  it('a host entry without a length is a /32, and the most specific entry wins', () => {
    const policy = parseGaiConf('scopev4 10.0.0.0/8 5\nscopev4 10.1.2.3 2\nscopev4 ::ffff:10.1.0.0/112 7\n');
    expect(addressScope(v4('10.1.2.3'), policy.ipv4Scopes)).toBe(2);
    expect(addressScope(v4('10.1.9.9'), policy.ipv4Scopes)).toBe(7);
    expect(addressScope(v4('10.9.9.9'), policy.ipv4Scopes)).toBe(5);
  });

  it('a 0.0.0.0/0 line of its own replaces the catch-all of 14', () => {
    const policy = parseGaiConf('scopev4 0.0.0.0/0 5\nscopev4 ::ffff:127.0.0.0/104 2\n');
    expect(addressScope(v4('8.8.8.8'), policy.ipv4Scopes)).toBe(5);
    expect(addressScope(v4('127.0.0.1'), policy.ipv4Scopes)).toBe(2);
    expect(addressScope(v4('169.254.1.1'), policy.ipv4Scopes)).toBe(5);
  });

  it.each([
    ['an IPv6 address that is not IPv4-mapped', 'scopev4 2001:db8::/112 5'],
    ['a mapped length below 96', 'scopev4 ::ffff:10.0.0.0/95 5'],
    ['a mapped length above 128', 'scopev4 ::ffff:10.0.0.0/129 5'],
    ['a dotted length above 32', 'scopev4 10.0.0.0/33 5'],
    ['a value that is not a number', 'scopev4 10.0.0.0/8 high'],
    ['a value above INT_MAX', 'scopev4 10.0.0.0/8 2147483648'],
    ['a name', 'scopev4 localhost 5'],
  ])('%s is ignored in silence', (_name, line) => {
    expect(parseGaiConf(line + '\n').ipv4Scopes).toBe(DEFAULT_IPV4_SCOPES);
  });
});

describe('a Linux machine orders by the file it holds in /etc/gai.conf', () => {
  const machine = (): LinuxPC => {
    const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
    linux.powerOn();
    return linux;
  };

  it('ships the factory file of Ubuntu 22.04 and the built-in glibc tables', async () => {
    const linux = machine();
    expect(await linux.executeCommand(`cat ${GAI_CONF_PATH}`)).toBe(GAI_CONF_FACTORY.replace(/\n$/, ''));
    expect(linux.destinationPolicy()).toEqual(GLIBC_POLICY);
  });

  it('follows the file at each call: a line appended is used, the line removed is forgotten', async () => {
    const linux = machine();
    await linux.executeCommand(`sudo sh -c "echo 'precedence ::ffff:0:0/96 100' >> ${GAI_CONF_PATH}"`);
    expect(precedenceOf(v4('10.0.0.1'), linux.destinationPolicy())).toBe(100);
    expect(precedenceOf(v6('::1'), linux.destinationPolicy())).toBe(40);
    await linux.executeCommand(`sudo truncate -s 0 ${GAI_CONF_PATH}`);
    expect(linux.destinationPolicy()).toEqual(GLIBC_POLICY);
    expect(precedenceOf(v4('10.0.0.1'), linux.destinationPolicy())).toBe(10);
  });

  it('gives the built-in tables again when the file is gone', async () => {
    const linux = machine();
    await linux.executeCommand(`sudo sh -c "echo 'precedence ::ffff:0:0/96 100' >> ${GAI_CONF_PATH}"`);
    await linux.executeCommand(`sudo rm ${GAI_CONF_PATH}`);
    expect(linux.destinationPolicy()).toBe(GLIBC_POLICY);
  });

  it('a Windows machine has the table of RFC 6724 and does not read the file of Linux', () => {
    const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
    windows.powerOn();
    for (const text of ['::1', '2001:db8::1', '2002::1', 'fc00::1', '10.0.0.1']) {
      const address = text.includes(':') ? v6(text) : v4(text);
      expect(labelOf(address, windows.destinationPolicy())).toBe(labelOf(address, RFC6724_POLICY));
      expect(precedenceOf(address, windows.destinationPolicy())).toBe(precedenceOf(address, RFC6724_POLICY));
    }
  });
});
