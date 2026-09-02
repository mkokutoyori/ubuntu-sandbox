/**
 * `Install-ADDSForest` applique les parametres qu'il accepte.
 *
 * Autorite : la documentation Microsoft du cmdlet, prise a sa SOURCE
 * (MicrosoftDocs/windows-powershell-docs, `docset/winserver2025-ps/
 * ADDSDeployment/Install-ADDSForest.md`), learn.microsoft.com etant
 * inatteignable depuis ce reseau. Ce qu'elle dit et que la mesure a
 * trouve non applique :
 *
 *   -DomainNetbiosName : « single label names of 15 characters or less »,
 *     et « if the name value given for this parameter is a name of 16
 *     characters or more, then the forest installation fails ». Mesure :
 *     un nom de 17 caracteres etait ACCEPTE et la foret creee avec.
 *   -WhatIf : mesure sur un serveur NEUF, la foret etait creee POUR DE
 *     VRAI — une commande d'essai promouvait la machine.
 *   -DomainMode / -ForestMode : acceptes et JETES, la machine rendant
 *     toujours 2016. Et le niveau de foret etait rendu « Windows Server
 *     2016 », chaine qu'aucune vraie machine n'ecrit : `Get-ADForest`
 *     rend `Windows2016Forest`.
 *   « The domain functional level cannot be lower than the forest
 *     functional level » : aucune verification.
 *   NOTES : « the IP address for the preferred DNS server for the first
 *     domain controller in the forest is automatically set to the
 *     loopback address of 127.0.0.1 ». Mesure : aucun serveur DNS pose.
 *
 * Deux mesures de la premiere passe etaient FAUSSES et le laboratoire en
 * etait la cause, pas le produit : le nom « SEIZECARACTERE » en fait
 * quatorze, et le cas `-WhatIf` reutilisait un serveur deja promu, donc
 * le refus observe etait le bon refus pour une autre raison.
 *
 * Discrimine par `git stash` : 10 cas sur 15 tombent avant correctif.
 * Les 5 autres sont nommes plutot que laisses a decouvrir, et deux
 * d'entre eux passaient pour une raison qui ne prouve rien :
 *   - le TEMOIN de promotion nominale, le NetBIOS deduit du prefixe et
 *     l'installation de DNS par defaut etaient DEJA justes ;
 *   - « accepte un nom NetBIOS de 15 caracteres exactement » passait
 *     parce qu'AUCUNE longueur n'etait verifiee — il ne devient une
 *     preuve qu'une fois la borne posee, dont il garde le bon cote ;
 *   - « la promotion reste possible apres l'essai » passait parce que
 *     `-WhatIf` promouvait pour de vrai, si bien que le domaine existait
 *     deja quand le second appel echouait.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { IPAddress, SubnetMask } from '@/network/core/types';

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';

function laboratoire(name: string, opts: { adresse?: boolean } = {}) {
  const srv = new WindowsServer(name);
  srv.powerOn();
  if (opts.adresse) {
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), SubnetMask.fromCIDR(24));
  }
  const ps = PowerShellSubShell.create(srv).subShell;
  const run = async (line: string) => (await ps.processLine(line)).output.join('\n').trim();
  return { srv, run };
}

async function pret(name: string, opts: { adresse?: boolean } = {}) {
  const lab = laboratoire(name, opts);
  await lab.run('Install-WindowsFeature -Name AD-Domain-Services');
  return lab;
}

describe('Install-ADDSForest — validation des noms', () => {
  it('refuse un nom NetBIOS de plus de 15 caracteres', async () => {
    const { run } = await pret('A1');
    const sortie = await run(`Install-ADDSForest -DomainName "x.local" -DomainNetbiosName "DIXSEPTCARACTERES" -Force ${MDP}`);
    expect('DIXSEPTCARACTERES'.length).toBeGreaterThan(15);
    expect(sortie).toContain('15 characters or less');
    expect(await run('Get-ADDomain')).toContain('Unable to contact the server');
  });

  it('accepte un nom NetBIOS de 15 caracteres exactement', async () => {
    const { run } = await pret('A2');
    expect('QUINZECARACTER5'.length).toBe(15);
    await run(`Install-ADDSForest -DomainName "x.local" -DomainNetbiosName "QUINZECARACTER5" -Force ${MDP}`);
    expect(await run('Get-ADDomain | Select-Object NetBIOSName')).toContain('QUINZECARACTER5');
  });

  it('deduit le nom NetBIOS du prefixe quand il n\'est pas donne', async () => {
    const { run } = await pret('A3');
    await run(`Install-ADDSForest -DomainName "corp.contoso.com" -Force ${MDP}`);
    expect(await run('Get-ADDomain | Select-Object NetBIOSName')).toContain('CORP');
  });
});

describe('Install-ADDSForest — -WhatIf est un essai', () => {
  it('annonce l\'operation sans promouvoir', async () => {
    const { run } = await pret('B1');
    const sortie = await run(`Install-ADDSForest -DomainName "y.local" -WhatIf ${MDP}`);
    expect(sortie).toContain('What if:');
    expect(sortie).toContain('Install-ADDSForest');
    expect(await run('Get-ADDomain')).toContain('Unable to contact the server');
  });

  it('la promotion reste possible apres l\'essai', async () => {
    const { run } = await pret('B2');
    await run(`Install-ADDSForest -DomainName "y.local" -WhatIf ${MDP}`);
    await run(`Install-ADDSForest -DomainName "y.local" -Force ${MDP}`);
    expect(await run('Get-ADDomain | Select-Object DNSRoot')).toContain('y.local');
  });
});

describe('Install-ADDSForest — niveaux fonctionnels', () => {
  it('applique -DomainMode et -ForestMode demandes', async () => {
    const { run } = await pret('C1');
    await run(`Install-ADDSForest -DomainName "z.local" -DomainMode Win2012R2 -ForestMode Win2012R2 -Force ${MDP}`);
    expect(await run('Get-ADDomain | Select-Object DomainMode')).toContain('Windows2012R2Domain');
    expect(await run('Get-ADForest | Select-Object ForestMode')).toContain('Windows2012R2Forest');
  });

  it('accepte la forme entiere documentee', async () => {
    const { run } = await pret('C2');
    await run(`Install-ADDSForest -DomainName "w.local" -ForestMode 5 -Force ${MDP}`);
    expect(await run('Get-ADForest | Select-Object ForestMode')).toContain('Windows2012Forest');
  });

  it('refuse un niveau inconnu en nommant les valeurs admises', async () => {
    const { run } = await pret('C3');
    const sortie = await run(`Install-ADDSForest -DomainName "v.local" -ForestMode Win2099 -Force ${MDP}`);
    expect(sortie).toContain('Win2012R2');
    expect(await run('Get-ADDomain')).toContain('Unable to contact the server');
  });

  it('refuse un domaine plus bas que sa foret', async () => {
    const { run } = await pret('C4');
    const sortie = await run(`Install-ADDSForest -DomainName "u.local" -ForestMode WinThreshold -DomainMode Win2008 -Force ${MDP}`);
    expect(sortie).toContain('cannot be lower than the forest functional level');
    expect(await run('Get-ADDomain')).toContain('Unable to contact the server');
  });

  it('sans niveau demande, la foret est au niveau de la plateforme', async () => {
    const { run } = await pret('C5');
    await run(`Install-ADDSForest -DomainName "t.local" -Force ${MDP}`);
    expect(await run('Get-ADForest | Select-Object ForestMode')).toContain('Windows2016Forest');
    expect(await run('Get-ADDomain | Select-Object DomainMode')).toContain('Windows2016Domain');
  });
});

describe('Install-ADDSForest — ce que la promotion laisse derriere elle', () => {
  it('pointe le client DNS de la machine sur la boucle locale', async () => {
    const { run } = await pret('D1', { adresse: true });
    await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
    const sortie = await run('Get-DnsClientServerAddress | Select-Object InterfaceAlias, ServerAddresses');
    expect(sortie).toContain('127.0.0.1');
  });

  it('cree le repertoire de la base annuaire', async () => {
    const { run } = await pret('D2');
    await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
    expect(await run('Test-Path C:\\Windows\\NTDS')).toBe('True');
  });

  it('honore -DatabasePath', async () => {
    const { run } = await pret('D3');
    await run(`Install-ADDSForest -DomainName "corp.local" -DatabasePath "D:\\NTDS" -Force ${MDP}`);
    expect(await run('Test-Path D:\\NTDS')).toBe('True');
  });

  it('installe le role DNS sans qu\'on le demande', async () => {
    const { run } = await pret('D4');
    await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
    expect(await run('Get-WindowsFeature -Name DNS | Select-Object Name, Installed')).toContain('True');
  });

  it('TEMOIN — une promotion nominale reste une promotion', async () => {
    const { run } = await pret('E1');
    await run(`Install-ADDSForest -DomainName "corp.local" -DomainNetbiosName "CORP" -InstallDns -Force ${MDP}`);
    expect(await run('Get-ADDomain | Select-Object DNSRoot, NetBIOSName')).toContain('corp.local');
    expect(await run('Get-ADDomainController | Select-Object HostName')).toContain('E1.corp.local');
    expect(await run('Get-Service NTDS,ADWS,Netlogon,Kdc | Select-Object Name, Status')).toContain('ADWS');
  });
});
