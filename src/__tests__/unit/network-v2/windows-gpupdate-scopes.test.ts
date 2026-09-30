/*
 * gpupdate / Invoke-GPUpdate: /target:computer|user applies only its own
 * scope (HKLM policy for the computer, HKCU policy for the user), the switches
 * /force /wait /logoff /boot /sync are accepted (nothing here needs a logoff, a
 * reboot or an asynchronous foreground pass, so they are honoured by doing
 * nothing extra), an unknown argument is refused, and the cmdlet applies a
 * random delay of 0..RandomDelayInMinutes (default 10) on the simulated clock.
 *
 * Output layout ("Updating policy..." then one "... Policy update has completed
 * successfully." line per processed scope) is the layout Windows prints; the
 * text of the refusal is unsourced (learn.microsoft.com is unreachable from
 * here).
 *
 * Discrimination (git stash of the source files): 9 of the 11 cases fall before
 * the change. The two that pass either way are witnesses: a plain
 * `gpupdate /force` still applies both scopes, and a machine outside the domain
 * still refuses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ROOT, POSTES, joinIn, lab, resetGpoWorld, run, type Lab } from './gpoLab';

beforeEach(resetGpoWorld);

async function labWithBothScopes(): Promise<Lab> {
  const l = await lab();
  await run(l.dc, 'New-GPO -Name "Scopes"');
  await run(l.dc, 'Set-GPRegistryValue -Name "Scopes" -Key "HKLM\\SOFTWARE\\Policies\\Lab" -ValueName Mode -Type String -Value "machine"');
  await run(l.dc, 'Set-GPRegistryValue -Name "Scopes" -Key "HKCU\\SOFTWARE\\Policies\\Lab" -ValueName UserMode -Type String -Value "user"');
  await run(l.dc, `New-GPLink -Name "Scopes" -Target "${ROOT}"`);
  await joinIn(l, POSTES);
  return l;
}

const RSAT_GP = 'Add-WindowsCapability -Online -Name "Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0"';
const machineValue = (l: Lab) => l.client.executeCmdCommand('reg query "HKLM\\SOFTWARE\\Policies\\Lab" /v Mode');
const userValue = (l: Lab) => l.client.executeCmdCommand('reg query "HKCU\\SOFTWARE\\Policies\\Lab" /v UserMode');

describe('gpupdate — cibles et options', () => {
  it('TÉMOIN : gpupdate /force applique les deux portées et l annonce', async () => {
    const l = await labWithBothScopes();
    const out = await l.client.executeCmdCommand('gpupdate /force');
    expect(out).toContain('Computer Policy update has completed successfully.');
    expect(out).toContain('User Policy update has completed successfully.');
    expect(await machineValue(l)).toMatch(/machine/);
    expect(await userValue(l)).toMatch(/user/);
  });

  it('/target:user n applique que la portée utilisateur', async () => {
    const l = await labWithBothScopes();
    const out = await l.client.executeCmdCommand('gpupdate /target:user');
    expect(out).toContain('User Policy update has completed successfully.');
    expect(out).not.toContain('Computer Policy');
    expect(await userValue(l)).toMatch(/user/);
    expect(await machineValue(l)).not.toMatch(/machine/);
  });

  it('/target:computer n applique que la portée ordinateur', async () => {
    const l = await labWithBothScopes();
    const out = await l.client.executeCmdCommand('gpupdate /target:computer');
    expect(out).toContain('Computer Policy update has completed successfully.');
    expect(out).not.toContain('User Policy');
    expect(await machineValue(l)).toMatch(/machine/);
    expect(await userValue(l)).not.toMatch(/user/);
  });

  it('un rafraîchissement d une portée ne retire pas les valeurs de l autre', async () => {
    const l = await labWithBothScopes();
    await l.client.executeCmdCommand('gpupdate /force');
    await run(l.dc, 'Remove-GPRegistryValue -Name "Scopes" -Key "HKCU\\SOFTWARE\\Policies\\Lab" -ValueName UserMode');
    await l.client.executeCmdCommand('gpupdate /target:computer');
    expect(await userValue(l)).toMatch(/user/);
    await l.client.executeCmdCommand('gpupdate /target:user');
    expect(await userValue(l)).not.toMatch(/user\b/);
    expect(await machineValue(l)).toMatch(/machine/);
  });

  it('/force /wait:5 /logoff /boot /sync sont acceptés', async () => {
    const l = await labWithBothScopes();
    const out = await l.client.executeCmdCommand('gpupdate /force /wait:5 /logoff /boot /sync');
    expect(out).toContain('Computer Policy update has completed successfully.');
  });

  it('un argument inconnu est refusé et rien n est appliqué', async () => {
    const l = await labWithBothScopes();
    expect(await l.client.executeCmdCommand('gpupdate /bogus')).toMatch(/Invalid Argument/);
    expect(await machineValue(l)).not.toMatch(/machine/);
  });

  it('Invoke-GPUpdate -Target Computer -RandomDelayInMinutes 0 applique tout de suite', async () => {
    const l = await labWithBothScopes();
    const before = l.client.simulatedDate().getTime();
    await run(l.client, RSAT_GP);
    await run(l.client, 'Invoke-GPUpdate -Target Computer -RandomDelayInMinutes 0');
    expect(l.client.simulatedDate().getTime() - before).toBeLessThan(1000);
    expect(await machineValue(l)).toMatch(/machine/);
    expect(await userValue(l)).not.toMatch(/user/);
  });

  it('Invoke-GPUpdate laisse par défaut jusqu à 10 minutes s écouler avant d appliquer', async () => {
    const l = await labWithBothScopes();
    const before = l.client.simulatedDate().getTime();
    await run(l.client, RSAT_GP);
    await run(l.client, 'Invoke-GPUpdate -Force');
    const elapsed = l.client.simulatedDate().getTime() - before;
    expect(elapsed).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(await machineValue(l)).toMatch(/machine/);
    expect(await userValue(l)).toMatch(/user/);
  });

  it('un délai aléatoire borné : -RandomDelayInMinutes 3 ne dépasse pas 3 minutes', async () => {
    const l = await labWithBothScopes();
    const before = l.client.simulatedDate().getTime();
    await run(l.client, RSAT_GP);
    await run(l.client, 'Invoke-GPUpdate -RandomDelayInMinutes 3');
    expect(l.client.simulatedDate().getTime() - before).toBeLessThanOrEqual(3 * 60_000 + 1000);
  });

  it('sans les outils RSAT Group Policy, un poste ne connaît pas Invoke-GPUpdate', async () => {
    const l = await labWithBothScopes();
    expect(await run(l.client, 'Invoke-GPUpdate -Force')).toMatch(/not recognized/);
  });

  it('TÉMOIN : hors domaine, gpupdate refuse toujours', async () => {
    const l = await lab();
    expect(await l.client.executeCmdCommand('gpupdate /force')).toMatch(/not joined to a domain/);
  });
});
