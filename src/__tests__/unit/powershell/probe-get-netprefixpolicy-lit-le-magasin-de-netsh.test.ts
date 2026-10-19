/**
 * `Get-NetPrefixPolicy` et `netsh interface ipv6 show prefixpolicies` sont DEUX vues d'UN magasin : `PrefixPolicyStore`, celui que
 * `WindowsPC.destinationPolicy()` donne a l'ordre des destinations. La cmdlet rend la table ACTIVE, celle que la pile utilise.
 *
 * Mesure de depart (ed7e539e, un WindowsPC administrateur) : `netsh interface ipv6 show prefixpolicies` rend la table de neuf lignes,
 * mais `Get-NetPrefixPolicy` n'existe pas (« is not recognized as the name of a cmdlet ») : une machine a un magasin et une seule de
 * ses deux interfaces le lit.
 *
 * Autorites : la page Microsoft Learn `Get-NetPrefixPolicy` (module NetTCPIP, windowsserver2022-ps) pour la syntaxe
 * `[[-Prefix] <String[]>] [-Precedence <UInt32[]>] [-Label <UInt32[]>] [-CimSession] [-ThrottleLimit] [-AsJob]`, ses deux exemples
 * (`Get-NetPrefixPolicy` et `-Precedence 1`) et sa sortie, une instance CIM `root\StandardCimv2\MSFT_NetPrefixPolicy` ; la page de
 * la classe `MSFT_NetPrefixPolicy` (hh872442) pour ses proprietes : `Prefix` (chaine, cle), `Precedence` et `Label` (uint32),
 * `Store` (uint8, cle : 0 `Persistent`, 1 `Active`). L'index du module ne liste QUE `Get-NetPrefixPolicy` pour les politiques de
 * prefixes : il n'existe ni `New-`, ni `Set-`, ni `Remove-NetPrefixPolicy`, l'ecriture passe par `netsh` (sonde voisine). Les
 * messages d'absence (`No MSFT_NetPrefixPolicy objects found with property ...`) et le refus de `-CimSession` sont ceux des autres
 * cmdlets CIM de ce depot (`cimQuery.ts`, `cimCommon.ts`).
 *
 * NON ATTESTE, dit comme tel : l'affichage par defaut d'une capture de Windows (ordre et format des colonnes ; ici les proprietes
 * de la classe dans l'ordre du MOF, rendues par le formateur generique) ; le choix de la table enumeree (ici la table ACTIVE, la
 * seule que la pile utilise ; aucune source n'enonce si l'enumeration rend aussi la persistante) ; `Store` rendu par le nom de la
 * valeur (`Active`) et non par son numero. `-ThrottleLimit` et `-AsJob` ne sont pas declares : la cmdlet ne les evalue pas, l'aide ne
 * les annonce donc pas.
 *
 * Discrimination : 15 des 16 cas tombent contre ed7e539e (les sources de la cmdlet remises a leur etat, la sonde conservee), car la
 * cmdlet y est absente. Passe des deux cotes le TEMOIN (`netsh show prefixpolicies`, la vue qui existait deja et qui prouve que le
 * banc est sain). Les cas de coherence dont la moitie netsh est deja vraie ne sont pas des temoins : ils echouent sur la moitie
 * PowerShell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { IPAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { precedenceOf } from '@/network/layers/internet/DestinationSelection';

beforeEach(() => {
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const FACTORY = [
  '::1/128 50 0 Active',
  '::/0 40 1 Active',
  '::ffff:0:0/96 35 4 Active',
  '2002::/16 30 2 Active',
  '2001::/32 5 5 Active',
  'fc00::/7 3 13 Active',
  'fec0::/10 1 11 Active',
  '3ffe::/16 1 12 Active',
  '::/96 1 3 Active',
];

function lab() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.powerOn();
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  const ps = async (line: string) => (await sub.processLine(line)).output.join('\n');
  const cmd = (line: string) => win.executeCommand(line);
  const rows = async (arguments_ = ''): Promise<string[]> => {
    const out = await ps(`Get-NetPrefixPolicy ${arguments_} | ForEach-Object { '{0} {1} {2} {3}' -f $_.Prefix, $_.Precedence, $_.Label, $_.Store }`);
    return out === '' ? [] : out.split('\n');
  };
  return { win, ps, cmd, rows };
}

describe('Get-NetPrefixPolicy reads the table netsh shows', () => {
  it('TEMOIN : netsh show prefixpolicies lists the factory table, the lab is sound', async () => {
    const { cmd } = lab();
    const shown = await cmd('netsh interface ipv6 show prefixpolicies');
    expect(shown).toContain('Querying active state...');
    expect(shown.split('\n').filter(line => /\/\d+$/.test(line.trim()))).toHaveLength(9);
  });

  it('returns the nine rows of the factory table with the properties of MSFT_NetPrefixPolicy, by decreasing precedence', async () => {
    const { rows } = lab();
    expect(await rows()).toEqual(FACTORY);
  });

  it('the rows are objects: Prefix is text, Precedence and Label are numbers, Store is the name of the table', async () => {
    const { ps } = lab();
    expect(await ps("Get-NetPrefixPolicy -Prefix '::1/128' | ForEach-Object { ($_.Prefix -is [string]) -and ($_.Precedence -is [int]) -and ($_.Label -is [int]) -and ($_.Store -eq 'Active') }"))
      .toBe('True');
    expect(await ps("(Get-NetPrefixPolicy | Measure-Object).Count")).toBe('9');
  });

  it('prints as a formatted table with the four properties of the class', async () => {
    const { ps } = lab();
    const out = await ps('Get-NetPrefixPolicy');
    const header = out.split('\n').find(line => line.includes('Precedence'));
    expect(header).toBeDefined();
    for (const column of ['Prefix', 'Precedence', 'Label', 'Store']) expect(header).toContain(column);
    expect(out).toContain('::ffff:0:0/96');
  });
});

describe('the filters of the documented syntax', () => {
  it('-Precedence 1 gets the three rows that have a precedence of 1, the second example of the documentation', async () => {
    const { rows } = lab();
    expect(await rows('-Precedence 1')).toEqual(['fec0::/10 1 11 Active', '3ffe::/16 1 12 Active', '::/96 1 3 Active']);
  });

  it('-Label takes an array', async () => {
    const { rows } = lab();
    expect(await rows('-Label 4,2')).toEqual(['::ffff:0:0/96 35 4 Active', '2002::/16 30 2 Active']);
  });

  it('-Prefix names a row, by name and in first position', async () => {
    const { rows } = lab();
    expect(await rows("-Prefix '2001::/32'")).toEqual(['2001::/32 5 5 Active']);
    expect(await rows("'2001::/32'")).toEqual(['2001::/32 5 5 Active']);
    expect(await rows("-Prefix '::1/128','2002::/16'")).toEqual(['::1/128 50 0 Active', '2002::/16 30 2 Active']);
  });

  it('-Prefix compares the prefix, not its spelling', async () => {
    const { rows } = lab();
    expect(await rows("-Prefix '0:0:0:0:0:FFFF:0:0/96'")).toEqual(['::ffff:0:0/96 35 4 Active']);
  });

  it('two filters both apply', async () => {
    const { rows } = lab();
    expect(await rows('-Precedence 1 -Label 3')).toEqual(['::/96 1 3 Active']);
    expect((await rows('-Precedence 50 -Label 3')).join('\n')).toContain('No MSFT_NetPrefixPolicy objects found');
  });

  it('a filter that selects nothing is an error that names the property, as every CIM cmdlet says it', async () => {
    const { ps } = lab();
    expect(await ps("Get-NetPrefixPolicy -Prefix '2001:db8::/32'"))
      .toContain("Get-NetPrefixPolicy : No MSFT_NetPrefixPolicy objects found with property 'Prefix' equal to '2001:db8::/32'.  Verify the value of the property and retry.");
    expect(await ps('Get-NetPrefixPolicy -Precedence 1,2 -Label 99'))
      .toContain("No MSFT_NetPrefixPolicy objects found with property 'Label' equal to '99'.");
  });

  it('-CimSession is refused in the words of the other CIM cmdlets: no remote machine exists', async () => {
    const { ps } = lab();
    expect(await ps('Get-NetPrefixPolicy -CimSession other')).toContain("A CimSession to 'other' cannot be opened");
  });
});

describe('netsh writes, the cmdlet and the stack read the same table', () => {
  it('set prefixpolicy changes the row the cmdlet returns and the precedence the ordering uses, one fact in three views', async () => {
    const { win, cmd, rows } = lab();
    expect(await cmd('netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 46 4')).toBe('Ok.');
    expect(await rows("-Prefix '::ffff:0:0/96'")).toEqual(['::ffff:0:0/96 46 4 Active']);
    expect(precedenceOf(new IPAddress('10.0.0.1'), win.destinationPolicy())).toBe(46);
    expect(await cmd('netsh interface ipv6 show prefixpolicies')).toContain('        46      4  ::ffff:0:0/96');
  });

  it('add and delete prefixpolicy add and remove the row', async () => {
    const { cmd, rows } = lab();
    await cmd('netsh interface ipv6 add prefixpolicy 2001:db8::/32 40 2');
    expect(await rows("-Prefix '2001:db8::/32'")).toEqual(['2001:db8::/32 40 2 Active']);
    expect((await rows()).slice(0, 3)).toEqual(['::1/128 50 0 Active', '::/0 40 1 Active', '2001:db8::/32 40 2 Active']);
    await cmd('netsh interface ipv6 delete prefixpolicy 2001:db8::/32');
    expect(await rows()).toEqual(FACTORY);
  });

  it('the cmdlet shows the ACTIVE table: a row deleted from the active store alone is gone until the next boot', async () => {
    const { win, cmd, rows } = lab();
    await cmd('netsh interface ipv6 delete prefixpolicy 3ffe::/16 store=active');
    expect(await rows()).toEqual(FACTORY.filter(row => !row.startsWith('3ffe::/16')));
    expect(await cmd('netsh interface ipv6 show prefixpolicies store=persistent')).toContain('3ffe::/16');
    win.powerOff();
    win.powerOn();
    expect(await rows()).toEqual(FACTORY);
  });
});

describe('help and discovery', () => {
  it('Get-Command finds the cmdlet', async () => {
    const { ps } = lab();
    expect(await ps('Get-Command Get-NetPrefixPolicy')).toMatch(/Cmdlet\s+Get-NetPrefixPolicy/);
  });

  it('Get-Help gives the documented syntax and announces only the parameters the cmdlet evaluates', async () => {
    const { ps } = lab();
    const help = await ps('Get-Help Get-NetPrefixPolicy');
    expect(help).toContain('Get-NetPrefixPolicy [[-Prefix] <String[]>] [-Precedence <UInt32[]>] [-Label <UInt32[]>]');
    expect(help).not.toContain('-ThrottleLimit');
    expect(help).not.toContain('-AsJob');
  });
});
