/**
 * `New-ADUser` applique tout ce qu'il accepte, et un compte neuf est
 * DESACTIVE.
 *
 * Autorite : la documentation du cmdlet prise a sa SOURCE
 * (MicrosoftDocs/windows-powershell-docs, `docset/winserver2025-ps/
 * ActiveDirectory/New-ADUser.md`) pour les parametres et les noms LDAP,
 * et l'article de support de Microsoft sur `userAccountControl`
 * (MicrosoftDocs/SupportArticles-docs) pour la valeur de chaque bit —
 * learn.microsoft.com etant bloque par le mandataire de sortie. Les
 * noms LDAP ne sont donc PAS ecrits de memoire, ce qui importe : la
 * meme propriete ne porte pas le meme nom selon la classe, `-Office`
 * vaut `physicalDeliveryOfficeName`, `-Fax` vaut
 * `facsimileTelephoneNumber`, `-OtherName` vaut `middleName`, et
 * `-StreetAddress` vaut `streetAddress` sur un utilisateur la ou il vaut
 * `street` sur une OU.
 *
 * La documentation declare SOIXANTE-TROIS parametres ; l'implantation
 * de depart en declarait ONZE. Ce que la mesure a trouve :
 *
 *   TRENTE-TROIS proprietes acceptees et JETEES — `Get-ADUser` ne
 *     rendait rien de ce qu'on avait pose, `-UserPrincipalName` compris,
 *     que le cmdlet remplacait par celui qu'il fabrique.
 *   SEPT drapeaux de `userAccountControl` acceptes et jetes
 *     (`-PasswordNotRequired`, `-SmartcardLogonRequired`,
 *     `-TrustedForDelegation`, `-AccountNotDelegated`,
 *     `-AllowReversiblePasswordEncryption`, et les deux deja connus).
 *   `-AccountExpirationDate`, `-ServicePrincipalNames`,
 *     `-OtherAttributes`, `-Instance`, `-ChangePasswordAtLogon`,
 *     `-CannotChangePassword` : acceptes et jetes.
 *   `-PassThru` inverse — la documentation ecrit « By default, this
 *     cmdlet does not generate any output », le cmdlet rendait TOUJOURS
 *     l'objet.
 *   `-WhatIf` creait le compte POUR DE VRAI.
 *
 * DEUX divergences de STRUCTURE sont forcees ici plutot qu'inscrites au
 * `TODO.md`, et c'est le point du lot :
 *
 *   Un compte neuf est DESACTIVE. `-Enabled` n'a pas de valeur par
 *     defaut dans la documentation, et « an enabled account requires a
 *     password » : sur une vraie machine il faut `-Enabled $true`. Le
 *     simulateur creait tout compte actif.
 *   Le CN vient du `-Name`, pas du `-SamAccountName`.
 *     `New-ADUser -Name "Jean Dupont" -SamAccountName "jdupont"` donne
 *     `CN=Jean Dupont`, et le simulateur donnait `CN=jdupont`.
 *
 * L'estimation faite AVANT de forcer etait grossiere — 35 laboratoires
 * sans `-Enabled`, 96 assertions sur un CN — et la mesure APRES l'a
 * corrigee : QUATRE cas sont tombes en tout, sur 149 fichiers. La
 * plupart des laboratoires nomment leur utilisateur comme son compte,
 * donc le CN ne bouge pas ; et presque aucun ne depend d'un compte actif
 * qu'il n'a pas demande. Les quatre encodaient le defaut et sont
 * corriges — l'un attendait une sortie que la vraie machine ne produit
 * pas, les deux autres cherchaient le sAMAccountName dans un DN ou une
 * vraie machine ecrit le nom.
 *
 * `CannotChangePassword` n'est PAS un bit de `userAccountControl` : le
 * meme article de Microsoft ecrit que `PASSWD_CANT_CHANGE` « can't be
 * assigned by directly modifying the UserAccountControl attribute »
 * et que « it's a permission on the user's object ». C'est donc une ACE,
 * ecrite avec la machinerie posee pour la protection des OU.
 *
 * Discrimine par `git stash` : 17 cas sur 24 tombent avant correctif.
 * Les 7 autres sont nommes plutot que laisses a decouvrir, et TROIS
 * d'entre eux passaient pour une raison qui ne prouve rien :
 *   - le TEMOIN, le nom obligatoire, le doublon, le chemin introuvable
 *     et `-Enabled $true` etaient DEJA justes ;
 *   - « un drapeau non demande reste faux » et « sans
 *     -AccountExpirationDate le compte n'expire pas » passaient a VIDE,
 *     puisque AUCUN drapeau et AUCUNE expiration n'etaient jamais poses ;
 *     ils ne deviennent des preuves qu'une fois l'ecriture posee, dont
 *     ils gardent l'autre cote ;
 *   - « rend l'objet avec -PassThru » passait parce que le cmdlet
 *     rendait TOUJOURS l'objet.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const PWD = '-AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force)';

async function controleur() {
  const dc = new WindowsServer('DC01');
  dc.powerOn();
  const ps = PowerShellSubShell.create(dc).subShell;
  const run = async (l: string) => (await ps.processLine(l)).output.join('\n').trim();
  await run('Install-WindowsFeature -Name AD-Domain-Services');
  await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
  return { dc, run };
}

describe('New-ADUser — les proprietes sont posees', () => {
  it('les proprietes d\'identite et d\'adresse sont conservees et relues', async () => {
    const { run } = await controleur();
    await run('New-ADUser -Name "Marie Kouam" -SamAccountName "mkouam" -GivenName "Marie" -Surname "Kouam"'
      + ' -Initials "MK" -OtherName "Nadege" -Description "Analyste" -DisplayName "M. Kouam"'
      + ` -City "Douala" -Country "CM" -State "Littoral" -StreetAddress "rue 1" -POBox "BP 1" -PostalCode "0001" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "mkouam" | Format-List GivenName, Surname, Initials,'
      + ' OtherName, Description, City, Country, State, StreetAddress, POBox, PostalCode');
    for (const attendu of ['Marie', 'Kouam', 'MK', 'Nadege', 'Analyste', 'Douala', 'CM', 'Littoral', 'rue 1', 'BP 1', '0001']) {
      expect(vue).toContain(attendu);
    }
  });

  it('les proprietes d\'organisation et de contact sont conservees', async () => {
    const { run } = await controleur();
    await run('New-ADUser -Name "u1" -SamAccountName "u1" -Company "ACME" -Division "Div" -Department "IT"'
      + ' -Title "Chef" -Office "Douala" -OfficePhone "+237 1" -MobilePhone "+237 2" -HomePhone "+237 3"'
      + ` -Fax "+237 4" -EmployeeID "E1" -EmployeeNumber "N1" -Organization "Org" -HomePage "http://x" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "u1" | Format-List Company, Division, Department, Title,'
      + ' Office, OfficePhone, MobilePhone, HomePhone, Fax, EmployeeID, EmployeeNumber, Organization, HomePage');
    for (const attendu of ['ACME', 'Div', 'IT', 'Chef', 'Douala', '+237 1', '+237 2', '+237 3', '+237 4', 'E1', 'N1', 'Org', 'http://x']) {
      expect(vue).toContain(attendu);
    }
  });

  it('les chemins d\'ouverture de session sont conserves', async () => {
    const { run } = await controleur();
    await run('New-ADUser -Name "u2" -SamAccountName "u2" -ProfilePath "\\\\srv\\profils\\u2"'
      + ` -HomeDirectory "\\\\srv\\home\\u2" -HomeDrive "H:" -ScriptPath "logon.bat" -LogonWorkstations "PC1,PC2" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "u2" | Format-List ProfilePath, HomeDirectory, HomeDrive, ScriptPath, LogonWorkstations');
    for (const attendu of ['profils', 'home', 'H:', 'logon.bat', 'PC1,PC2']) expect(vue).toContain(attendu);
  });

  it('-UserPrincipalName l\'emporte sur celui que le domaine fabrique', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "u3" -SamAccountName "u3" -UserPrincipalName "marie.kouam@corp.local" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "u3").UserPrincipalName')).toBe('marie.kouam@corp.local');
  });

  it('-Manager designe un autre compte', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "chef" -SamAccountName "chef" ${PWD}`);
    await run(`New-ADUser -Name "agent" -SamAccountName "agent" -Manager "chef" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "agent").Manager')).toBe('chef');
  });

  it('-OtherAttributes pose un attribut que les parametres ne couvrent pas', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "u4" -SamAccountName "u4" -OtherAttributes @{ pager = "1234" } ${PWD}`);
    expect(await run('(Get-ADUser -Identity "u4").pager')).toBe('1234');
  });

  it('-Instance sert de gabarit, et un parametre explicite l\'emporte', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "modele" -SamAccountName "modele" -Department "IT" -City "Douala" ${PWD}`);
    await run(`$m = Get-ADUser -Identity "modele"; New-ADUser -Name "copie" -SamAccountName "copie" -Instance $m -City "Yaounde" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "copie" | Format-List Department, City');
    expect(vue).toContain('IT');
    expect(vue).toContain('Yaounde');
  });
});

describe('New-ADUser — les drapeaux de userAccountControl', () => {
  it('les cinq drapeaux jetes sont desormais poses', async () => {
    const { run } = await controleur();
    await run('New-ADUser -Name "d1" -SamAccountName "d1" -PasswordNotRequired $true -SmartcardLogonRequired $true'
      + ` -TrustedForDelegation $true -AccountNotDelegated $true -AllowReversiblePasswordEncryption $true ${PWD}`);
    const vue = await run('Get-ADUser -Identity "d1" | Format-List PasswordNotRequired, SmartcardLogonRequired,'
      + ' TrustedForDelegation, AccountNotDelegated, AllowReversiblePasswordEncryption');
    expect(vue.match(/True/g) ?? []).toHaveLength(5);
  });

  it('un drapeau non demande reste faux', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "d2" -SamAccountName "d2" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "d2" | Format-List PasswordNotRequired, SmartcardLogonRequired, TrustedForDelegation');
    expect(vue).not.toContain('True');
  });

  it('-ChangePasswordAtLogon met pwdLastSet a zero', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "d3" -SamAccountName "d3" -ChangePasswordAtLogon $true ${PWD}`);
    expect(await run('(Get-ADUser -Identity "d3").ChangePasswordAtLogon')).toBe('True');
  });

  it('-CannotChangePassword s\'ecrit en Deny explicites, pas en bit UAC', async () => {
    const { dc, run } = await controleur();
    await run(`New-ADUser -Name "d4" -SamAccountName "d4" -CannotChangePassword $true ${PWD}`);
    expect(await run('(Get-ADUser -Identity "d4").CannotChangePassword')).toBe('True');
    const acl = dc.getDirectoryStore()!.getAcl('CN=d4,CN=Users,DC=corp,DC=local') ?? [];
    const deny = acl.filter(a => a.accessControlType === 'Deny' && a.rights === 'ExtendedRight');
    expect(deny.map(a => a.identitySam).sort()).toEqual(['Everyone', 'NT AUTHORITY\\SELF']);
  });

  it('-AccountExpirationDate est conservee', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "d5" -SamAccountName "d5" -AccountExpirationDate "2027-01-01" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "d5").AccountExpirationDate')).toContain('2027');
  });

  it('sans -AccountExpirationDate le compte n\'expire pas', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "d6" -SamAccountName "d6" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "d6").AccountExpirationDate')).toBe('');
  });

  it('-ServicePrincipalNames est conserve', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "d7" -SamAccountName "d7" -ServicePrincipalNames "HTTP/web.corp.local" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "d7").ServicePrincipalNames')).toContain('HTTP/web.corp.local');
  });
});

describe('New-ADUser — un compte neuf est DESACTIVE', () => {
  it('sans -Enabled, le compte est desactive', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "n1" -SamAccountName "n1" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "n1").Enabled')).toBe('False');
  });

  it('-Enabled $true active le compte', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "n2" -SamAccountName "n2" -Enabled $true ${PWD}`);
    expect(await run('(Get-ADUser -Identity "n2").Enabled')).toBe('True');
  });
});

describe('New-ADUser — le CN vient du -Name', () => {
  it('un nom distinct du compte donne le CN du nom', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "Jean Dupont" -SamAccountName "jdupont" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "jdupont").DistinguishedName'))
      .toBe('CN=Jean Dupont,CN=Users,DC=corp,DC=local');
  });

  it('-Path place le compte dans le conteneur nomme', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Personnel" -ProtectedFromAccidentalDeletion $false');
    await run(`New-ADUser -Name "Paul Nkomo" -SamAccountName "pnkomo" -Path "OU=Personnel,DC=corp,DC=local" ${PWD}`);
    expect(await run('(Get-ADUser -Identity "pnkomo").DistinguishedName'))
      .toBe('CN=Paul Nkomo,OU=Personnel,DC=corp,DC=local');
  });
});

describe('New-ADUser — sortie et essai', () => {
  it('ne rend RIEN sans -PassThru', async () => {
    const { run } = await controleur();
    expect(await run(`New-ADUser -Name "m1" -SamAccountName "m1" ${PWD}`)).toBe('');
  });

  it('rend l\'objet avec -PassThru', async () => {
    const { run } = await controleur();
    const sortie = await run(`New-ADUser -Name "m2" -SamAccountName "m2" -PassThru ${PWD}`);
    expect(sortie).toContain('m2');
    expect(sortie).toContain('CN=m2,CN=Users,DC=corp,DC=local');
  });

  it('-WhatIf annonce l\'operation sans creer le compte', async () => {
    const { run } = await controleur();
    const sortie = await run(`New-ADUser -Name "m3" -SamAccountName "m3" -WhatIf ${PWD}`);
    expect(sortie).toContain('What if:');
    expect(await run('Get-ADUser -Identity "m3"')).toContain('Cannot find an object');
  });
});

describe('New-ADUser — ce qui etait deja juste', () => {
  it('TEMOIN — une creation nominale reste une creation', async () => {
    const { run } = await controleur();
    await run(`New-ADUser -Name "temoin" -SamAccountName "temoin" ${PWD}`);
    const vue = await run('Get-ADUser -Identity "temoin"');
    expect(vue).toContain('temoin@corp.local');
    expect(vue).toContain('Domain Users');
  });

  it('le nom est obligatoire, et un doublon est refuse', async () => {
    const { run } = await controleur();
    expect(await run('New-ADUser')).toContain('missing mandatory parameters');
    await run(`New-ADUser -Name "dup" -SamAccountName "dup" ${PWD}`);
    expect(await run(`New-ADUser -Name "dup" -SamAccountName "dup" ${PWD}`)).toContain('already exists');
  });

  it('un chemin introuvable est refuse', async () => {
    const { run } = await controleur();
    expect(await run(`New-ADUser -Name "x" -SamAccountName "x" -Path "OU=Nexistepas,DC=corp,DC=local" ${PWD}`))
      .toContain('Cannot find an object');
  });
});
