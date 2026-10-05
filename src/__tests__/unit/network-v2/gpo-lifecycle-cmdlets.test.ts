/*
 * Probe — le cycle de vie d'une GPO : `Remove-GPO`, `Rename-GPO`,
 * `Remove-GPLink`, `Get-GPRegistryValue`, `Remove-GPRegistryValue`, et ce
 * que `gpupdate` en fait sur un poste membre.
 *
 * Mesure d'origine : ces cinq cmdlets etaient inconnues (« is not
 * recognized »), on ne pouvait ni retirer une GPO, ni delier, ni relire ce
 * qu'elle pose. Et un critere etait accepte sans etre evalue : `New-GPO
 * -Comment` etait lu par aucun code (Get-GPO n'avait pas de Description),
 * `Set-GPRegistryValue -Type` acceptait n'importe quel mot, une cle hors
 * HKLM/HKCU et un DWord non numerique, `New-GPLink -Enforced Maybe` etait
 * lu comme « non » sans avertir, et `-Domain` d'un autre domaine etait
 * ignore. Enfin une valeur posee par une GPO ne disparaissait jamais du
 * registre du poste, meme quand la GPO etait supprimee ou deliee.
 *
 * Autorite : PowerShell GroupPolicy (`Remove-GPO [-KeepLinks]` supprime la
 * GPO et, par defaut, ses liens du domaine ; `Rename-GPO -Name -TargetName` ;
 * `Remove-GPLink -Name -Target` ; `Get/Remove-GPRegistryValue -Name -Key
 * [-ValueName]`), et le comportement documente du client Group Policy : une
 * valeur d'une cle `...\Policies\...` est retiree quand la GPO ne s'applique
 * plus, alors que les autres cles restent en place (« tattooing »). Les
 * enumerations Yes/No d'`-Enforced`/`-LinkEnabled`/`-IsBlocked` sont refusees
 * dans les mots de PowerShell pour une enumeration. Seul le debut du message
 * d'absence d'un parametre de registre (« The following Group Policy registry
 * setting was not found ») est source (recherche, learn.microsoft.com n'etant
 * pas joignable) ; les autres libelles GroupPolicy nomment la cause sans
 * pretendre etre le texte de Microsoft.
 *
 * Mesure avant le correctif (git stash de src/network et src/powershell) :
 * 15 des 19 cas tombent. Passent des deux cotes, et pourquoi :
 *  - « TEMOIN : la GPO posee s'applique au poste » — le banc, la jonction,
 *    gpupdate et le registre sont sains, donc un echec des autres cas accuse
 *    les cmdlets et non le banc.
 *  - « une cle hors Policies reste en place apres le retrait de la GPO » —
 *    NON-REGRESSION : le tattooing est le comportement reel ; avant, tout
 *    restait.
 *  - « un lien Enforced Yes est accepte » — NON-REGRESSION.
 *  - « Remove-GPO ne touche pas aux liens des autres GPO » — GARDE : avant,
 *    Remove-GPO n'existait pas et rien n'etait retire ; apres, il ne doit
 *    retirer que les liens de la GPO supprimee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { POSTES, ROOT, SIEGE, applied, gpo, joinIn, lab, mode, resetGpoWorld, run } from './gpoLab';

beforeEach(resetGpoWorld);

const KEY = 'HKLM\\SOFTWARE\\Policies\\Lab';

describe('GPO — Remove/Rename/Get/Remove-GPRegistryValue, validation, retrait au poste', () => {
  it("TEMOIN : la GPO posée s'applique au poste", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    expect(await mode(l.client)).toContain('un');
  });

  it('New-GPO -Comment est conservé et relu par Get-GPO', async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab" -Comment "Baseline du siege"');
    expect(await run(l.dc, '(Get-GPO -Name "Lab").Description')).toBe('Baseline du siege');
  });

  it('Remove-GPO supprime la GPO et ses liens', async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    expect(await run(l.dc, 'Remove-GPO -Name "Lab"')).toBe('');
    expect(await run(l.dc, 'Get-GPO -Name "Lab"')).toMatch(/cannot be found/i);
    expect(await run(l.dc, `(Get-GPInheritance -Target "${POSTES}").GpoLinks`)).not.toContain('Lab');
  });

  it("Remove-GPO -KeepLinks laisse un lien orphelin qui ne s'applique pas", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES);
    await run(l.dc, 'Remove-GPO -Name "Lab" -KeepLinks');
    await joinIn(l, POSTES);
    expect(await applied(l.client)).not.toContain('Lab');
  });

  it('Remove-GPO refuse une GPO inconnue', async () => {
    const l = await lab();
    expect(await run(l.dc, 'Remove-GPO -Name "Nulle"')).toMatch(/A GPO with the name "Nulle" cannot be found/);
  });

  it('Remove-GPLink délie sans supprimer la GPO', async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES);
    await run(l.dc, `Remove-GPLink -Name "Lab" -Target "${POSTES}"`);
    expect(await run(l.dc, '(Get-GPO -Name "Lab").DisplayName')).toBe('Lab');
    await joinIn(l, POSTES);
    expect(await applied(l.client)).not.toContain('Lab');
  });

  it("Remove-GPLink refuse un lien qui n'existe pas", async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    expect(await run(l.dc, `Remove-GPLink -Name "Lab" -Target "${POSTES}"`)).toMatch(/is not linked/i);
  });

  it('Rename-GPO renomme la GPO et réécrit ses liens', async () => {
    const l = await lab();
    await gpo(l.dc, 'Ancien', POSTES, 'un');
    await run(l.dc, 'Rename-GPO -Name "Ancien" -TargetName "Nouveau"');
    expect(await run(l.dc, 'Get-GPO -Name "Ancien"')).toMatch(/cannot be found/i);
    await joinIn(l, POSTES);
    const out = await applied(l.client);
    expect(out).toContain('Nouveau');
    expect(out).not.toContain('Ancien');
    expect(await mode(l.client)).toContain('un');
  });

  it('Get-GPRegistryValue relit ce que la GPO pose', async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    expect(await run(l.dc, `(Get-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName Mode).Value`)).toBe('un');
    expect(await run(l.dc, `(Get-GPRegistryValue -Name "Lab" -Key "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Lab").ValueName`)).toBe('Mode');
    expect(await run(l.dc, `Get-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName Absent`)).toMatch(/The following Group Policy registry setting was not found/i);
  });

  it("Remove-GPRegistryValue retire la valeur, et gpupdate la retire du poste", async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    expect(await mode(l.client)).toContain('un');
    await run(l.dc, `Remove-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName Mode`);
    expect(await mode(l.client)).not.toMatch(/REG_SZ\s+un\b/);
  });

  it('supprimer la GPO retire sa valeur du registre du poste', async () => {
    const l = await lab();
    await gpo(l.dc, 'Lab', POSTES, 'un');
    await joinIn(l, POSTES);
    expect(await mode(l.client)).toContain('un');
    await run(l.dc, 'Remove-GPO -Name "Lab"');
    expect(await mode(l.client)).not.toMatch(/REG_SZ\s+un\b/);
  });

  it("une clé hors Policies reste en place après le retrait de la GPO", async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    await run(l.dc, 'Set-GPRegistryValue -Name "Lab" -Key "HKLM\\SOFTWARE\\LabApp" -ValueName Mode -Type String -Value "reste"');
    await run(l.dc, `New-GPLink -Name "Lab" -Target "${POSTES}"`);
    await joinIn(l, POSTES);
    await l.client.executeCmdCommand('gpupdate /force');
    await run(l.dc, 'Remove-GPO -Name "Lab"');
    await l.client.executeCmdCommand('gpupdate /force');
    expect(await l.client.executeCmdCommand('reg query "HKLM\\SOFTWARE\\LabApp" /v Mode')).toContain('reste');
  });

  it('Set-GPRegistryValue refuse un type inconnu, une clé hors HKLM/HKCU et un DWord non numérique', async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    expect(await run(l.dc, `Set-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName A -Type Texte -Value 1`)).toMatch(/Specify one of the following enumerator names.*DWord/);
    expect(await run(l.dc, 'Set-GPRegistryValue -Name "Lab" -Key "HKCR\\Lab" -ValueName A -Type String -Value 1')).toMatch(/not under HKEY_LOCAL_MACHINE or HKEY_CURRENT_USER/);
    expect(await run(l.dc, `Set-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName A -Type DWord -Value abc`)).toMatch(/not valid for type DWord/);
    expect(await run(l.dc, `Get-GPRegistryValue -Name "Lab" -Key "${KEY}"`)).toMatch(/The following Group Policy registry setting was not found/i);
  });

  it('un type écrit en minuscules est rangé sous son nom canonique', async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    await run(l.dc, `Set-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName N -Type dword -Value 7`);
    expect(await run(l.dc, `(Get-GPRegistryValue -Name "Lab" -Key "${KEY}" -ValueName N).Type`)).toBe('DWord');
  });

  it("New-GPLink refuse une valeur d'énumération qui n'est ni Yes ni No", async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    expect(await run(l.dc, `New-GPLink -Name "Lab" -Target "${SIEGE}" -Enforced Maybe`)).toMatch(/Specify one of the following enumerator names and try again: No, Yes/);
    expect(await run(l.dc, `(Get-GPInheritance -Target "${SIEGE}").GpoLinks`)).not.toContain('Lab');
  });

  it("un lien Enforced Yes est accepté", async () => {
    const l = await lab();
    await run(l.dc, 'New-GPO -Name "Lab"');
    expect(await run(l.dc, `New-GPLink -Name "Lab" -Target "${SIEGE}" -Enforced Yes`)).toBe('');
  });

  it("Set-GPInheritance refuse une valeur qui n'est ni Yes ni No", async () => {
    const l = await lab();
    expect(await run(l.dc, `Set-GPInheritance -Target "${SIEGE}" -IsBlocked Peut-etre`)).toMatch(/Cannot convert value/);
  });

  it("-Domain d'un autre domaine est refusé au lieu d'être ignoré", async () => {
    const l = await lab();
    expect(await run(l.dc, 'New-GPO -Name "Lab" -Domain "autre.lab"')).toMatch(/cannot be reached/i);
    expect(await run(l.dc, 'Get-GPO -Name "Lab"')).toMatch(/cannot be found/i);
    expect(await run(l.dc, `New-GPO -Name "Ok" -Domain "corp.lab"`)).not.toMatch(/cannot be reached/i);
  });

  it('Remove-GPO ne touche pas aux liens des autres GPO', async () => {
    const l = await lab();
    await gpo(l.dc, 'Garde', ROOT);
    await gpo(l.dc, 'Jetee', POSTES);
    await run(l.dc, 'Remove-GPO -Name "Jetee"');
    expect(await run(l.dc, `(Get-GPInheritance -Target "${ROOT}").GpoLinks`)).toContain('Garde');
  });
});
