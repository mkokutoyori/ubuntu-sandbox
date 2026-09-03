import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PSLexer } from '@/powershell/lexer/PSLexer';
import { extractCommentHelp } from '@/powershell/cmdlets/core/MiscCmdlets';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function shell(pc: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(pc);
  return async (line: string): Promise<string> => {
    const r = await subShell.processLine(line);
    if (typeof r === 'string') return r;
    const out = (r as { output?: string | string[] }).output;
    return Array.isArray(out) ? out.join('\n') : (out ?? '');
  };
}

describe('a directory that does not exist is not a place one can go', () => {
  it('Set-Location refuses it, in PowerShell own words', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    const before = await run('Get-Location');
    const err = await run('cd C:\\nexistepas');
    expect(err).toContain("Cannot find path 'C:\\nexistepas' because it does not exist.");
    expect(await run('Get-Location')).toBe(before);
  });

  it('Push-Location refuses it too', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    const before = await run('Get-Location');
    expect(await run('pushd C:\\pas-la')).toContain('Cannot find path');
    expect(await run('Get-Location')).toBe(before);
  });

  it('a directory that DOES exist is still reachable', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    await run('New-Item -ItemType Directory -Path C:\\travail');
    expect(await run('cd C:\\travail')).not.toContain('Cannot find path');
    expect(await run('Get-Location')).toContain('C:\\travail');
  });

  it('a PSDrive is not judged by the filesystem provider', async () => {
    // `HKLM:` appartient a un AUTRE fournisseur : demander au systeme de
    // fichiers s'il existe reviendrait a refuser un chemin valide.
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    expect(await run('Set-Location HKLM:')).not.toContain('Cannot find path');
  });

  it('the system directories a Windows machine always has are reachable', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    for (const dir of ['C:\\Windows', 'C:\\Users']) {
      expect(await run(`cd ${dir}`), dir).not.toContain('Cannot find path');
    }
  });

  it('Test-Path and Set-Location agree about the same path', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    for (const p of ['C:\\absent', 'C:\\Users']) {
      const exists = (await run(`Test-Path ${p}`)).includes('True');
      const moved = !(await run(`cd ${p}`)).includes('Cannot find path');
      expect(moved, p).toBe(exists);
    }
  });
});

describe('an IPv4 address with an octet over 255 is not an address', () => {
  it('New-NetIPAddress refuses it', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    const err = await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 999.1.1.1 -PrefixLength 24');
    expect(err).toContain('not a valid IP address');
    expect(await run('Get-NetIPAddress')).not.toContain('999.1.1.1');
  });

  it.each(['256.1.1.1', '1.2.3.999', '300.300.300.300', '192.168.1'])(
    '%s is refused', async (bad) => {
      const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
      expect(await run(
        `New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress ${bad} -PrefixLength 24`))
        .toContain('not a valid IP address');
    });

  it('a real address is still accepted, and shows up', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    expect(await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 192.168.5.10 -PrefixLength 24'))
      .not.toContain('not a valid');
    expect(await run('Get-NetIPAddress')).toContain('192.168.5.10');
  });

  it('an IPv6 address is not judged by the IPv4 rule — elle est POSEE', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    expect(await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress "2001:db8::1" -PrefixLength 64'))
      .not.toContain('not a valid');
    expect(await run('Get-NetIPAddress -AddressFamily IPv6')).toContain('2001:db8::1');
  });

  it('netsh and PowerShell now agree on the same bad address', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    const viaNetsh = await pc.executeCommand(
      'netsh interface ip set address name="Ethernet0" static 300.1.1.1 255.255.255.0');
    const viaPs = await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 300.1.1.1 -PrefixLength 24');
    expect(viaNetsh).toMatch(/Invalid|not a valid/i);
    expect(viaPs).toMatch(/Invalid|not a valid/i);
  });
});

describe('a token that starts with digits and carries a colon is a bare word', () => {
  const lex = (src: string) => new PSLexer().tokenize(src)
    .filter(t => t.type !== 'EOF').map(t => t.value);

  it('an IPv6 address survives unquoted, whatever it starts with', () => {
    expect(lex('Write-Output 2001:db8::1')).toEqual(['Write-Output', '2001:db8::1']);
    expect(lex('Write-Output fe80::1')).toEqual(['Write-Output', 'fe80::1']);
  });

  it('and it reaches the cmdlet intact', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    expect(await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 2001:db8::1 -PrefixLength 64'))
      .not.toContain('"2001"');
  });

  it('a time-looking argument survives too', () => {
    expect(lex('Write-Output 10:30')).toEqual(['Write-Output', '10:30']);
  });

  it('what was already whole stays whole', () => {
    expect(lex('Write-Output C:\\Users')).toEqual(['Write-Output', 'C:\\Users']);
    expect(lex('Get-ChildItem -Path C:\\')).toEqual(['Get-ChildItem', 'path', 'C:\\']);
    expect(lex('Write-Output $global:x')).toEqual(['Write-Output', 'global:x']);
  });

  it('a plain number is still a number', () => {
    expect(lex('Write-Output 2001')).toEqual(['Write-Output', '2001']);
    expect(lex('Write-Output 1.5')).toEqual(['Write-Output', '1.5']);
    expect(lex('Write-Output 127.0.0.1')).toEqual(['Write-Output', '127.0.0.1']);
  });
});

describe('the last section of a comment-based help block is not lost', () => {
  const src = (tail: string) => [
    'function T {', '<#', '.SYNOPSIS', 'Fait un truc',
    '.DESCRIPTION', tail, '#>', '}',
  ].join('\n');

  it('a final section with no Z in it is captured whole', () => {
    // `\Z` n'est pas une ancre en JavaScript : c'est un Z litteral. La
    // derniere section n'etait donc gardee que si elle contenait cette
    // lettre — et tronquee dessus quand elle l'avait.
    expect(extractCommentHelp(src('Description finale sans la lettre interdite')))
      .toEqual({ synopsis: 'Fait un truc', description: 'Description finale sans la lettre interdite' });
  });

  it('a final section containing a Z is no longer cut at it', () => {
    expect(extractCommentHelp(src('Avant un Z et apres')).description)
      .toBe('Avant un Z et apres');
  });

  it('a middle section is unaffected', () => {
    expect(extractCommentHelp(src('peu importe')).synopsis).toBe('Fait un truc');
  });
});

describe('an Int64 bound is reported exactly', () => {
  it('[long]::MaxValue and MinValue are not rounded', () => {
    const i = new PSInterpreter();
    // Un Int64 ne tient pas dans un `number` JavaScript : ecrits en
    // litteraux, ces bornes sortaient `9223372036854776000`.
    expect(i.execute('[long]::MaxValue').trim()).toBe('9223372036854775807');
    expect(i.execute('[long]::MinValue').trim()).toBe('-9223372036854775808');
  });

  it('the bounds that DO fit a number are untouched', () => {
    const i = new PSInterpreter();
    expect(i.execute('[int]::MaxValue').trim()).toBe('2147483647');
    expect(i.execute('[int]::MinValue').trim()).toBe('-2147483648');
  });
});
