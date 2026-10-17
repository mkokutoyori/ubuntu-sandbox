/**
 * Un argument de commande PowerShell qui commence par `::` (`::1`, `::/0`, `::ffff:10.0.0.1`) est un MOT, comme `fe80::1` ou
 * `2001:db8::1` l'etaient deja. Le lexeur rendait toujours `::` en `STATIC_MEMBER` (c'est l'operateur de `[Math]::Pi`) et le parseur, qui
 * ouvre un argument sur un mot, un nombre ou `% * /`, n'en ouvrait pas sur lui : l'argument etait perdu EN SILENCE. Le lexeur decide
 * maintenant d'apres le caractere qui PRECEDE le `::` : apres `]`, `)` ou un nom de variable c'est l'operateur, ailleurs (debut
 * d'entree, blanc, virgule) c'est le debut d'un mot.
 *
 * Mesure de depart (50c0a302, un WindowsPC administrateur) :
 *     Write-Output ::1                              ->  (rien)
 *     Write-Output a ::1 b                          ->  a            (la suite est abandonnee)
 *     Write-Output -InputObject ::1                 ->  True         (le parametre est devenu un interrupteur)
 *     Get-NetRoute -DestinationPrefix ::1/128       ->  « ... property 'DestinationPrefix' equal to 'True' »
 *     Get-NetPrefixPolicy ::1/128                   ->  les neuf lignes (le filtre a disparu)
 *     Test-Connection ::1 -Count 1                  ->  « requires -ComputerName or a positional target »
 *     ping ::1                                      ->  l'aide de ping (aucune cible ne lui est parvenue)
 * Aucune de ces adresses n'est atteignable sans guillemets : `Test-Connection '::1'` marche, `Test-Connection ::1` jamais.
 *
 * Autorite : la specification du langage PowerShell livree dans official_docs/microsoft/powershell (part 3, §2.3.3 « Commands »).
 * `generic-token-char` y est « tout caractere Unicode sauf { } ( ) ; , | & $, l'accent grave, les guillemets, les blancs et les fins
 * de ligne » : `:`, `/` et `%` n'en sont pas exclus, donc `::1/128` est un `generic-token`, c'est-a-dire un argument de commande.
 * Un `::` ne devient l'operateur de membre statique qu'apres une expression (`[Math]::Pi`), jamais en tete d'argument : §7.1.2 « Member
 * access » de la meme specification dit « Whitespace is not permitted before the :: operator ».
 *
 * Ce qui reste ecrit comme avant : `[Math]::Pi`, `[Math]::Max(1,2)` et `([Math]::Abs(-3))` (le `::` y suit une expression) ; `'::1'`
 * entre guillemets ; `fe80::1%12` et `2001:db8::1` (deja des mots).
 *
 * Discrimination : 17 des 22 cas tombent contre 50c0a302 (le lexeur remis a son etat, la sonde conservee). Passent des deux cotes les
 * cinq TEMOINS, et pourquoi : « les formes entre guillemets et les mots qui commencent par un chiffre ou une lettre » (ils etaient
 * deja des mots), « [Math]::Pi, [Math]::Max et un appel entre parentheses », « l'operateur suit aussi une parenthese fermante et un
 * nom de variable » et, au niveau des jetons, « un :: apres ], ) ou un nom de variable est l'operateur » et « un deux-points isole
 * reste un mot a lui seul » : ils prouvent que la correction ne mange pas l'operateur de membre statique et que le banc rend ce
 * qu'on lui donne. Mutation de la regle (six mutants a la main : inverser la condition, retirer ], retirer ), retirer les noms de
 * variable, retirer la garde de debut d'entree, retirer le test du second deux-points) : les six tombent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { PSLexer } from '@/powershell/lexer/PSLexer';
import { PSTokenType } from '@/powershell/lexer/PSToken';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function lab() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.powerOn();
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  const ps = async (line: string) => (await sub.processLine(line)).output.join('\n');
  return { ps };
}

describe('an argument that starts with :: is a word', () => {
  it.each([
    ['::'],
    ['::1'],
    ['::/0'],
    ['::1/128'],
    ['::ffff:10.0.0.1'],
    ['::ffff:0:0/96'],
    ['::1%12'],
  ])('Write-Output %s prints it back', async (word) => {
    const { ps } = lab();
    expect(await ps(`Write-Output ${word}`)).toBe(word);
  });

  it('in the middle of a command line the words around it are kept', async () => {
    const { ps } = lab();
    expect(await ps('Write-Output a ::1 b')).toBe('a\n::1\nb');
  });

  it('in a comma list each element is a word', async () => {
    const { ps } = lab();
    expect(await ps('Write-Output ::1,::2')).toBe('::1\n::2');
    expect(await ps('(Write-Output ::1,::2 | Measure-Object).Count')).toBe('2');
  });

  it('after a parameter it is the value of the parameter and the parameter is not a switch', async () => {
    const { ps } = lab();
    expect(await ps('Write-Output -InputObject ::1')).toBe('::1');
  });

  it('feeds a pipeline', async () => {
    const { ps } = lab();
    expect(await ps('Write-Output ::1 | ForEach-Object { $_.Length }')).toBe('3');
  });

  it('TEMOIN : the quoted forms and the words that start with a digit or a letter were already words', async () => {
    const { ps } = lab();
    expect(await ps("Write-Output '::1'")).toBe('::1');
    expect(await ps('Write-Output 2001:db8::1')).toBe('2001:db8::1');
    expect(await ps('Write-Output fe80::1%12')).toBe('fe80::1%12');
  });
});

describe('the cmdlets that take an address or a prefix get it', () => {
  it('Get-NetPrefixPolicy filters on a prefix without quotes, by name and in first position', async () => {
    const { ps } = lab();
    const one = (out: string) => out.split('\n').filter(line => /^::1\/128 /.test(line.trim()));
    expect(one(await ps('Get-NetPrefixPolicy -Prefix ::1/128'))).toHaveLength(1);
    expect(await ps('Get-NetPrefixPolicy ::1/128 | Measure-Object | ForEach-Object { $_.Count }')).toBe('1');
    expect(await ps('(Get-NetPrefixPolicy -Prefix ::ffff:0:0/96).Precedence')).toBe('35');
  });

  it('Get-NetRoute finds the route of the loopback by its prefix, and names the prefix when there is none', async () => {
    const { ps } = lab();
    expect(await ps('(Get-NetRoute -DestinationPrefix ::1/128).InterfaceAlias')).toBe('Loopback Pseudo-Interface 1');
    expect(await ps('Get-NetRoute -DestinationPrefix 2001:db8:ffff::/48')).toContain("equal to '2001:db8:ffff::/48'");
    expect(await ps('Get-NetRoute -DestinationPrefix ::/0')).toContain("equal to '::/0'");
  });

  it('Get-NetIPAddress finds the loopback address', async () => {
    const { ps } = lab();
    expect(await ps('(Get-NetIPAddress -IPAddress ::1).InterfaceAlias')).toBe('Loopback Pseudo-Interface 1');
  });

  it('Test-Connection and ping receive the target', async () => {
    const { ps } = lab();
    expect(await ps('Test-Connection ::1 -Count 1')).not.toContain('requires -ComputerName');
    expect(await ps('ping ::1')).not.toContain('Usage: ping');
  });
});

describe('the :: of a static member is still an operator', () => {
  it('TEMOIN : [Math]::Pi, [Math]::Max and a parenthesised call', async () => {
    const { ps } = lab();
    expect(await ps('[Math]::Pi')).toBe('3.14159265358979');
    expect(await ps('$x = [Math]::Max(1,2); $x')).toBe('2');
    expect(await ps('Write-Output ([Math]::Abs(-3))')).toBe('3');
  });

  it('TEMOIN : the operator also follows a closing parenthesis and a variable', async () => {
    const { ps } = lab();
    expect(await ps('([Math])::Pi')).toBe('3.14159265358979');
    const viaVariable = await ps('$t = [int]; $t::MaxValue');
    expect(viaVariable).not.toContain('::MaxValue');
    expect(viaVariable).not.toMatch(/not recognized|error/i);
  });
});

describe('the lexer tells the operator from the first characters of a word by what precedes the ::', () => {
  const kinds = (source: string): Array<[PSTokenType, string]> =>
    new PSLexer().tokenize(source).filter(token => token.type !== PSTokenType.EOF).map(token => [token.type, token.value]);

  it('a :: after whitespace starts a word that runs to the end of the address', () => {
    expect(kinds('Write-Output ::1/128')).toEqual([[PSTokenType.WORD, 'Write-Output'], [PSTokenType.WORD, '::1/128']]);
    expect(kinds('Write-Output ::1,::2')).toEqual([
      [PSTokenType.WORD, 'Write-Output'], [PSTokenType.WORD, '::1'], [PSTokenType.COMMA, ','], [PSTokenType.WORD, '::2'],
    ]);
  });

  it('a :: at the very start of the input starts a word', () => {
    expect(kinds('::1')).toEqual([[PSTokenType.WORD, '::1']]);
  });

  it('TEMOIN : a :: that follows ], ) or the name of a variable is the static member operator', () => {
    expect(kinds('[Math]::Pi').map(([type]) => type)).toContain(PSTokenType.STATIC_MEMBER);
    expect(kinds('([Math])::Pi').map(([type]) => type)).toContain(PSTokenType.STATIC_MEMBER);
    expect(kinds('$t::MaxValue').map(([type]) => type)).toContain(PSTokenType.STATIC_MEMBER);
  });

  it('TEMOIN : a single colon keeps being a word of its own', () => {
    expect(kinds('x :y')).toEqual([[PSTokenType.WORD, 'x'], [PSTokenType.WORD, ':'], [PSTokenType.WORD, 'y']]);
  });
});
