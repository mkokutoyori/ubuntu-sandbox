/**
 * Activation/licensing minimal — PRD-Windows-Server-Advanced.md §5 P21,
 * §2.1.20. `slmgr /ipk`/`/ato`/`/dlv` drive a per-machine simulated
 * license state; `Get-CimInstance SoftwareLicensingProduct` reflects it.
 * Purely declarative: a fictitious key matching the real-world
 * `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` shape is all that's ever required — no
 * cryptographic verification.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('Activation/licensing (§5 P21)', () => {
  it('a fresh machine starts unactivated (Notification), reflected by both slmgr /dlv and Get-CimInstance', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const dlv = await pc.executeCmdCommand('slmgr /dlv');
    expect(dlv).toMatch(/License Status: Notification/);

    const status = await run(ps(pc), 'Get-CimInstance -ClassName SoftwareLicensingProduct | Select-Object -ExpandProperty LicenseStatus');
    expect(status.trim()).toBe('5');
  });

  it('/ato without an installed key fails and leaves the state unlicensed', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const out = await pc.executeCmdCommand('slmgr /ato');
    expect(out).toMatch(/0xC004F015/);

    const status = await run(ps(pc), 'Get-CimInstance -ClassName SoftwareLicensingProduct | Select-Object -ExpandProperty LicenseStatus');
    expect(status.trim()).toBe('5');
  });

  it('a fictitious KMS/MAK key transitions the state to Licensed via /ipk then /ato', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const ipkOut = await pc.executeCmdCommand('slmgr /ipk AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    expect(ipkOut).toMatch(/successfully/);

    const atoOut = await pc.executeCmdCommand('slmgr /ato');
    expect(atoOut).toMatch(/activated successfully/);

    const dlv = await pc.executeCmdCommand('slmgr /dlv');
    expect(dlv).toMatch(/License Status: Licensed/);
    expect(dlv).toMatch(/Partial Product Key: EEEEE/);

    const status = await run(ps(pc), 'Get-CimInstance -ClassName SoftwareLicensingProduct | Select-Object -ExpandProperty LicenseStatus');
    expect(status.trim()).toBe('1');
  });

  it('an malformed key is rejected by /ipk', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const out = await pc.executeCmdCommand('slmgr /ipk not-a-real-key');
    expect(out).toMatch(/0xC004F014/);
  });
});
