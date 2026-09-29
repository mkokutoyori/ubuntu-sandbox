/*
 * Probe — `Unlock-ADAccount` et `Set-ADAccountControl`, et le KDC qui les
 * rend observables.
 *
 * Mesure d'origine : les deux cmdlets etaient inconnues. Pire, le verrouillage
 * n'avait aucun effet : cinq mots de passe faux posaient `lockoutTime`, mais
 * le KDC ne le lisait jamais — un compte verrouille, ou desactive, obtenait
 * un TGT avec le bon mot de passe. Un critere stocke sans etre evalue (regle
 * 6) : Unlock-ADAccount n'aurait eu rien a debloquer. Le KDC refuse donc
 * maintenant KDC_ERR_CLIENT_REVOKED (RFC 4120 §7.5.9, code 18, « clients
 * credentials have been revoked ») pour un compte verrouille ou desactive.
 * Defaut voisin ferme dans le meme changement : `Disable-ADAccount` et
 * `Enable-ADAccount` reecrivaient tout userAccountControl (`NORMAL_ACCOUNT`
 * seul), effacant `PasswordNeverExpires` ; ils ne touchent plus que le bit
 * ACCOUNTDISABLE.
 *
 * Autorite : PowerShell ActiveDirectory `Unlock-ADAccount -Identity` (efface
 * lockoutTime), `Set-ADAccountControl -Enabled|-PasswordNeverExpires|
 * -PasswordNotRequired|-CannotChangePassword|-AccountNotDelegated|
 * -AllowReversiblePasswordEncryption|-TrustedForDelegation|
 * -DoesNotRequirePreAuth` (bits de userAccountControl, MS-ADTS §2.2.16) ;
 * DONT_REQ_PREAUTH permet a un AS-REQ sans PA-DATA d'aboutir (RFC 4120
 * §5.2.7.2 rend le pre-auth optionnel par principal). Les quatre autres
 * parametres du cmdlet reel (HomedirRequired, MNSLogonAccount,
 * TrustedToAuthForDelegation, UseDESKeyOnly) sont REFUSES en nommant la
 * brique absente : aucun chemin de logon ne les lit, S4U2Self et DES n'existent
 * pas dans ce KDC.
 *
 * Mesure avant le correctif (git stash de src/network/devices,
 * src/network/kerberos/KdcSession.ts et src/powershell, l'enum
 * KDC_ERR_CLIENT_REVOKED conservee : sans elle, `errorCode` attendu vaudrait
 * `undefined` et un succes le satisferait a tort) : 9 des 12 cas tombent.
 *
 * Politique de verrouillage : le seuil etait un 5 code en dur dans le magasin
 * alors que `Set-ADDefaultDomainPasswordPolicy -LockoutThreshold|-LockoutDuration|
 * -LockoutObservationWindow` etaient acceptes et rendus par
 * `Get-ADDefaultDomainPasswordPolicy` sans que rien ne les lise — encore un
 * critere stocke sans etre evalue. Le KDC lit maintenant la politique
 * RESULTANTE du compte (le PSO qui s'applique, sinon la politique du domaine,
 * champ par champ) : seuil 0 = jamais de verrou ; duree 0 = verrou jusqu'a
 * Unlock-ADAccount ; sinon le verrou tombe seul apres la duree ; un compteur
 * plus vieux que la fenetre d'observation repart de zero. Le tout sur
 * l'horloge simulee du DC (`advanceTime`), pas sur l'heure murale.
 * Les sept cas « lockout policy » : 5 tombent contre le commit precedent
 * (seuil fixe, verrou sans expiration) ; passent des deux cotes « une duree de
 * zero garde le verrou » et « dans la fenetre, les echecs se cumulent » —
 * GARDES : l'ancien comportement les satisfaisait, ils empechent le nouveau de
 * lever un verrou trop tot.
 *
 * Passent des deux cotes, et pourquoi :
 *  - « TEMOIN : un compte sain obtient un TGT » — le lab, le KDC et le
 *    client sont sains, donc un refus mesure le verrou et non un reseau mort.
 *  - « le pre-auth reste exige sans le drapeau » — NON-REGRESSION : la
 *    porte que DoesNotRequirePreAuth ouvre reste fermee par defaut.
 *  - « un deverrouillage remet aussi le compteur a zero » — GARDE du
 *    correctif : avant, le KDC ignorait le verrou et ce cas ne pouvait pas
 *    tomber ; apres, il tomberait si Unlock laissait badPwdCount a 5.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { encodeKdcReq, isKrbError, decodeKrbError } from '@/network/kerberos/codec';
import { principalName, PrincipalNameType, KrbErrorCode } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const run = async (d: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');

interface Lab { dc: WindowsServer; client: LinuxServer }

async function lab(): Promise<Lab> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.50.20'), mask);
  dc.setCurrentUser('Administrator');
  await run(dc, 'Install-WindowsFeature AD-Domain-Services');
  await run(dc, 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(dc, 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -Enabled $true -PasswordNeverExpires $true');
  return { dc, client };
}

function asExchange(client: LinuxServer, password: string) {
  const conn = dialKdc(client.getTcpStack(), '192.168.50.10');
  return conn.client!.asExchange('alice', password, 'LAB.LOCAL');
}

function lockOut(client: LinuxServer): void {
  for (let attempt = 0; attempt < 5; attempt++) asExchange(client, 'wrongpassword');
}

function rawAsReqWithoutPreAuth(client: LinuxServer): Uint8Array {
  const socket = client.getTcpStack().connect('192.168.50.10', 88);
  let reply: Uint8Array | null = null;
  socket!.onData((data) => { if (data instanceof Uint8Array) reply = data; });
  socket!.send(encodeKdcReq({
    msgType: 'AS-REQ', padata: [],
    reqBody: {
      kdcOptions: 0,
      cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
      realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
      till: Math.floor(Date.now() / 1000) + 3600,
      nonce: 4242,
      etype: [18],
    },
  }));
  if (reply === null) throw new Error('the KDC did not answer the raw AS-REQ');
  return reply;
}

describe('Unlock-ADAccount / Set-ADAccountControl on the KDC', () => {
  it('TEMOIN : un compte sain obtient un TGT', async () => {
    const { client } = await lab();
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('cinq mots de passe faux verrouillent le compte : le bon mot de passe est refuse', async () => {
    const { client } = await lab();
    lockOut(client);
    const result = asExchange(client, 'alicepw');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
  });

  it('Unlock-ADAccount rend le compte utilisable', async () => {
    const { dc, client } = await lab();
    lockOut(client);
    expect(await run(dc, '(Search-ADAccount -LockedOut).SamAccountName')).toContain('alice');
    expect(await run(dc, 'Unlock-ADAccount -Identity alice')).toBe('');
    expect(await run(dc, '(Search-ADAccount -LockedOut).SamAccountName')).not.toContain('alice');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('un déverrouillage remet aussi le compteur de mots de passe faux à zéro', async () => {
    const { dc, client } = await lab();
    lockOut(client);
    await run(dc, 'Unlock-ADAccount -Identity alice');
    for (let attempt = 0; attempt < 4; attempt++) asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('Search-ADAccount -LockedOut | Unlock-ADAccount déverrouille chaque compte listé', async () => {
    const { dc, client } = await lab();
    lockOut(client);
    await run(dc, 'Search-ADAccount -LockedOut | Unlock-ADAccount');
    expect(await run(dc, '(Search-ADAccount -LockedOut).SamAccountName')).not.toContain('alice');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('Unlock-ADAccount nomme le compte introuvable', async () => {
    const { dc } = await lab();
    expect(await run(dc, 'Unlock-ADAccount -Identity nobody')).toMatch(/Cannot find an object with identity: 'nobody'/);
  });

  it('Disable-ADAccount ferme le KDC, Enable-ADAccount le rouvre', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Disable-ADAccount -Identity alice');
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
    await run(dc, 'Enable-ADAccount -Identity alice');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('Set-ADAccountControl -Enabled $false ferme le KDC sans effacer les autres bits', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Set-ADAccountControl -Identity alice -Enabled $false');
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNeverExpires).PasswordNeverExpires')).toBe('True');
    await run(dc, 'Set-ADAccountControl -Identity alice -Enabled $true');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNeverExpires).PasswordNeverExpires')).toBe('True');
  });

  it('Set-ADAccountControl pose et retire les drapeaux, relus par Get-ADUser', async () => {
    const { dc } = await lab();
    await run(dc, 'Set-ADAccountControl -Identity alice -PasswordNeverExpires $false -PasswordNotRequired $true -AccountNotDelegated $true');
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNeverExpires).PasswordNeverExpires')).toBe('False');
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNotRequired).PasswordNotRequired')).toBe('True');
    expect(await run(dc, '(Get-ADUser alice -Properties AccountNotDelegated).AccountNotDelegated')).toBe('True');
    await run(dc, 'Set-ADAccountControl -Identity alice -PasswordNotRequired $false');
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNotRequired).PasswordNotRequired')).toBe('False');
    expect(await run(dc, '(Get-ADUser alice -Properties AccountNotDelegated).AccountNotDelegated')).toBe('True');
  });

  it('le pré-auth reste exigé sans le drapeau', async () => {
    const { client } = await lab();
    const reply = rawAsReqWithoutPreAuth(client);
    expect(isKrbError(reply)).toBe(true);
    expect(decodeKrbError(reply).errorCode).toBe(KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED);
  });

  it('-DoesNotRequirePreAuth $true laisse aboutir un AS-REQ sans PA-DATA', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Set-ADAccountControl -Identity alice -DoesNotRequirePreAuth $true');
    expect(await run(dc, '(Get-ADUser alice -Properties DoesNotRequirePreAuth).DoesNotRequirePreAuth')).toBe('True');
    expect(isKrbError(rawAsReqWithoutPreAuth(client))).toBe(false);
  });

  it('un paramètre que le simulateur ne sait pas évaluer est refusé, avec la brique nommée', async () => {
    const { dc } = await lab();
    expect(await run(dc, 'Set-ADAccountControl -Identity alice -UseDESKeyOnly $true')).toMatch(/DES tickets/);
    expect(await run(dc, 'Set-ADAccountControl -Identity alice -TrustedToAuthForDelegation $true')).toMatch(/S4U2Self/);
    expect(await run(dc, '(Get-ADUser alice -Properties PasswordNeverExpires).PasswordNeverExpires')).toBe('True');
  });
});

describe('lockout policy — duration, observation window, threshold, PSO', () => {
  const minutes = (n: number): number => n * 60_000;

  it('le verrou tombe seul après LockoutDuration (30 minutes par défaut)', async () => {
    const { dc, client } = await lab();
    lockOut(client);
    dc.advanceTime(minutes(29));
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
    expect(await run(dc, '(Search-ADAccount -LockedOut).SamAccountName')).toContain('alice');
    dc.advanceTime(minutes(2));
    expect(await run(dc, '(Search-ADAccount -LockedOut).SamAccountName')).not.toContain('alice');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('une durée de zéro garde le verrou jusqu à Unlock-ADAccount', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Set-ADDefaultDomainPasswordPolicy -Identity lab.local -LockoutDuration (New-TimeSpan -Minutes 0)');
    lockOut(client);
    dc.advanceTime(minutes(60 * 24));
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
    await run(dc, 'Unlock-ADAccount -Identity alice');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('LockoutThreshold est celui de la politique, pas un cinq codé en dur', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Set-ADDefaultDomainPasswordPolicy -Identity lab.local -LockoutThreshold 3');
    asExchange(client, 'wrongpassword');
    asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
  });

  it('un seuil de zéro ne verrouille jamais', async () => {
    const { dc, client } = await lab();
    await run(dc, 'Set-ADDefaultDomainPasswordPolicy -Identity lab.local -LockoutThreshold 0');
    for (let attempt = 0; attempt < 20; attempt++) asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('la fenêtre d observation remet le compteur à zéro', async () => {
    const { dc, client } = await lab();
    for (let attempt = 0; attempt < 4; attempt++) asExchange(client, 'wrongpassword');
    dc.advanceTime(minutes(31));
    asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });

  it('dans la fenêtre, les échecs se cumulent jusqu au verrou', async () => {
    const { dc, client } = await lab();
    for (let attempt = 0; attempt < 4; attempt++) asExchange(client, 'wrongpassword');
    dc.advanceTime(minutes(10));
    asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
  });

  it('une politique fine du compte l emporte sur celle du domaine', async () => {
    const { dc, client } = await lab();
    await run(dc, 'New-ADFineGrainedPasswordPolicy -Name Strict -Precedence 1 -LockoutThreshold 2 -LockoutDuration (New-TimeSpan -Minutes 10) -LockoutObservationWindow (New-TimeSpan -Minutes 10) -MinPasswordLength 8 -ComplexityEnabled $true');
    await run(dc, 'Add-ADFineGrainedPasswordPolicySubject -Identity Strict -Subjects alice');
    asExchange(client, 'wrongpassword');
    asExchange(client, 'wrongpassword');
    expect(asExchange(client, 'alicepw').errorCode).toBe(KrbErrorCode.KDC_ERR_CLIENT_REVOKED);
    dc.advanceTime(minutes(11));
    expect(asExchange(client, 'alicepw').ok).toBe(true);
  });
});
