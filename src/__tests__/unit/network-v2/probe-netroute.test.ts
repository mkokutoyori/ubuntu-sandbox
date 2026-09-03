/**
 * `New`/`Get`/`Remove`/`Set-NetRoute` — la famille entiere etait sur le
 * moteur HISTORIQUE, et treize defauts y tenaient ensemble.
 *
 * Sources. Les quatre pages de `MicrosoftDocs/windows-powershell-docs`
 * (`NetTCPIP/{New,Get,Remove,Set}-NetRoute.md`). Elles donnent la
 * separation que le moteur historique ignorait : `-DestinationPrefix` est
 * en POSITION 0 partout ; `New-NetRoute` a DEUX jeux de parametres
 * (`ByInterfaceAlias`, `ByInterfaceIndex`) et `-NextHop` y est
 * FACULTATIF ; `Get` et `Remove` sont des commandes de REQUETE dont tous
 * les parametres sont des FILTRES au pluriel ; et dans `Set-NetRoute` les
 * parametres au SINGULIER (`-Publish <Publish>`, `-RouteMetric <UInt16>`,
 * `-ValidLifetime <TimeSpan>`, `-PreferredLifetime <TimeSpan>`) sont les
 * VALEURS a poser, tout le reste restant des filtres — donc `Set-NetRoute`
 * ne peut PAS changer le saut suivant, ce que le moteur historique faisait.
 *
 * Ce que la mesure a trouve. `-DestinationPrefix` en position 0 refuse ;
 * `-InterfaceIndex` inconnu ; `-NextHop` exige ; `zorglub` accepte comme
 * prefixe, comme saut suivant et comme interface ; `-WhatIf` CREAIT la
 * route ; tous les filtres de `Get-NetRoute` ignores ; tous ceux de
 * `Remove-NetRoute` sauf `-DestinationPrefix` refuses ; le pipeline
 * refuse ; un prefixe inexistant accepte en silence ; `-PassThru` muet.
 *
 * Le defaut le plus couteux n'etait pourtant aucun de ces treize : le
 * magasin etait indexe par le PREFIXE SEUL, donc deux routes vers un meme
 * reseau par deux sauts differents — une route de secours, un partage de
 * charge — se confondaient, et la seconde etait refusee comme un doublon.
 * C'est le meme defaut que ce depot a referme sur les routes statiques du
 * commutateur Huawei. La cle est desormais l'IDENTITE de la route
 * (`netRouteKey` : prefixe, interface, saut suivant), lue par le
 * fournisseur comme par la commande.
 *
 * Discrimine par `git stash` : 31 des 35 cas tombent avant correctif. Les 4
 * autres sont nommes ici plutot que laisses a decouvrir, chacun avec la
 * raison pour laquelle il ne discrimine pas. Le TEMOIN, dont c'est l'objet
 * de passer des deux cotes. « Remove-NetRoute 0.0.0.0/0 la retire des DEUX
 * vues » et « la passerelle ne parait que sur SON interface » passaient
 * parce que la passerelle n'etait JAMAIS posee — retirer ce qui n'existe
 * pas reussit toujours, et une valeur absente n'apparait sur aucune
 * interface ; c'est leur jumeau « New-NetRoute 0.0.0.0/0 pose la passerelle
 * que Get-NetIPConfiguration montre » qui tombe, et c'est lui qui prouve la
 * paire. Enfin « le meme index nomme la meme interface pour Get-NetAdapter
 * et Get-NetIPAddress » passait parce que les deux vues s'accordaient sur
 * un nombre FAUX : le cas eprouve l'accord, pas la valeur, et c'est son
 * jumeau sur la pseudo-interface de bouclage qui tombe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

async function machine(): Promise<{ pc: WindowsPC; sh: Shell }> {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const sh = PowerShellSubShell.create(pc).subShell;
  await run(sh, 'New-NetIPAddress -IPAddress 10.1.1.1 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
  await run(sh, '$ConfirmPreference = "None"');
  return { pc, sh };
}

const table = async (sh: Shell, filter = '') =>
  run(sh, `Get-NetRoute ${filter} | Format-Table DestinationPrefix,NextHop,RouteMetric,InterfaceAlias`);

describe('New-NetRoute — les deux jeux de parametres et ce qu ils refusent', () => {
  it('TEMOIN : le laboratoire est sain — l adresse est posee et sa route connectee existe', async () => {
    const { sh } = await machine();
    expect(await table(sh, '-DestinationPrefix 10.1.1.0/24')).toContain('10.1.1.0/24');
  });

  it('prend -DestinationPrefix en position 0', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'New-NetRoute 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    expect(out).toContain('192.168.5.0/24');
    expect(await table(sh, '-DestinationPrefix 192.168.5.0/24')).toContain('10.1.1.254');
  });

  it('accepte -InterfaceIndex, le second jeu de parametres', async () => {
    const { sh } = await machine();
    const index = await run(sh, '(Get-NetAdapter -Name "Ethernet 0").ifIndex');
    const out = await run(sh, `New-NetRoute -DestinationPrefix 192.168.6.0/24 -InterfaceIndex ${index} -NextHop 10.1.1.254`);
    expect(out).toContain('Ethernet 0');
  });

  it('rend une route SANS -NextHop, qui est facultatif — le saut est alors non specifie', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'New-NetRoute -DestinationPrefix 192.168.7.0/24 -InterfaceAlias "Ethernet 0"');
    expect(out).toContain('192.168.7.0/24');
    expect(out).toMatch(/NextHop\s+:\s+0\.0\.0\.0/);
  });

  it('refuse un prefixe qui n est pas une adresse', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'New-NetRoute -DestinationPrefix zorglub -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254'))
      .toContain('not a valid IP prefix');
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 999.999.999.999/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254'))
      .toContain('not a valid IP prefix');
  });

  it('refuse un saut suivant qui n est pas une adresse, et un saut d une AUTRE famille', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 192.168.8.0/24 -InterfaceAlias "Ethernet 0" -NextHop zorglub'))
      .toContain('not a valid IP address');
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 2001:db8::/32 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254'))
      .toContain('is not an IPv6 address');
  });

  it('refuse une interface qui n existe pas', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 192.168.9.0/24 -InterfaceAlias "Zorglub" -NextHop 10.1.1.254'))
      .toContain('No matching interface found.');
  });

  it('refuse une metrique hors de la plage d un UInt16', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 192.168.10.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254 -RouteMetric 99999'))
      .toContain('System.UInt16');
  });

  it('-WhatIf ne cree AUCUNE route', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'New-NetRoute -DestinationPrefix 192.168.11.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254 -WhatIf');
    expect(out).toContain('What if:');
    expect(await table(sh)).not.toContain('192.168.11.0/24');
  });
});

describe('New-NetRoute — deux routes vers un meme prefixe sont DEUX routes', () => {
  it('deux sauts suivants differents coexistent, chacun avec sa metrique', async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    const second = await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.253 -RouteMetric 50');
    expect(second).toContain('10.1.1.253');
    const vue = await table(sh, '-DestinationPrefix 192.168.5.0/24');
    expect(vue).toContain('10.1.1.254');
    expect(vue).toContain('10.1.1.253');
  });

  it('la MEME route deux fois est refusee comme doublon', async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    expect(await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254'))
      .toContain('already exists');
  });
});

describe('Get-NetRoute — chaque parametre est un filtre', () => {
  const lab = async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254 -RouteMetric 10 -Publish Yes');
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.6.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.253 -RouteMetric 20 -Protocol Rip');
    return sh;
  };

  it('filtre par -NextHop', async () => {
    const sh = await lab();
    const vue = await table(sh, '-NextHop 10.1.1.253');
    expect(vue).toContain('192.168.6.0/24');
    expect(vue).not.toContain('192.168.5.0/24');
  });

  it('filtre par -RouteMetric', async () => {
    const sh = await lab();
    const vue = await table(sh, '-RouteMetric 10');
    expect(vue).toContain('192.168.5.0/24');
    expect(vue).not.toContain('192.168.6.0/24');
  });

  it('filtre par -Publish et par -Protocol', async () => {
    const sh = await lab();
    expect(await table(sh, '-Publish Yes')).toContain('192.168.5.0/24');
    expect(await table(sh, '-Publish Yes')).not.toContain('192.168.6.0/24');
    expect(await table(sh, '-Protocol Rip')).toContain('192.168.6.0/24');
    expect(await table(sh, '-Protocol Rip')).not.toContain('192.168.5.0/24');
  });

  it('filtre par -AddressFamily', async () => {
    const sh = await lab();
    await run(sh, 'New-NetRoute -DestinationPrefix 2001:db8::/32 -InterfaceAlias "Ethernet 0" -NextHop fe80::1');
    const vue = await table(sh, '-AddressFamily IPv6');
    expect(vue).toContain('2001:db8::/32');
    expect(vue).not.toContain('192.168.5.0/24');
  });

  it('un prefixe qu aucune route ne porte est un refus nomme', async () => {
    const sh = await lab();
    expect(await run(sh, 'Get-NetRoute -DestinationPrefix 10.9.9.0/24'))
      .toContain("No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '10.9.9.0/24'");
  });

  it('refuse un filtre que ce simulateur ne sait pas evaluer plutot que de l ignorer', async () => {
    const sh = await lab();
    expect(await run(sh, 'Get-NetRoute -InterfaceMetric 20')).toContain('not implemented in this simulator');
    expect(await run(sh, 'Get-NetRoute -CompartmentId 1')).toContain('not implemented in this simulator');
  });
});

describe('Remove-NetRoute — chaque parametre est un filtre, et elle DEMANDE confirmation', () => {
  const lab = async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.253');
    return sh;
  };

  it('demande confirmation par defaut, et ne retire rien tant qu on n a pas repondu', async () => {
    const { sh } = await machine();
    await run(sh, '$ConfirmPreference = "High"');
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    expect(await run(sh, 'Remove-NetRoute -DestinationPrefix 192.168.5.0/24')).toContain('NonInteractive');
    expect(await table(sh, '-DestinationPrefix 192.168.5.0/24')).toContain('192.168.5.0/24');
  });

  it('-Confirm:$false passe outre, et -NextHop ne retire QUE la route nommee', async () => {
    const sh = await lab();
    await run(sh, '$ConfirmPreference = "High"');
    expect(await run(sh, 'Remove-NetRoute -DestinationPrefix 192.168.5.0/24 -NextHop 10.1.1.253 -Confirm:$false')).toBe('');
    const vue = await table(sh, '-DestinationPrefix 192.168.5.0/24');
    expect(vue).toContain('10.1.1.254');
    expect(vue).not.toContain('10.1.1.253');
  });

  it('-WhatIf ne retire rien', async () => {
    const sh = await lab();
    expect(await run(sh, 'Remove-NetRoute -DestinationPrefix 192.168.5.0/24 -WhatIf')).toContain('What if:');
    expect(await table(sh, '-DestinationPrefix 192.168.5.0/24')).toContain('10.1.1.254');
  });

  it('-PassThru rend ce qui a ete retire', async () => {
    const sh = await lab();
    const out = await run(sh, 'Remove-NetRoute -DestinationPrefix 192.168.5.0/24 -PassThru | Format-Table DestinationPrefix,NextHop');
    expect(out).toContain('10.1.1.254');
    expect(out).toContain('10.1.1.253');
  });

  it('accepte le pipeline de Get-NetRoute', async () => {
    const sh = await lab();
    await run(sh, 'Get-NetRoute -NextHop 10.1.1.253 | Remove-NetRoute');
    const vue = await table(sh, '-DestinationPrefix 192.168.5.0/24');
    expect(vue).toContain('10.1.1.254');
    expect(vue).not.toContain('10.1.1.253');
  });

  it('un prefixe qu aucune route ne porte est un refus nomme', async () => {
    const sh = await lab();
    expect(await run(sh, 'Remove-NetRoute -DestinationPrefix 10.9.9.0/24'))
      .toContain("No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '10.9.9.0/24'");
  });
});

describe('Set-NetRoute — les filtres selectionnent, les valeurs au singulier posent', () => {
  const lab = async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    await run(sh, 'New-NetRoute -DestinationPrefix 192.168.5.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.253');
    return sh;
  };

  it('-NextHop SELECTIONNE la route a modifier, il ne la change pas', async () => {
    const sh = await lab();
    await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -NextHop 10.1.1.253 -RouteMetric 42');
    const vue = await run(sh, 'Get-NetRoute -DestinationPrefix 192.168.5.0/24 | Format-Table NextHop,RouteMetric');
    expect(vue).toMatch(/10\.1\.1\.253\s+42/);
    expect(vue).not.toMatch(/10\.1\.1\.254\s+42/);
  });

  it('pose -Publish, et refuse une valeur hors de l ensemble', async () => {
    const sh = await lab();
    await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -NextHop 10.1.1.254 -Publish Yes');
    expect(await run(sh, 'Get-NetRoute -NextHop 10.1.1.254 | Format-Table Publish')).toContain('Yes');
    expect(await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -Publish Zorglub'))
      .toContain('does not belong to the set "No,Age,Yes"');
  });

  it('pose -ValidLifetime, que Get-NetRoute relit', async () => {
    const sh = await lab();
    await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -NextHop 10.1.1.254 -ValidLifetime (New-TimeSpan -Minutes 30)');
    expect(await run(sh, 'Get-NetRoute -NextHop 10.1.1.254 | Format-List ValidLifetime')).toContain('00:30:00');
  });

  it('refuse une metrique hors de la plage d un UInt16', async () => {
    const sh = await lab();
    expect(await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -RouteMetric 99999'))
      .toContain('System.UInt16');
  });

  it('-WhatIf ne change rien', async () => {
    const sh = await lab();
    expect(await run(sh, 'Set-NetRoute -DestinationPrefix 192.168.5.0/24 -RouteMetric 7 -WhatIf')).toContain('What if:');
    expect(await run(sh, 'Get-NetRoute -NextHop 10.1.1.254 | Format-Table RouteMetric')).not.toContain('7');
  });

  it('un prefixe qu aucune route ne porte est un refus, et ne CREE pas la route', async () => {
    const sh = await lab();
    expect(await run(sh, 'Set-NetRoute -DestinationPrefix 10.9.9.0/24 -RouteMetric 5'))
      .toContain("No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '10.9.9.0/24'");
    expect(await table(sh)).not.toContain('10.9.9.0/24');
  });

  it('accepte le pipeline de Get-NetRoute et rend -PassThru', async () => {
    const sh = await lab();
    const out = await run(sh, 'Get-NetRoute -NextHop 10.1.1.253 | Set-NetRoute -RouteMetric 33 -PassThru | Format-Table NextHop,RouteMetric');
    expect(out).toMatch(/10\.1\.1\.253\s+33/);
  });
});

describe('La route par defaut est LA passerelle par defaut, une seule fois', () => {
  it('New-NetRoute 0.0.0.0/0 pose la passerelle que Get-NetIPConfiguration montre', async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 0.0.0.0/0 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    expect(await run(sh, 'Get-NetIPConfiguration -InterfaceAlias "Ethernet 0"')).toContain('10.1.1.254');
    expect(await run(sh, 'route print')).toContain('10.1.1.254');
  });

  it('Remove-NetRoute 0.0.0.0/0 la retire des DEUX vues', async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 0.0.0.0/0 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    await run(sh, 'Remove-NetRoute -DestinationPrefix 0.0.0.0/0');
    expect(await run(sh, 'Get-NetIPConfiguration -InterfaceAlias "Ethernet 0"')).not.toContain('10.1.1.254');
    expect(await table(sh)).not.toContain('0.0.0.0/0');
  });

  it('la passerelle ne parait que sur SON interface', async () => {
    const { sh } = await machine();
    await run(sh, 'New-NetRoute -DestinationPrefix 0.0.0.0/0 -InterfaceAlias "Ethernet 0" -NextHop 10.1.1.254');
    expect(await run(sh, 'Get-NetIPConfiguration -InterfaceAlias "Ethernet 1"')).not.toContain('10.1.1.254');
  });
});

describe('Un index d interface designe UNE interface', () => {
  it('la pseudo-interface de bouclage ne porte pas l index d une carte reelle', async () => {
    const { sh } = await machine();
    const carte = await run(sh, '(Get-NetAdapter -Name "Ethernet 0").ifIndex');
    expect(carte.trim()).not.toBe('1');
    const vue = await run(sh, `Get-NetRoute -InterfaceIndex ${carte.trim()} | Format-Table InterfaceAlias`);
    expect(vue).not.toContain('Loopback');
  });

  it('le meme index nomme la meme interface pour Get-NetAdapter et Get-NetIPAddress', async () => {
    const { sh } = await machine();
    const carte = (await run(sh, '(Get-NetAdapter -Name "Ethernet 0").ifIndex')).trim();
    const parIp = (await run(sh, '(Get-NetIPAddress -IPAddress 10.1.1.1).ifIndex')).trim();
    expect(parIp).toBe(carte);
  });
});
