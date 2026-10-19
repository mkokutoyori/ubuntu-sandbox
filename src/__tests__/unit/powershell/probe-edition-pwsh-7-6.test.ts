/**
 * Probe — edition PowerShell 7.6 (core) contre Windows PowerShell 5.1 (desktop), mesuree sur le
 * code de PowerShell : Parser.cs/ParserStrings.resx (pipeline chains, ternaire, ??, ?., messages),
 * PSVersionInfo.cs ($PSVersionTable), Join-String.cs, PowerShellCore_format_ps1xml.cs (ConciseView).
 * Discrimination : sur la base b39208474, 31 cas rouges sur 39.
 * Temoins (8, verts avant et apres) : core `$v ?? 'dflt'` (valeur non nulle), core `${a}?[0]` (nul), core `&&` (les deux
 * cotes s'executent deja), core ConvertFrom-Json -AsHashtable (ignore), desktop PSEdition, desktop $IsWindows,
 * desktop 1/0, desktop 0b101.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';

const CORE: Array<[string, string]> = [
  ["$true ? 'y' : 'n'", "y"],
  ["$x = 5; $x -gt 3 ? 'big' : 'small'", "big"],
  ["$null ?? 'dflt'", "dflt"],
  ["$v = 'set'; $v ?? 'dflt'", "set"],
  ["$x = $null; $x ??= 5; $x", "5"],
  ["$o = @{Name='n'}; ${o}?.Name", "n"],
  ["$a = $null; ${a}?[0]", ""],
  ["$a = 1..5; ${a}?[2]", "3"],
  ["Write-Output a && Write-Output b", "a\nb"],
  ["Write-Output a || Write-Output b", "a"],
  ["$PSVersionTable.PSVersion.ToString()", "7.6.0"],
  ["$PSVersionTable.PSEdition", "Core"],
  ["$IsWindows", "True"],
  ["1..3 | ForEach-Object -Parallel { $_ * 2 }", "2\n4\n6"],
  ["1,2,3 | Join-String -Separator '-'", "1-2-3"],
  ["'a'..'e' -join ''", "abcde"],
  ["0b101 + 1", "6"],
  ["(5uy).GetType().Name", "Byte"],
  ["Get-Item C:\\nope", "Get-Item: Cannot find path 'C:\\nope' because it does not exist."],
  ["1/0", "RuntimeException: Attempted to divide by zero."],
  ["throw 'boom'", "Exception: boom"],
  ["[int]'x'", "InvalidArgument: Cannot convert value \"x\" to type \"System.Int32\". Error: \"The input string 'x' was not in a correct format.\""],
  ["Get-Nope", "Get-Nope: The term 'Get-Nope' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again."],
  ["function f { param([ValidateSet('a','b')]$p) $p }; f -p c", "f: Cannot validate argument on parameter 'p'. The argument \"c\" does not belong to the set \"a,b\" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again."],
  ["'{\"a\":1}' | ConvertFrom-Json -AsHashtable | ForEach-Object { $_.GetType().Name }", "Hashtable"],
  ["$null ?? 'x' ? 'y' : 'z'", "y"],
];

const DESKTOP: Array<[string, string]> = [
  ["$null ?? 'x'", "At line:1 char:7\n+ $null ?? 'x'\n+       ~~\nUnexpected token '??' in expression or statement.\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n    + FullyQualifiedErrorId : UnexpectedToken"],
  ["Write-Output a && Write-Output b", "At line:1 char:16\n+ Write-Output a && Write-Output b\n+                ~~\nThe token '&&' is not a valid statement separator in this version.\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n    + FullyQualifiedErrorId : InvalidEndOfLine"],
  ["$true ? 'y' : 'n'", "At line:1 char:7\n+ $true ? 'y' : 'n'\n+       ~\nUnexpected token '?' in expression or statement.\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n    + FullyQualifiedErrorId : UnexpectedToken"],
  ["1,2,3 | Join-String", "The term 'Join-String' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again."],
  ["1..3 | ForEach-Object -Parallel { $_ }", "A parameter cannot be found that matches parameter name 'Parallel'."],
  ["$PSVersionTable.PSEdition", "Desktop"],
  ["$IsWindows", ""],
  ["'a'..'e'", "Cannot convert value \"a\" to type \"System.Int32\". Error: \"Input string was not in a correct format.\""],
  ["0b101", "The term '0b101' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again."],
  ["1/0", "Attempted to divide by zero."],
  ["'{\"a\":1}' | ConvertFrom-Json -AsHashtable", "A parameter cannot be found that matches parameter name 'AsHashtable'."],
];

function shellFor(language: 'desktop' | 'core'): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc, { language }).subShell;
}

describe('PowerShell 7.6 (core)', () => {
  const sub = shellFor('core');
  for (const [code, expected] of CORE) {
    it(code, async () => {
      expect((await sub.processLine(code)).output.join('\n')).toBe(expected);
    });
  }
});

describe('Windows PowerShell 5.1 (desktop) refuses PowerShell 7 syntax', () => {
  const sub = shellFor('desktop');
  for (const [code, expected] of DESKTOP) {
    it(code, async () => {
      expect((await sub.processLine(code)).output.join('\n')).toBe(expected);
    });
  }
});

describe('pwsh and powershell launchers', () => {
  let manager: TerminalManager;
  let bus: EventBus;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
  });

  async function typeInto(session: WindowsTerminalSession, text: string, first: boolean): Promise<void> {
    if (first) session.setInput(text); else session.setInputBuf(text);
    session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  it('pwsh opens PowerShell 7.6 and powershell opens Windows PowerShell 5.1', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setEventBus(bus);
    const session = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;
    await typeInto(session, 'pwsh', true);
    await typeInto(session, '$PSVersionTable.PSEdition', false);
    await typeInto(session, 'exit', false);
    await typeInto(session, 'powershell', false);
    await typeInto(session, '$PSVersionTable.PSEdition', false);
    const text = session.lines.map(line => line.text);
    expect(text).toContain('PowerShell 7.6.0');
    expect(text).toContain('Core');
    expect(text).toContain('Windows PowerShell');
    expect(text).toContain('Desktop');
  });

  it('one-shot pwsh -Command reports 7.6.0, powershell -Command reports 5.1.0', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    pc.setEventBus(bus);
    const session = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;
    await typeInto(session, 'pwsh -Command "$PSVersionTable.PSVersion.ToString()"', true);
    await typeInto(session, 'powershell -Command "$PSVersionTable.PSVersion.ToString()"', false);
    const text = session.lines.map(line => line.text);
    expect(text).toContain('7.6.0');
    expect(text).toContain('5.1.0');
  });
});
