/**
 * NPS avancé — PRD-Windows-Server-Advanced.md §5 P22, §2.1.21.
 * `New-NpsConnectionRequestPolicy` combines multiple conditions (AD/local
 * group + time-of-day), evaluated in priority order before the existing
 * network policies; `Set-NpsAccountingConfiguration -SqlLogging` redirects
 * the RADIUS accounting records `WindowsNpsRole` already produces into a
 * simulated SQL table built on this project's own `OracleDatabase`.
 * NAP is explicitly out of scope (§2.2) and never exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLab() {
  const nps = new WindowsServer('NPS1');
  const nas = new CiscoRouter('NAS');
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, nps.getPorts()[0]);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  nps.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  nps.setCurrentUser('Administrator');
  await run(ps(nps), 'Install-WindowsFeature NPAS');
  await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.1.1 -SharedSecret shared');
  await run(ps(nps), 'New-LocalUser -Name npsuser -Password "N3twork!Pass"');
  await run(ps(nps), 'New-LocalGroup -Name Sales');
  await run(ps(nps), 'Add-LocalGroupMember -Group Sales -Member npsuser');
  await run(ps(nps), 'New-NpsNetworkPolicy -Name SalesPolicy -Group Sales -VlanId 200');
  nas.getRadiusClient().addServer('10.0.1.2', 'shared', { timeoutMs: 200, retransmit: 0 });
  return { nps, nas };
}

describe('New-NpsConnectionRequestPolicy — combined conditions (§5 P22)', () => {
  it('a request matching group + time-of-day is authenticated', async () => {
    const { nps, nas } = await buildLab();
    // Deterministic simulated clock starts at Sat 2026-06-20 00:00 (day=6).
    nps.advanceTime(10 * 3600_000); // 10:00 Saturday
    await run(ps(nps), 'New-NpsConnectionRequestPolicy -Name BusinessHours -UserGroups Sales -Days 6 -StartHour 9 -EndHour 17');

    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(true);
  });

  it('the same user is rejected outside the configured time window, before network policy is even consulted', async () => {
    const { nps, nas } = await buildLab();
    nps.advanceTime(20 * 3600_000); // 20:00 Saturday — outside 9-17
    await run(ps(nps), 'New-NpsConnectionRequestPolicy -Name BusinessHours -UserGroups Sales -Days 6 -StartHour 9 -EndHour 17');

    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(false);
  });

  it('a request from a group with no matching connection request policy is rejected', async () => {
    const { nps, nas } = await buildLab();
    nps.advanceTime(10 * 3600_000);
    await run(ps(nps), 'New-NpsConnectionRequestPolicy -Name BusinessHours -UserGroups Marketing -Days 6 -StartHour 9 -EndHour 17');

    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(false);
  });

  it('with no connection request policy configured at all, existing network-policy-only behavior is unchanged', async () => {
    const { nps, nas } = await buildLab();
    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(true);
  });

  it('Get-NpsConnectionRequestPolicy reflects the configured conditions', async () => {
    const { nps } = await buildLab();
    await run(ps(nps), 'New-NpsConnectionRequestPolicy -Name BusinessHours -UserGroups Sales -Days 6 -StartHour 9 -EndHour 17');
    const out = await run(ps(nps), 'Get-NpsConnectionRequestPolicy | Select-Object -ExpandProperty PolicyName');
    expect(out.trim()).toBe('BusinessHours');
  });
});

describe('Set-NpsAccountingConfiguration -SqlLogging (§5 P22)', () => {
  it('RADIUS accounting records land in the simulated SQL table once SQL logging is enabled', async () => {
    const { nps, nas } = await buildLab();
    await run(ps(nps), 'Set-NpsAccountingConfiguration -SqlLogging $true');

    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(true);
    nas.getRadiusAccountingClient().addServer('10.0.1.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    const sessionId = nas.getRadiusAccountingClient().startSession('npsuser');
    expect(sessionId).not.toBeNull();
    nas.getRadiusAccountingClient().stopSession(sessionId!);

    const role = nps.getNpsRole()!;
    const rs = role.queryAccounting('SELECT USERNAME, STATUS FROM RADIUS_ACCOUNTING');
    expect(rs).not.toBeNull();
    const usernames = rs!.rows.map((r) => String(r[0]));
    expect(usernames).toContain('npsuser');
  });

  it('accounting records are not captured when SQL logging is disabled', async () => {
    const { nps, nas } = await buildLab();
    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(true);
    nas.getRadiusAccountingClient().addServer('10.0.1.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    nas.getRadiusAccountingClient().startSession('npsuser');

    const role = nps.getNpsRole()!;
    expect(role.isSqlAccountingEnabled()).toBe(false);
    expect(role.queryAccounting('SELECT * FROM RADIUS_ACCOUNTING')).toBeNull();
  });
});
