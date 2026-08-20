/**
 * One machine, one registry — whichever door you came in by.
 *
 * A Windows box has two shells that both write the registry: `reg` from
 * `cmd`, and the `*-Item*` cmdlets from PowerShell. They are two
 * INTERFACES over one store — `WinRegistryProvider` (WinRegCommand.ts) is
 * a narrow port, not a second implementation, and `WindowsPC.cmdReg`
 * hands it the very `PSRegistryProvider` the cmdlets use. The first two
 * cases pin that, in both directions, because it is the property a
 * student actually relies on: what `reg add` wrote, `Get-ItemProperty`
 * reads. (The path spellings differ — `HKLM\…` for `reg`, the
 * `HKLM:\…` drive for PowerShell — as they do on a real machine; that is
 * two syntaxes over one hive, not two hives.)
 *
 * The third case is the one that was genuinely broken.
 * `createWindowsPSProviders(pc)` defaulted its shared state to FRESH,
 * detached objects — a private registry, a private event log, private
 * network tables — so a PowerShell built without an explicit `shared`
 * bag talked to a copy of the machine instead of the machine. Both
 * production callers happened to pass the bag by hand, spelling the same
 * six fields out twice; anyone adding a third call site, or any test,
 * silently got the detached copy. The device is the single source of
 * truth, so the factory now takes those stores from `pc` itself and the
 * detached copy is unreachable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

/** The same key, in each shell's own spelling. */
const REG_KEY = 'HKLM\\SOFTWARE\\Lab';
const PS_KEY = 'HKLM:\\SOFTWARE\\Lab';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function box(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1');
  pc.setCurrentUser('Administrator');
  pc.powerOn();
  return pc;
}

describe('cmd and PowerShell write the same registry', () => {
  it('what `reg add` wrote, `Get-ItemProperty` reads', async () => {
    const pc = box();

    await pc.executeCommand(`reg add ${REG_KEY} /v Site /d Douala /f`);

    expect(await pc.executeCommand(
      `powershell -Command "Get-ItemProperty -Path ${PS_KEY}"`,
    )).toContain('Douala');
  });

  it('what `Set-ItemProperty` wrote, `reg query` reads', async () => {
    const pc = box();
    await pc.executeCommand(`reg add ${REG_KEY} /v Site /d Douala /f`);

    await pc.executeCommand(
      `powershell -Command "Set-ItemProperty -Path ${PS_KEY} -Name Ville -Value Yaounde"`,
    );

    const out = await pc.executeCommand(`reg query ${REG_KEY}`);
    // Both values, side by side: the cmdlet added to the key `reg`
    // created, it did not shadow it in a second hive.
    expect(out).toContain('Site');
    expect(out).toContain('Douala');
    expect(out).toContain('Ville');
    expect(out).toContain('Yaounde');
  });
});

describe('a PowerShell built from the factory is wired to the machine', () => {
  it('a bagless `createWindowsPSProviders(pc)` writes the device registry', async () => {
    const pc = box();
    const interp = new PSInterpreter(createWindowsPSProviders(pc));

    interp.executeInteractive(`New-Item -Path ${PS_KEY} -Force | Out-Null`);
    interp.executeInteractive(`Set-ItemProperty -Path ${PS_KEY} -Name Pays -Value Cameroun`);

    // Read it back through the OTHER door, on the device itself: had the
    // factory handed the interpreter a private registry, `reg` would see
    // nothing at all.
    expect(await pc.executeCommand(`reg query ${REG_KEY}`)).toContain('Cameroun');
  });

  it("…and its network tables are the device's, not a private copy", () => {
    const pc = box();
    const interp = new PSInterpreter(createWindowsPSProviders(pc));

    interp.executeInteractive(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 10.9.9.9 -PrefixLength 24',
    );

    // `extraIPs` is the device's own table — the one `ipconfig` reads.
    expect([...pc.extraIPs.keys()]).toContain('10.9.9.9');
  });
});
