/**
 * Probe — PowerShell 7.6, seule version du projet (Windows PowerShell 5.1 est retire), mesuree sur le
 * code de PowerShell : Parser.cs/ParserStrings.resx (pipeline chains, ternaire, ??, ?., messages),
 * PSVersionInfo.cs ($PSVersionTable), Join-String.cs, PowerShell_format_ps1xml (ConciseView).
 * Discrimination : sur le commit qui precede le retrait de la 5.1, `powershell` ouvrait Windows PowerShell 5.1
 * (PSEdition Desktop, 5.1.0, erreurs a trois lignes CategoryInfo) : les 2 cas de lanceurs et les cas qui lisent
 * la version, l'edition, la forme des erreurs (Get-Item, 1/0, throw, [int]'x', Get-Nope, ValidateSet) tombaient
 * sous `powershell` ; les cas de langage (ternaire, ??, ?., &&, ||, 0b, 5uy, -Parallel, Join-String) passaient
 * deja en `pwsh` et sont les TEMOINS que le moteur 7 etait sain avant le retrait.
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


function shellFor(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

describe('PowerShell 7.6 (core)', () => {
  const sub = shellFor();
  for (const [code, expected] of CORE) {
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

  it('pwsh and powershell both open PowerShell 7.6', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setEventBus(bus);
    const session = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;
    await typeInto(session, 'pwsh', true);
    await typeInto(session, '$PSVersionTable.PSEdition', false);
    await typeInto(session, 'exit', false);
    await typeInto(session, 'powershell', false);
    await typeInto(session, '$PSVersionTable.PSEdition', false);
    const text = session.lines.map(line => line.text);
    expect(text.filter(line => line === 'PowerShell 7.6.0')).toHaveLength(2);
    expect(text.filter(line => line === 'Core')).toHaveLength(2);
    expect(text).not.toContain('Windows PowerShell');
    expect(text).not.toContain('Desktop');
  });

  it('one-shot pwsh -Command and powershell -Command both report 7.6.0', async () => {
    const pc = new WindowsPC('windows-pc', 'PC2', 0, 0);
    pc.setEventBus(bus);
    const session = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;
    await typeInto(session, 'pwsh -Command "$PSVersionTable.PSVersion.ToString()"', true);
    await typeInto(session, 'powershell -Command "$PSVersionTable.PSVersion.ToString()"', false);
    const text = session.lines.map(line => line.text);
    expect(text.filter(line => line === '7.6.0')).toHaveLength(2);
    expect(text).not.toContain('5.1.0');
  });
});
