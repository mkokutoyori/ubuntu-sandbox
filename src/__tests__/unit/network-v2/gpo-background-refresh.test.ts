/*
 * Probe — Group Policy se rafraichit toute seule en arriere-plan : une
 * machine membre toutes les 90 minutes plus un decalage de 0 a 30 minutes,
 * un controleur de domaine toutes les 5 minutes, sur l'horloge simulee de la
 * machine, sans qu'aucun `gpupdate` soit tape. Les valeurs de registre
 * `GroupPolicyRefreshTime[Offset][DC]` et `DisableBkGndGroupPolicy` que la
 * strategie « Set Group Policy refresh interval » pose sont LUES, et chaque
 * traitement ecrit son evenement dans le journal System.
 *
 * Mesure d'origine : `gpupdate` etait le seul declencheur. Une GPO liee apres
 * la jonction n'atteignait jamais le poste tant que personne ne tapait la
 * commande, la strategie de cadence etait acceptee, stockee et ignoree (un
 * critere non evalue), et un traitement — reussi ou en echec de connectivite
 * — ne laissait aucune trace dans le journal.
 *
 * Autorite (recherche ; learn.microsoft.com n'est pas joignable d'ici) :
 * intervalle par defaut 90 minutes plus un decalage aleatoire de 0 a 30
 * minutes pour un poste, 5 minutes pour un DC ; valeurs REG_DWORD
 * `GroupPolicyRefreshTime` (0-64800) et `GroupPolicyRefreshTimeOffset`
 * (0-1440), variantes `...DC`, sous
 * HKLM\Software\Policies\Microsoft\Windows\System ; `DisableBkGndGroupPolicy`
 * = 1 supprime le rafraichissement d'arriere-plan. Evenements du journal
 * System, source Microsoft-Windows-GroupPolicy : 1502 « New settings from N
 * Group Policy objects were detected and applied », 1500 « There were no
 * changes detected since the last successful processing », 1129 « lack of
 * network connectivity to a domain controller ». Le decalage reel est tire au
 * hasard ; il est ici derive du nom de la machine et du numero de cycle, pour
 * rester reproductible. Un intervalle de 0 minute vaut 7 secondes, comme la
 * strategie le decrit. Une longue avance d'horloge en un seul pas compte pour
 * un seul rafraichissement, pas pour tous ceux qu'elle enjambe.
 *
 * Mesure avant le correctif (git stash de src/network et src/powershell) :
 * 8 des 12 cas tombent. Passent des deux cotes, et pourquoi :
 *  - « TEMOIN : gpupdate /force applique la GPO » — le banc et le registre
 *    sont sains.
 *  - « avant 90 minutes, rien n'est applique » — NON-REGRESSION : la cadence
 *    ne doit pas rafraichir trop tot (avant, rien ne se rafraichissait).
 *  - « une machine hors domaine ne se rafraichit pas » — NON-REGRESSION.
 *  - « avec le rafraichissement d'arriere-plan desactive, rien n'est
 *    applique » — GARDE : avant, rien ne s'appliquait seul non plus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { ROOT, POSTES, gpo, joinIn, lab, policyValue, resetGpoWorld, run } from './gpoLab';

beforeEach(resetGpoWorld);

const MINUTE = 60_000;
const DC_OU = `OU=Domain Controllers,${ROOT}`;
const SYSTEM_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System';

async function cadence(dc: Parameters<typeof run>[0], gpoName: string, values: Record<string, number>): Promise<void> {
  await run(dc, `New-GPO -Name "${gpoName}"`);
  for (const [name, value] of Object.entries(values)) {
    await run(dc, `Set-GPRegistryValue -Name "${gpoName}" -Key "${SYSTEM_KEY}" -ValueName ${name} -Type DWord -Value ${value}`);
  }
  await run(dc, `New-GPLink -Name "${gpoName}" -Target "${POSTES}"`);
}

async function systemEvents(machine: Parameters<typeof run>[0], id: number): Promise<string> {
  return run(machine, `Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = ${id} } | ForEach-Object { $_.Message }`);
}

describe('Group Policy — rafraîchissement d arrière-plan', () => {
  it('TEMOIN : gpupdate /force applique la GPO', async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it("avant 90 minutes, rien n'est appliqué", async () => {
    const l = await lab();
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(89 * MINUTE);
    expect(await policyValue(l.client)).not.toMatch(/REG_SZ\s+un\b/);
  });

  it("une GPO liée après la jonction atteint le poste sans gpupdate, en 120 minutes au plus", async () => {
    const l = await lab();
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(121 * MINUTE);
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it("un contrôleur de domaine se rafraîchit toutes les 5 minutes", async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "DcGpo"');
    await run(l.dc, 'Set-GPRegistryValue -Name "DcGpo" -Key "HKLM\\SOFTWARE\\Policies\\Lab" -ValueName Mode -Type String -Value "dc"');
    await run(l.dc, `New-GPLink -Name "DcGpo" -Target "${DC_OU}"`);
    l.dc.advanceTime(4 * MINUTE);
    expect(await policyValue(l.dc)).not.toMatch(/REG_SZ\s+dc\b/);
    l.dc.advanceTime(2 * MINUTE);
    expect(await policyValue(l.dc)).toMatch(/REG_SZ\s+dc\b/);
  });

  it("GroupPolicyRefreshTime fixé par une GPO règle la cadence du poste, décalage compris", async () => {
    const l = await lab();
    await cadence(l.dc, 'Cadence', { GroupPolicyRefreshTime: 60, GroupPolicyRefreshTimeOffset: 0 });
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(59 * MINUTE);
    expect(await policyValue(l.client)).not.toMatch(/REG_SZ\s+un\b/);
    l.client.advanceTime(2 * MINUTE);
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it('un intervalle de zéro minute rafraîchit toutes les 7 secondes', async () => {
    const l = await lab();
    await cadence(l.dc, 'Cadence', { GroupPolicyRefreshTime: 0, GroupPolicyRefreshTimeOffset: 0 });
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(8_000);
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it("DisableBkGndGroupPolicy coupe le rafraîchissement d'arrière-plan, gpupdate reste possible", async () => {
    const l = await lab();
    await cadence(l.dc, 'Cadence', { GroupPolicyRefreshTime: 5, GroupPolicyRefreshTimeOffset: 0, DisableBkGndGroupPolicy: 1 });
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(300 * MINUTE);
    expect(await policyValue(l.client)).not.toMatch(/REG_SZ\s+un\b/);
    await l.client.executeCmdCommand('gpupdate /force');
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it("une machine hors domaine ne se rafraîchit pas", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(300 * MINUTE);
    expect(await policyValue(l.client)).not.toMatch(/REG_SZ\s+un\b/);
  });

  it("chaque traitement écrit son événement : 1502 pour du nouveau, 1500 sans changement", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    expect(await systemEvents(l.client, 1502)).toMatch(/New settings from \d+ Group Policy objects were detected and applied/);
    await l.client.executeCmdCommand('gpupdate /force');
    expect(await systemEvents(l.client, 1500)).toMatch(/There were no changes detected since the last successful processing/);
    await gpo(l.dc, 'Autre', POSTES, 'deux');
    await l.client.executeCmdCommand('gpupdate /force');
    expect((await systemEvents(l.client, 1502)).split('New settings').length - 1).toBe(2);
  });

  it("le rafraîchissement automatique écrit lui aussi son événement", async () => {
    const l = await lab();
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.client.advanceTime(121 * MINUTE);
    expect(await systemEvents(l.client, 1502)).toMatch(/New settings/);
  });

  it("liaison coupée : l'échec de connectivité laisse l'événement 1129 et la politique reste en place", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    l.clientCable.disconnect();
    l.client.advanceTime(121 * MINUTE);
    expect(await systemEvents(l.client, 1129)).toMatch(/lack of network connectivity to a domain controller/);
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });

  it("liaison rétablie : le rafraîchissement suivant applique ce qui a changé entre-temps", async () => {
    const l = await lab();
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    l.clientCable.disconnect();
    l.client.advanceTime(121 * MINUTE);
    await gpo(l.dc, 'Lab', POSTES, 'un');
    l.reconnectClient();
    l.client.advanceTime(121 * MINUTE);
    expect(await policyValue(l.client)).toMatch(/REG_SZ\s+un\b/);
  });
});
