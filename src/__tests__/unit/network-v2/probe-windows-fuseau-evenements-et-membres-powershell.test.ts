/**
 * Trois manques de la meme famille, mesures en tapant la commande :
 *
 * 1. `tzutil` et `eventcreate` etaient inconnus de cmd (`'tzutil' is not recognized`) alors que
 *    `Set-TimeZone` et `Write-EventLog` existent : deux interfaces sur UN fuseau et UN journal
 *    d'evenements, dont une seule etait branchee. `tzutil /g|/l|/s` lit et ecrit le fuseau de
 *    l'identite de la machine (la meme que `Get-TimeZone`), `eventcreate` ecrit dans le journal
 *    que `Get-EventLog` et `wevtutil` lisent.
 * 2. Un `TimeSpan` PowerShell s'affichait avec une ligne `__type : TimeSpan`, les `Total*` en
 *    premier et sans `Ticks`, et `.ToString()`, `[TimeSpan]::FromMinutes(90)`, `[TimeSpan]::Parse`
 *    rendaient vide. Deux constructeurs (`makeTimeSpan`, `timeSpanValue`) et deux formateurs
 *    existaient : il n'en reste qu'un (`dotnetTimeSpan.ts`).
 * 3. Les nombres n'avaient aucun membre : `(255).ToString("X")`, `.CompareTo`, `.Equals`,
 *    `.GetType()` rendaient vide, et `[Math]::Pi` s'affichait avec 16 chiffres significatifs la ou
 *    Windows PowerShell 5.1 en ecrit 15.
 *
 * 4. `Write-EventLog` dans un journal inconnu : le fournisseur detectait l'erreur et le cmdlet
 *    l'avalait (`writeEntry` rendait `void`), si bien que la commande ne disait rien et n'ecrivait rien.
 *
 * Discriminee contre l'etat d'avant (sources de `mandeng`, meme sonde) : 18 des 19 cas tombent. Le
 * seul qui passe des deux cotes est NOMME : le temoin (`Set-TimeZone` puis `Get-TimeZone`, il prouve
 * que le laboratoire est sain).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const ORIGIN_MS = Date.UTC(2026, 9, 6, 18, 25, 0);

function lab() {
  installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
  const pc = new WindowsPC('windows-pc', 'W1');
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  const cmd = (line: string): Promise<string> => pc.executeCommand(line);
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  return { pc, cmd, ps };
}

afterEach(() => { __resetSimulationClock(); });

describe('tzutil reads and writes the time zone of the machine', () => {
  it('witness: Set-TimeZone then Get-TimeZone agree', async () => {
    const { ps } = lab();
    await ps('Set-TimeZone -Id "Tokyo Standard Time"');
    expect(await ps('(Get-TimeZone).Id')).toContain('Tokyo Standard Time');
  });

  it('/g answers the identifier of the current zone, UTC by default', async () => {
    const { cmd } = lab();
    expect((await cmd('tzutil /g')).trim()).toBe('UTC');
  });

  it('/s changes the zone that PowerShell and the clock read', async () => {
    const { cmd, ps } = lab();
    expect((await cmd('tzutil /s "Tokyo Standard Time"')).trim()).toBe('');
    expect((await cmd('tzutil /g')).trim()).toBe('Tokyo Standard Time');
    expect(await ps('(Get-TimeZone).Id')).toContain('Tokyo Standard Time');
    expect(await ps('Get-Date -Format "yyyy-MM-dd HH:mm"')).toContain('2026-10-07 03:25');
  });

  it('/g after Set-TimeZone answers the zone PowerShell set', async () => {
    const { cmd, ps } = lab();
    await ps('Set-TimeZone -Id "Romance Standard Time"');
    expect((await cmd('tzutil /g')).trim()).toBe('Romance Standard Time');
  });

  it('/s refuses an unknown zone, leaves the zone alone and sets the error level', async () => {
    const { cmd } = lab();
    const out = await cmd('tzutil /s "Nowhere Standard Time"');
    expect(out).toContain('TZUTIL: Invalid time zone Nowhere Standard Time.');
    expect((await cmd('echo %errorlevel%')).trim()).toBe('1');
    expect((await cmd('tzutil /g')).trim()).toBe('UTC');
  });

  it('/s without its argument is refused', async () => {
    const { cmd } = lab();
    expect(await cmd('tzutil /s')).toContain('TZUTIL: Invalid number of arguments for /s.');
  });

  it('/l lists the display name then the identifier, as Get-TimeZone -ListAvailable names them', async () => {
    const { cmd, ps } = lab();
    const listing = await cmd('tzutil /l');
    expect(listing).toContain('(UTC+01:00) Brussels, Copenhagen, Madrid, Paris\nRomance Standard Time\n');
    const display = await ps('(Get-TimeZone -ListAvailable | Where-Object Id -eq "Romance Standard Time").DisplayName');
    expect(listing).toContain(display.trim());
  });
});

describe('eventcreate writes the journal that Get-EventLog and wevtutil read', () => {
  it('writes into Application with the default source and says so', async () => {
    const { cmd, ps } = lab();
    const out = await cmd('eventcreate /t information /id 100 /d "backup finished"');
    expect(out.trim()).toBe("SUCCESS: An event of type 'information' was created in the 'APPLICATION' log with 'EventCreate' as the source.");
    const listed = await ps('Get-EventLog -LogName Application -Source EventCreate | Format-List Message, EventID');
    expect(listed).toContain('backup finished');
    expect(listed).toContain('100');
    expect(await cmd('wevtutil qe Application /c:1 /rd:true /f:text')).toContain('backup finished');
  });

  it('honours /l, /so and the type', async () => {
    const { cmd, ps } = lab();
    const out = await cmd('eventcreate /l System /so Private /t ERROR /id 900 /d "audit complete"');
    expect(out).toContain("'ERROR' was created in the 'System' log with 'Private' as the source");
    const listed = await ps('Get-EventLog -LogName System -Source Private | Format-List EntryType, EventID, Message');
    expect(listed).toContain('Error');
    expect(listed).toContain('900');
    expect(listed).toContain('audit complete');
  });

  it('refuses an identifier outside 1-1000 without writing', async () => {
    const { cmd, ps } = lab();
    for (const id of ['0', '1001', 'abc']) {
      expect(await cmd(`eventcreate /t information /id ${id} /d "x"`)).toContain("ERROR: Invalid Argument/Option - '/ID'.");
    }
    expect((await cmd('echo %errorlevel%')).trim()).toBe('1');
    expect(await ps('Get-EventLog -LogName Application -Source EventCreate')).not.toContain('Message');
  });

  it('refuses a missing description and an unknown log', async () => {
    const { cmd } = lab();
    expect(await cmd('eventcreate /t information /id 5')).toContain("'/D' option is required");
    expect(await cmd('eventcreate /l Nothing /t information /id 5 /d x')).toContain("Invalid Argument/Option - '/L'");
  });

  it('refuses the remote options it cannot honour rather than writing locally', async () => {
    const { cmd, ps } = lab();
    expect(await cmd('eventcreate /s other-pc /t information /id 5 /d "remote"')).toContain("Invalid Argument/Option - '/S'");
    expect(await ps('Get-EventLog -LogName Application -Source EventCreate')).not.toContain('remote');
  });

  it('Write-EventLog refuses an unknown log instead of swallowing it', async () => {
    const { ps } = lab();
    expect(await ps('Write-EventLog -LogName Nothing -Source X -EventId 1 -Message m')).toContain('Cannot open log');
  });
});

describe('PowerShell TimeSpan and number members', () => {
  it('a TimeSpan lists Days..Milliseconds, Ticks, then the Totals, without a type line', async () => {
    const { ps } = lab();
    const out = await ps('New-TimeSpan -Hours 1');
    expect(out).not.toContain('__type');
    const names = out.split('\n').map((line) => line.split(':')[0].trim()).filter((name) => name !== '');
    expect(names).toEqual(['Days', 'Hours', 'Minutes', 'Seconds', 'Milliseconds', 'Ticks',
      'TotalDays', 'TotalHours', 'TotalMinutes', 'TotalSeconds', 'TotalMilliseconds']);
    expect(out).toContain('Ticks             : 36000000000');
    expect(out).toContain('TotalDays         : 0.0416666666666667');
  });

  it('ToString renders the constant format and accepts a custom one', async () => {
    const { ps } = lab();
    expect((await ps('(New-TimeSpan -Days 1 -Hours 2).ToString()')).trim()).toBe('1.02:00:00');
    expect((await ps('[TimeSpan]::FromMinutes(90).ToString()')).trim()).toBe('01:30:00');
    expect((await ps('[TimeSpan]::FromMinutes(90).ToString("hh\\:mm")')).trim()).toBe('01:30');
  });

  it('statics, arithmetic and parsing agree with the instance', async () => {
    const { ps } = lab();
    expect((await ps('[TimeSpan]::Parse("1.02:03:04").TotalSeconds')).trim()).toBe('93784');
    expect((await ps('([TimeSpan]::FromHours(1).Add([TimeSpan]::FromMinutes(30))).TotalMinutes')).trim()).toBe('90');
    expect((await ps('(New-TimeSpan -Start (Get-Date "2026-01-01") -End (Get-Date "2026-01-03")).TotalHours')).trim()).toBe('48');
    expect((await ps('[TimeSpan]::FromSeconds(75).CompareTo([TimeSpan]::FromSeconds(60))')).trim()).toBe('1');
  });

  it('numbers format with .NET format strings', async () => {
    const { ps } = lab();
    expect((await ps('(3.14159).ToString("F2")')).trim()).toBe('3.14');
    expect((await ps('(255).ToString("X")')).trim()).toBe('FF');
    expect((await ps('(1234567.891).ToString("N2")')).trim()).toBe('1,234,567.89');
    expect((await ps('(10).ToString("D5")')).trim()).toBe('00010');
  });

  it('numbers compare, equal and name their type', async () => {
    const { ps } = lab();
    expect((await ps('$x = 42; $x.CompareTo(40)')).trim()).toBe('1');
    expect((await ps('$x.Equals(42)')).trim()).toBe('True');
    expect((await ps('(1.5).GetType().Name')).trim()).toBe('Double');
    expect((await ps('(7).GetType().FullName')).trim()).toBe('System.Int32');
    expect((await ps('$true.ToString()')).trim()).toBe('True');
  });

  it('a double shows its 15 significant digits', async () => {
    const { ps } = lab();
    expect((await ps('[Math]::Pi')).trim()).toBe('3.14159265358979');
    expect((await ps('0.1 + 0.2')).trim()).toBe('0.3');
  });
});
