/*
 * Un programme natif se resout et s'execute comme un programme, sous cmd
 * comme sous PowerShell.
 *
 * Mesure de depart :
 *  - cmd : `ping.exe`, `ipconfig.exe`, `where.exe` et le chemin complet
 *    `C:\Windows\System32\hostname.exe` n'etaient pas reconnus (« 'x.exe' is
 *    not recognized ») ; `where robocopy` ne trouvait rien (aucun fichier
 *    robocopy.exe dans System32) ;
 *  - PowerShell : `ipconfig.exe`, `hostname.exe`, `where.exe`, `cmd.exe /c`,
 *    `powershell.exe`, `& "C:\Windows\System32\ping.exe"` n'etaient pas
 *    reconnus ; `ssh.exe -V` perdait la casse de `-V` ;
 *  - toute ligne PowerShell dont le premier mot etait `ping` ou `tracert`, ou
 *    dont une commande native etait asynchrone, partait ENTIERE vers cmd :
 *    `ping -n 1 x | Select-String Reply` rendait « 'select-string' is not
 *    recognized », `ping x; "apres"` ecrivait « Invalid parameter: apres »,
 *    `netstat -an | Select-Object -First 3` n'existait pas ;
 *  - la sortie d'un programme natif etait UNE chaine, pas un tableau de
 *    lignes (`(ipconfig).Count` vide) ; `$LASTEXITCODE` valait toujours 0 et
 *    `$?` ne bougeait pas ;
 *  - `attrib +h fichier` evaluait `+h` comme une addition (NaN) ;
 *  - `foreach`, `for`, `while`, `do` ne rendaient RIEN de ce que leur corps
 *    produisait (`foreach ($i in 1..3) { "x$i" }` n'affichait rien), `if` ne
 *    rendait que la derniere valeur de son bloc, `$x = foreach (...) { }` ne
 *    s'analysait pas ;
 *  - `Select-String` numerotait les correspondances au lieu des lignes,
 *    ignorait -Path, affichait un tableau « Line Pattern LineNumber » au lieu
 *    de la ligne trouvee, et -Quiet, -List, -AllMatches, -Context n'avaient
 *    aucun effet.
 *
 * L'AUTORITE : le comportement documente de Windows et de PowerShell 5.1,
 * LU DE MEMOIRE (aucune transcription atteignable d'ici). `-Quiet` rend
 * `True` a la premiere correspondance et `False` sinon ; une correspondance
 * sans contexte s'affiche comme la ligne seule, avec contexte la ligne
 * trouvee est precedee de `> ` ; un chemin cree la ligne
 * `chemin:numero:ligne` ; `$LASTEXITCODE` reprend le code de sortie du
 * dernier programme natif et `$?` en depend.
 *
 * Ecrite a l'aveugle. 28 des 32 cas tombent avant (git stash push -- src/network
 * src/powershell src/terminal src/cmd). Les 4 qui passent des deux cotes sont
 * des TEMOINS : un programme inexistant reste refuse, `cmd.exe /c "..."` et
 * `powershell.exe -Command "..."` marchaient deja parce que la ligne TAPEE
 * partait entiere vers cmd (c'est ce qui interdisait tout enchainement),
 * `attrib +h` marchait pour la meme raison, et `2 + 3` / `$a +2` gardent le
 * sens d'une addition — le temoin de l'analyse de `+h`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function machine(): { pc: WindowsPC; ps: (line: string) => Promise<string> } {
  const pc = new WindowsPC('windows-pc', 'WIN-NAT');
  pc.powerOn();
  pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
  const sub = PowerShellSubShell.create(pc).subShell;
  return { pc, ps: async line => (await sub.processLine(line)).output.join('\n') };
}

describe('cmd resolves a program by name.exe and by path', () => {
  it('runs ping.exe whatever the case', async () => {
    const { pc } = machine();

    expect(await pc.executeCmdCommand('ping.exe -n 1 127.0.0.1')).toContain('Reply from 127.0.0.1');
    expect(await pc.executeCmdCommand('PING.EXE -n 1 127.0.0.1')).toContain('Reply from 127.0.0.1');
  });

  it('runs a program by its full path, quoted or not, with or without the extension', async () => {
    const { pc } = machine();

    expect(await pc.executeCmdCommand('C:\\Windows\\System32\\hostname.exe')).toBe('WIN-NAT');
    expect(await pc.executeCmdCommand('"C:\\Windows\\System32\\hostname.exe"')).toBe('WIN-NAT');
    expect(await pc.executeCmdCommand('C:\\Windows\\System32\\hostname')).toBe('WIN-NAT');
  });

  it('finds where.exe, robocopy and the OpenSSH client on the path', async () => {
    const { pc } = machine();

    expect(await pc.executeCmdCommand('where.exe cmd')).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(await pc.executeCmdCommand('where robocopy')).toBe('C:\\Windows\\System32\\robocopy.exe');
    expect(await pc.executeCmdCommand('where ssh')).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(await pc.executeCmdCommand('ssh.exe -V')).toContain('OpenSSH_for_Windows');
  });

  it('pipes the output of a .exe program', async () => {
    const { pc } = machine();

    expect(await pc.executeCmdCommand('ipconfig.exe | find "Windows"')).toBe('Windows IP Configuration');
  });

  it('still refuses a program that does not exist', async () => {
    const { pc } = machine();

    expect(await pc.executeCmdCommand('zorglub.exe')).toContain('is not recognized as an internal or external command');
    expect(await pc.executeCmdCommand('C:\\Windows\\System32\\zorglub.exe')).toContain('cannot find the path');
  });
});

describe('PowerShell resolves a native program like a program', () => {
  it('runs name.exe and the full path', async () => {
    const { ps } = machine();

    expect(await ps('hostname.exe')).toBe('WIN-NAT');
    expect(await ps('& "C:\\Windows\\System32\\hostname.exe"')).toBe('WIN-NAT');
    expect(await ps('C:\\Windows\\System32\\hostname.exe')).toBe('WIN-NAT');
    expect(await ps('ipconfig.exe | Select-Object -First 1')).toBe('Windows IP Configuration');
  });

  it('does not take where.exe for the Where-Object alias', async () => {
    const { ps } = machine();

    expect(await ps('where.exe ping')).toBe('C:\\Windows\\System32\\ping.exe');
  });

  it('runs cmd.exe /c and powershell.exe with their arguments verbatim', async () => {
    const { ps } = machine();

    expect(await ps('cmd.exe /c "echo a & echo b"')).toBe('a\nb');
    expect(await ps('powershell.exe -NoProfile -Command "Write-Output 3"')).toBe('3');
  });

  it('keeps the case of a native argument', async () => {
    const { ps } = machine();

    expect(await ps('ssh.exe -V')).toBe(await ps('ssh -V'));
    expect(await ps('ssh -V')).toContain('OpenSSH_for_Windows');
  });

  it('reads +h as an argument, not an addition', async () => {
    const { pc, ps } = machine();
    await ps('Set-Content C:\\masque.txt "x"');

    await ps('attrib +h C:\\masque.txt');
    await ps('attrib +r +s C:\\masque.txt');

    const flags = await pc.executeCmdCommand('attrib C:\\masque.txt');
    expect(flags).toMatch(/^A\s+SHR\s+C:\\masque\.txt$/);
  });

  it('keeps 2 + 3 and $a +2 as arithmetic', async () => {
    const { ps } = machine();

    expect(await ps('2 + 3')).toBe('5');
    expect(await ps('$a = 1; $a +2')).toBe('3');
  });
});

describe('the output of a native program is lines', () => {
  it('counts the lines of ipconfig and of a captured ping', async () => {
    const { ps } = machine();

    expect(await ps('(ipconfig).Count -gt 5')).toBe('True');
    expect(await ps('$x = ping -n 1 127.0.0.1; $x.Count -gt 5')).toBe('True');
    expect(await ps('$x = ping -n 1 127.0.0.1; $x[1]')).toBe('Pinging 127.0.0.1 with 32 bytes of data:');
  });

  it('shows only the matching line for Select-String over native output', async () => {
    const { ps } = machine();

    expect(await ps('ipconfig | Select-String "IPv4"')).toBe('   IPv4 Address. . . . . . . . . . . : 10.0.0.5');
    expect(await ps('ping -n 1 127.0.0.1 | Select-String TTL')).toBe('Reply from 127.0.0.1: bytes=32 time=<1ms TTL=128');
  });

  it('hands piped text to a native program', async () => {
    const { ps } = machine();

    expect(await ps('"alpha","beta","gamma" | findstr a')).toBe('alpha\nbeta\ngamma');
    expect(await ps('"alpha","beta","gamma" | findstr /c:"beta"')).toBe('beta');
    expect(await ps('"b","c","a" | cmd /c sort')).toBe('a\nb\nc');
  });
});

describe('an asynchronous native program sits anywhere in a line', () => {
  it('pipes ping into Select-String and Select-Object', async () => {
    const { ps } = machine();

    expect(await ps('ping -n 1 127.0.0.1 | Select-String Reply')).toBe('Reply from 127.0.0.1: bytes=32 time=<1ms TTL=128');
    expect(await ps('netstat -an | Select-Object -First 3')).toBe('\nActive Connections\n');
    expect((await ps('tasklist | Select-Object -First 4')).split('\n').length).toBe(4);
  });

  it('runs the statements that follow it, in order', async () => {
    const { ps } = machine();

    const out = (await ps('ping -n 1 127.0.0.1; "after"')).split('\n');
    expect(out[out.length - 1]).toBe('after');
    expect(await ps('hostname; ping -n 1 127.0.0.1 | Select-String TTL; hostname'))
      .toBe('WIN-NAT\nReply from 127.0.0.1: bytes=32 time=<1ms TTL=128\nWIN-NAT');
  });

  it('runs it once per iteration of a loop', async () => {
    const { ps } = machine();

    expect(await ps('foreach ($h in "127.0.0.1","10.0.0.5") { ping -n 1 $h | Select-String "Reply from" }'))
      .toBe('Reply from 127.0.0.1: bytes=32 time=<1ms TTL=128\nReply from 10.0.0.5: bytes=32 time=<1ms TTL=128');
    expect(await ps('1..2 | ForEach-Object { ping -n 1 127.0.0.1 | Select-String Packets }'))
      .toBe('    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),');
  });

  it('assigns its output to a variable', async () => {
    const { ps } = machine();

    expect(await ps('$r = ping -n 1 127.0.0.1; $r.Count -gt 5')).toBe('True');
  });
});

describe('$LASTEXITCODE and $? follow the native program', () => {
  it('reports the exit code of cmd /c', async () => {
    const { ps } = machine();

    await ps('cmd /c exit 3');
    expect(await ps('$LASTEXITCODE')).toBe('3');
    expect(await ps('$?')).toBe('False');
    await ps('cmd /c exit 0');
    expect(await ps('$LASTEXITCODE')).toBe('0');
    expect(await ps('$?')).toBe('True');
  });

  it('reports ping success and failure', async () => {
    const { ps } = machine();

    expect(await ps('ping -n 1 127.0.0.1 | Out-Null; $LASTEXITCODE')).toBe('0');
    expect(await ps('ping -n 1 192.0.2.77 | Out-Null; $LASTEXITCODE')).toBe('1');
  });

  it('reports a synchronous program too', async () => {
    const { ps } = machine();

    expect(await ps('ipconfig | Out-Null; $LASTEXITCODE')).toBe('0');
    expect(await ps('net user zorglub | Out-Null; $LASTEXITCODE')).toBe('2');
  });
});

describe('a loop or a block emits what its body produces', () => {
  it('emits the values of foreach, for, while and do', async () => {
    const { ps } = machine();

    expect(await ps('foreach ($i in 1..3) { "item $i" }')).toBe('item 1\nitem 2\nitem 3');
    expect(await ps('for ($i = 0; $i -lt 2; $i++) { "i$i" }')).toBe('i0\ni1');
    expect(await ps('$i = 0; while ($i -lt 2) { "w$i"; $i++ }')).toBe('w0\nw1');
    expect(await ps('$i = 0; do { "d$i"; $i++ } while ($i -lt 2)')).toBe('d0\nd1');
    expect(await ps('$i = 0; do { "u$i"; $i++ } until ($i -ge 2)')).toBe('u0\nu1');
  });

  it('emits every value of an if block', async () => {
    const { ps } = machine();

    expect(await ps('if ($true) { "a"; "b" }')).toBe('a\nb');
    expect(await ps('if ($false) { "a" } elseif ($true) { "x"; "y" } else { "z" }')).toBe('x\ny');
  });

  it('assigns the output of a loop', async () => {
    const { ps } = machine();

    expect(await ps('$x = foreach ($i in 1..3) { $i * 2 }; $x.Count')).toBe('3');
    expect(await ps('$x = foreach ($i in 1..3) { $i * 2 }; $x -join ","')).toBe('2,4,6');
    expect(await ps('$y = if ($true) { "yes" } else { "no" }; $y')).toBe('yes');
  });

  it('keeps break and continue, and what was emitted before them', async () => {
    const { ps } = machine();

    expect(await ps('foreach ($i in 1..5) { if ($i -eq 4) { break }; if ($i -eq 2) { continue }; "n$i" }')).toBe('n1\nn3');
  });

  it('keeps what a loop emitted when a function returns from inside it', async () => {
    const { ps } = machine();

    expect(await ps('function f { foreach ($i in 1..3) { "r$i"; if ($i -eq 2) { return } } }; f')).toBe('r1\nr2');
  });
});

describe('Select-String numbers lines, reads files and shows the match', () => {
  async function logged(): Promise<(line: string) => Promise<string>> {
    const { ps } = machine();
    await ps('Set-Content C:\\journal.txt "alpha"');
    await ps('Add-Content C:\\journal.txt "beta error"');
    await ps('Add-Content C:\\journal.txt "gamma"');
    return ps;
  }

  it('numbers the line, not the match, and reads -Path and a positional path', async () => {
    const ps = await logged();

    expect(await ps('(Select-String -Path C:\\journal.txt -Pattern error).LineNumber')).toBe('2');
    expect(await ps('Select-String -Path C:\\journal.txt -Pattern error')).toBe('C:\\journal.txt:2:beta error');
    expect(await ps('sls error C:\\journal.txt')).toBe('C:\\journal.txt:2:beta error');
    expect(await ps('(sls gamma C:\\journal.txt).Filename')).toBe('journal.txt');
  });

  it('expands a wildcard path and takes files from the pipeline', async () => {
    const ps = await logged();

    expect(await ps('sls beta C:\\jour*.txt')).toBe('C:\\journal.txt:2:beta error');
    expect(await ps('Get-ChildItem C:\\*.txt | Select-String beta')).toBe('C:\\journal.txt:2:beta error');
  });

  it('numbers piped strings by their rank and shows them as the bare line', async () => {
    const { ps } = machine();

    expect(await ps('"a","b","ab" | sls a')).toBe('a\nab');
    expect(await ps('("a","b","ab" | sls b)[1].LineNumber')).toBe('3');
  });

  it('answers -Quiet with True or False', async () => {
    const { ps } = machine();

    expect(await ps('"a","b" | sls a -Quiet')).toBe('True');
    expect(await ps('"a","b" | sls z -Quiet')).toBe('False');
  });

  it('shows -Context around the match, and returns Matches', async () => {
    const ps = await logged();

    expect(await ps('Select-String -Path C:\\journal.txt -Pattern beta -Context 1,1'))
      .toBe('  C:\\journal.txt:1:alpha\n> C:\\journal.txt:2:beta error\n  C:\\journal.txt:3:gamma');
    expect(await ps('(sls "b(e)" C:\\journal.txt).Matches[0].Value')).toBe('be');
    expect(await ps('(sls "e" C:\\journal.txt -AllMatches).Matches.Count')).toBe('2');
    expect(await ps('(sls "a" C:\\journal.txt -List).Count')).toBe('1');
  });

  it('refuses a missing file', async () => {
    const { ps } = machine();

    expect(await ps('sls beta C:\\nope.txt')).toContain("Could not find file 'C:\\nope.txt'");
  });
});
