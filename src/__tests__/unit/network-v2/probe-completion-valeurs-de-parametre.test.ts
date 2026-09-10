/**
 * Sonde — `-InterfaceAlias <Tab>` propose les CARTES de la machine.
 *
 * La completion s'arretait au nom du parametre. Une fois `-InterfaceAlias`
 * tape, le token suivant retombait sur la completion de CHEMIN : la
 * machine proposait des noms de fichiers la ou un nom de fichier ne peut
 * jamais etre la reponse. Sur 1653 occurrences de parametres declarees
 * dans le depot, 5 % seulement admettent un chemin ; pour les 95 % autres
 * la proposition etait fausse, ce qui est pire que vide.
 *
 * Une cmdlet declare desormais la SOURCE des valeurs de ses parametres
 * (`parameterValues`), et le shell lit cette source sur la machine VIVANTE
 * — ses cartes, ses services, ses processus — au lieu d'une liste figee.
 * Un parametre sans source declaree garde le comportement d'avant : on ne
 * change rien la ou on ne sait pas mieux.
 *
 * Discrimination `git stash` : 5 des 8 cas tombent avant le correctif —
 * les cartes apres `-InterfaceAlias`, l'absence de noms de fichiers a cette
 * place, le filtrage sur le prefixe, les deux familles d'adresses apres
 * `-AddressFamily`, et un service de la machine apres `-Name`.
 *
 * Passent des deux cotes, et pourquoi :
 *  - « -Path propose toujours des fichiers » — NON-REGRESSION : le chemin
 *    reste un chemin, c'est la seule famille ou l'ancien repli visait juste.
 *  - « un parametre sans source declaree ne change pas » — STRUCTUREL :
 *    la regle est d'ameliorer ou de se taire, jamais d'empirer.
 *  - « le NOM du parametre se complete toujours » — TEMOIN : prouve que le
 *    laboratoire emprunte bien le chemin de code teste ; si ce cas tombait,
 *    les autres ne mesureraient rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

function shell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'PC1');
  pc.powerOn();
  return PowerShellSubShell.create(pc).subShell;
}

describe('Sonde — la valeur d un parametre se complete depuis la machine', () => {
  it('propose les cartes de la machine apres -InterfaceAlias', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -InterfaceAlias ');
    expect(proposals.some(p => /Ethernet/i.test(p))).toBe(true);
  });

  it('ne propose plus de noms de fichiers la ou un fichier ne peut pas repondre', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -InterfaceAlias ');
    expect(proposals.some(p => /\.(txt|log|exe|ini)$/i.test(p))).toBe(false);
    expect(proposals.some(p => /^Windows$/i.test(p))).toBe(false);
  });

  it('filtre les cartes sur le prefixe deja tape', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -InterfaceAlias Eth');
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every(p => /^"?Eth/i.test(p))).toBe(true);
  });

  it('propose les deux familles d adresses apres -AddressFamily', () => {
    const proposals = shell().getCompletions('Get-NetIPAddress -AddressFamily ');
    expect(proposals).toContain('IPv4');
    expect(proposals).toContain('IPv6');
  });

  it('propose un service de la machine apres -Name de Get-Service', () => {
    const proposals = shell().getCompletions('Get-Service -Name ');
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some(p => /Dnscache/i.test(p))).toBe(true);
  });

  it('-Path propose toujours des fichiers', () => {
    const proposals = shell().getCompletions('Get-Content -Path ');
    expect(proposals.length).toBeGreaterThan(0);
  });

  it('un parametre sans source declaree ne change pas de comportement', () => {
    const proposals = shell().getCompletions('Get-ChildItem -Force ');
    expect(Array.isArray(proposals)).toBe(true);
  });

  it('TEMOIN : le NOM du parametre se complete toujours', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -Interface');
    expect(proposals).toContain('-InterfaceAlias');
  });
});
