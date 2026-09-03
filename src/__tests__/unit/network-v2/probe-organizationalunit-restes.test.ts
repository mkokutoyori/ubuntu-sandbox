/**
 * Les quatre manquements que le lot `New-ADOrganizationalUnit` avait
 * INSCRITS au `TODO.md` plutot que fermes, fermes ici sur consigne
 * — « il faut toujours forcer voire faire une refonte ».
 *
 * (1) `-Server` / `-AuthType` etaient absents parce qu'« aucun chemin
 *     d'objet ne dialogue avec un contrôleur distant ». C'etait vrai du
 *     chemin, pas du DEPOT : `LdapClient` sait `add`/`modify`/`delete`,
 *     `dialLdap` ouvre une vraie connexion TCP/389, et `LdapServer`
 *     ecoute deja sur tout contrôleur promu. Le cmdlet compose donc pour
 *     de vrai, et ce cas le verifie la ou cela se voit : l'OU est creee
 *     depuis une AUTRE machine et relue sur le contrôleur.
 *
 * (2) `-Instance` en entree de PIPELINE. Le mecanisme manquait au
 *     MOTEUR, pas au cmdlet : `dispatchCmdlet` passait `pipeInput` brut
 *     et rien ne liait ses proprietes aux parametres declares.
 *     `ICmdlet.pipelineByPropertyName` est la declaration, et le
 *     fan-out vit dans le moteur — donc une seule ecriture pour tous les
 *     cmdlets, et un cmdlet qui lit `ctx.pipeInput` lui-meme n'est pas
 *     concerne. `Import-Csv` manquait aussi : le module savait ECRIRE un
 *     CSV (`Export-Csv`, `ConvertTo-Csv`) et ne savait pas relire un
 *     FICHIER, moitie de mecanisme que ce lot referme en partageant la
 *     logique de lignes du `ConvertFrom-Csv` qui existait deja.
 *
 * (3) `-Properties` etait declare par QUATRE vues et evalue par AUCUNE.
 *     Il l'est desormais par les quatre, avec un jeu par defaut declare
 *     une fois par classe. Les noms du jeu de l'OU sont ATTESTES par
 *     deux sources : l'exemple 2 de la documentation du cmdlet tabule
 *     `Name, Country, PostalCode, City, StreetAddress, State` SANS
 *     `-Properties`, et l'article TechNet « Get-ADOrganizationalUnit
 *     Default and Extended Properties » donne `LinkedGroupPolicyObjects,
 *     ManagedBy, Name, ObjectClass, PostalCode`. Ceux du jeu de
 *     l'utilisateur viennent de l'exemple 3 de `Get-ADUser`. La
 *     consequence a garder est que `Description` n'est PAS dans le jeu
 *     par defaut d'une OU — c'est la question posee mille fois.
 *
 * (4) Un attribut pose par `-OtherAttributes` revenait en MINUSCULES.
 *     L'arbre LDAP normalise ses clefs, ce qui est juste (les noms
 *     d'attributs sont insensibles a la casse), mais la casse canonique
 *     etait PERDUE. `DirectoryTree` retient desormais la premiere
 *     orthographe vue, au seul point ou il normalise.
 *
 * Trouve et corrige en chemin, sur signalement : j'avais ecrit
 * `/^\d+\.\d+\.\d+\.\d+$/` pour reconnaitre une adresse litterale dans
 * `-Server`. Ce motif accepte `999.999.999.999`. La regle du depot est
 * qu'une adresse est un `IPAddress` et jamais une chaine :
 * `IPAddress.tryParse` valide ET rend la forme canonique, et c'est lui
 * qui decide.
 *
 * Refonte faite en chemin : `DomainJoinClient` et `DomainLogonClient`
 * portaient MOT POUR MOT la meme sequence Kerberos → LDAP (TGT, TGS,
 * AP-REQ, bind SASL). `bindLdapWithKerberos` est desormais la seule
 * ecriture, et le chemin `-Server` la lit au lieu d'inventer un blob
 * GSSAPI — ce qu'une premiere version faisait, et qu'aucun serveur reel
 * n'aurait accepte.
 *
 * Discrimine par `git stash` : 10 cas sur 12 tombent avant correctif. Les
 * 2 autres sont nommes plutot que laisses a decouvrir : le TEMOIN de
 * joignabilite, dont c'est l'objet de passer des deux cotes, et
 * « -Properties Description l'ajoute » qui passait a VIDE, la vue rendant
 * TOUT quoi qu'on demande — il ne devient une preuve qu'une fois le jeu
 * par defaut pose, dont il garde l'autre cote.
 *
 * Une premiere version de ce fichier annoncait 9 cas tombants et le cas
 * de la CASSE en faisait partie a tort : il cherchait `postOfficeBox`
 * dans un `Format-List postOfficeBox`, ou l'etiquette vient du nom
 * DEMANDE et non du nom STOCKE, donc il passait des deux cotes sans rien
 * prouver. Il lit desormais `-Properties *`, qui rend les noms tels que
 * l'annuaire les porte.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const LIBRE = '-ProtectedFromAccidentalDeletion $false';

function shell(dev: WindowsServer) {
  const ps = PowerShellSubShell.create(dev).subShell;
  return async (l: string) => (await ps.processLine(l)).output.join('\n').trim();
}

async function controleur() {
  const dc = new WindowsServer('DC01');
  dc.powerOn();
  const run = shell(dc);
  await run('Install-WindowsFeature -Name AD-Domain-Services');
  await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
  return { dc, run };
}

async function deuxMachines() {
  const sw = new GenericSwitch('switch-generic', 'SW1');
  sw.powerOn();
  const dc = new WindowsServer('DC01');
  const membre = new WindowsServer('SRV2');
  dc.powerOn();
  membre.powerOn();
  dc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), SubnetMask.fromCIDR(24));
  membre.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), SubnetMask.fromCIDR(24));
  new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(membre.getPorts()[0], sw.getPorts()[1]);
  const runDc = shell(dc);
  const runM = shell(membre);
  await runDc('Install-WindowsFeature -Name AD-Domain-Services');
  await runDc('Install-ADDSForest -DomainName "corp.local" -Force '
    + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P" -AsPlainText -Force)');
  await runM('Install-WindowsFeature -Name AD-Domain-Services');
  return { dc, membre, runDc, runM };
}

describe('-Server compose avec un contrôleur distant, pour de vrai', () => {
  it('TEMOIN — les deux machines se joignent', async () => {
    const { membre } = await deuxMachines();
    expect(String(await membre.executeCommand('ping 10.0.0.10'))).toContain('Minimum =');
  });

  it('une OU creee depuis une AUTRE machine parait sur le contrôleur', async () => {
    const { runDc, runM } = await deuxMachines();
    const sortie = await runM('New-ADOrganizationalUnit -Name "Distante" -Path "DC=corp,DC=local"'
      + ` -Server "10.0.0.10" -AuthType Basic -Credential "Administrator:P" ${LIBRE}`);
    expect(sortie).toBe('');
    expect(await runDc('(Get-ADOrganizationalUnit -Identity "Distante").DistinguishedName'))
      .toBe('OU=Distante,DC=corp,DC=local');
  });

  it('un mauvais mot de passe est refuse par le contrôleur', async () => {
    const { runM, runDc } = await deuxMachines();
    expect(await runM('New-ADOrganizationalUnit -Name "Refusee" -Path "DC=corp,DC=local"'
      + ` -Server "10.0.0.10" -AuthType Basic -Credential "Administrator:faux" ${LIBRE}`))
      .toContain('credential is invalid');
    expect(await runDc('Get-ADOrganizationalUnit -Identity "Refusee"')).toContain('Cannot find an object');
  });

  it('Set- et Remove- composent aussi a distance', async () => {
    const { runDc, runM } = await deuxMachines();
    const cred = '-Server "10.0.0.10" -AuthType Basic -Credential "Administrator:P"';
    await runM(`New-ADOrganizationalUnit -Name "Distante" -Path "DC=corp,DC=local" ${cred} ${LIBRE}`);
    await runM(`Set-ADOrganizationalUnit -Identity "OU=Distante,DC=corp,DC=local" -Description "posee a distance" ${cred}`);
    expect(await runDc('(Get-ADOrganizationalUnit -Identity "Distante" -Properties Description).Description'))
      .toBe('posee a distance');
    expect(await runM(`Remove-ADOrganizationalUnit -Identity "OU=Distante,DC=corp,DC=local" ${cred}`)).toBe('');
    expect(await runDc('Get-ADOrganizationalUnit -Identity "Distante"')).toContain('Cannot find an object');
  });

  it('un serveur injoignable le dit', async () => {
    const { runM } = await deuxMachines();
    expect(await runM(`New-ADOrganizationalUnit -Name "X" -Path "DC=corp,DC=local" -Server "10.0.0.99" ${LIBRE}`))
      .toContain('Unable to contact the server');
  });
});

describe('le pipeline lie les proprietes aux parametres', () => {
  it('un objet passe dans le tuyau cree l\'OU avec ses proprietes', async () => {
    const { run } = await controleur();
    expect(await run(`[pscustomobject]@{ Name = "Direction"; City = "Douala" } | New-ADOrganizationalUnit ${LIBRE}`)).toBe('');
    const vue = await run('Get-ADOrganizationalUnit -Identity "Direction" | Format-List Name, City');
    expect(vue).toContain('Direction');
    expect(vue).toContain('Douala');
  });

  it('Import-Csv relit un fichier et cree une OU par ligne', async () => {
    const { run } = await controleur();
    await run('Set-Content -Path C:\\ous.csv -Value "Name,Description`nVentes,Service commercial`nAchats,Service achats"');
    expect((await run('Import-Csv C:\\ous.csv | Format-Table Name, Description'))).toContain('Service commercial');
    expect(await run(`Import-Csv C:\\ous.csv | New-ADOrganizationalUnit ${LIBRE}`)).toBe('');
    const vue = await run('Get-ADOrganizationalUnit -Filter * -Properties Description | Format-Table Name, Description');
    expect(vue).toContain('Ventes');
    expect(vue).toContain('Achats');
    expect(vue).toContain('Service achats');
  });

  it('Export-Csv puis Import-Csv rendent les memes lignes', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Aller" -City "Douala" ${LIBRE}`);
    await run('Get-ADOrganizationalUnit -Filter * | Select-Object Name, City | Export-Csv -Path C:\\ret.csv -NoTypeInformation');
    expect(await run('(Import-Csv C:\\ret.csv | Where-Object { $_.Name -eq "Aller" }).City')).toBe('Douala');
  });
});

describe('-Properties gouverne ce que la vue rend', () => {
  it('Description n\'est PAS dans le jeu par defaut d\'une OU', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "OU1" -Description "invisible" -City "Douala" ${LIBRE}`);
    const defaut = await run('Get-ADOrganizationalUnit -Identity "OU1"');
    expect(defaut).toContain('Douala');
    expect(defaut).not.toContain('invisible');
  });

  it('-Properties Description l\'ajoute, -Properties * rend tout', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "OU1" -Description "visible" -DisplayName "aff" ${LIBRE}`);
    expect(await run('Get-ADOrganizationalUnit -Identity "OU1" -Properties Description')).toContain('visible');
    const tout = await run('Get-ADOrganizationalUnit -Identity "OU1" -Properties *');
    expect(tout).toContain('visible');
    expect(tout).toContain('aff');
  });

  it('le jeu par defaut d\'un utilisateur ne porte pas son service', async () => {
    const { run } = await controleur();
    await run('New-ADUser -Name "Marie" -SamAccountName "marie" -Department "IT" -GivenName "Marie"'
      + ' -AccountPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)');
    const defaut = await run('Get-ADUser -Identity "marie"');
    expect(defaut).toContain('Marie');
    expect(defaut).not.toContain('IT');
    expect(await run('Get-ADUser -Identity "marie" -Properties Department')).toContain('IT');
  });
});

describe('un attribut libre garde sa casse', () => {
  it('-OtherAttributes revient dans la casse ecrite', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "OU1" -OtherAttributes @{ postOfficeBox = "BP 42" } ${LIBRE}`);
    const tout = await run('Get-ADOrganizationalUnit -Identity "OU1" -Properties *');
    expect(tout).toContain('postOfficeBox');
    expect(tout).not.toContain('postofficebox');
  });
});
