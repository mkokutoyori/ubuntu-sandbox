/**
 * `Test-Connection -Count N` envoie N demandes d'echo, pas une.
 *
 * Mesure de depart, comptee sur le bus de la machine emettrice
 * (`host.icmp.echo-sent`) avec un serveur cable en face :
 *
 *     Test-Connection 10.0.0.2 -Count 4  ->  1 echo,  4 lignes rendues
 *     ping -n 4 10.0.0.2                 ->  4 echos, 4 lignes rendues
 *
 * Le meme geste, vu par deux commandes de la MEME machine, ne mettait pas
 * le meme trafic sur le cable : la cmdlet sondait une fois et recopiait sa
 * ligne, avec le meme RTT et le meme statut, autant de fois que `-Count`
 * le demandait. Un atelier qui compte les trames voyait la difference.
 *
 * L'autorite est la documentation de Microsoft pour PowerShell 5.1 :
 * « -Count : Specifies the number of echo requests to send. The default
 * value is 4. » et, pour `-Quiet`, « If any ping succeeds, $true is
 * returned. If all pings fail, $false is returned. »
 *
 * Discrimination par `git stash` : 2 des 6 cas TOMBENT sans le lot — les
 * deux qui comptent les echos (`-Count 4`, puis `-Count 1` et le defaut).
 *
 * Les 4 qui passent DES DEUX COTES, et pourquoi ils sont la :
 *  - `ping -n 4` — TEMOIN : il emet ses quatre echos avant comme apres.
 *    Sans lui, un compteur casse rendrait la sonde verte pour rien.
 *  - `Test-NetConnection` — NON-REGRESSION : il sonde UNE fois et doit le
 *    rester. Le port partage prend desormais un NOMBRE ; il ne devient pas
 *    une sequence pour autant, et ce cas garde la porte.
 *  - `-Quiet` et le temps des lignes injoignables — STRUCTUREL : avec une
 *    sonde unique recopiee, « une au moins a repondu » et « la seule a
 *    repondu » donnent le meme verdict, donc ces cas ne discriminent pas.
 *    Ils epinglent le contrat documente pour qu'il ne derive plus.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c').connect(win.getPorts()[0], srv.getPorts()[0]);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  win.setCurrentUser('Administrator');
  let echoes = 0;
  win.getBus().subscribe('host.icmp.echo-sent', () => { echoes++; });
  const sub = PowerShellSubShell.create(win).subShell;
  return {
    win,
    echoes: () => echoes,
    ps: async (line: string) => (await sub.processLine(line)).output.join('\n'),
  };
}

describe('Test-Connection met sur le fil ce qu il annonce', () => {
  it('TEMOIN : `ping -n 4` emet quatre echos', async () => {
    const { win, echoes } = lab();
    const before = echoes();
    await win.executeCommand('ping -n 4 10.0.0.2');
    expect(echoes() - before).toBe(4);
  });

  it('-Count 4 emet QUATRE echos, comme `ping -n 4`', async () => {
    const { ps, echoes } = lab();
    const before = echoes();
    const out = await ps('Test-Connection 10.0.0.2 -Count 4');
    expect(echoes() - before).toBe(4);
    expect(out.split('\n').filter(l => /Destination\s*:/.test(l))).toHaveLength(4);
  });

  it('-Count 1 n en emet qu un, et le defaut en emet quatre', async () => {
    const { ps, echoes } = lab();
    const avantUn = echoes();
    await ps('Test-Connection 10.0.0.2 -Count 1');
    expect(echoes() - avantUn).toBe(1);
    const avantDefaut = echoes();
    await ps('Test-Connection 10.0.0.2');
    expect(echoes() - avantDefaut).toBe(4);
  });

  it('NON-REGRESSION : Test-NetConnection sonde UNE seule fois', async () => {
    const { ps, echoes } = lab();
    const before = echoes();
    await ps('Test-NetConnection -ComputerName 10.0.0.2');
    expect(echoes() - before).toBe(1);
  });

  it('-Quiet rend True quand une sonde aboutit, False quand aucune n aboutit', async () => {
    const { ps } = lab();
    expect((await ps('Test-Connection 10.0.0.2 -Count 4 -Quiet')).trim()).toBe('True');
    expect((await ps('Test-Connection 10.255.255.7 -Count 2 -Quiet')).trim()).toBe('False');
  });

  it('chaque ligne porte SA mesure : un hote injoignable ne rend aucun temps', async () => {
    const { ps } = lab();
    const out = await ps('Test-Connection 10.255.255.7 -Count 2');
    const lignes = out.split('\n').filter(l => /Time\(ms\)\s*:/.test(l));
    expect(lignes).toHaveLength(2);
    for (const l of lignes) expect(l).toMatch(/Time\(ms\)\s*:\s*0\s*$/);
  });
});
