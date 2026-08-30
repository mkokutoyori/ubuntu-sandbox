/**
 * `no cdp run` appartient a la MACHINE, pas a la session qui l'a tape.
 *
 * DISCRIMINATION : 3/6 tombent — les trois cas qui traversent DEUX
 * sessions. Les 3 autres sont nommes : le TEMOIN d'une seule session,
 * l'isolement entre deux machines et le cas du commutateur, qui
 * passaient tous parce qu'une session lit ce qu'elle a elle-meme ecrit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]) { for (const c of cmds) await d.executeCommand(c); }

function vtyDe(r: CiscoRouter) {
  const shell = (r as unknown as { createVtyShell(u?: string): { execute(c: string): Promise<string> | string } })
    .createVtyShell();
  return async (c: string) => (await shell.execute(c)) ?? '';
}

describe('l\'etat global d\'une machine est le meme pour toutes ses sessions', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('TEMOIN — la console voit son propre `no cdp run`', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
    await taper(r, ['enable', 'configure terminal', 'no cdp run', 'end']);
    expect(await r.executeCommand('show cdp')).toContain('CDP is not enabled');
  });

  it('une session vty voit le `no cdp run` tape a la console', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
    await taper(r, ['enable', 'configure terminal', 'no cdp run', 'end']);
    const vty = vtyDe(r);
    await vty('enable');
    expect(await vty('show cdp')).toContain('CDP is not enabled');
  });

  it('et la console voit le `cdp run` tape en vty', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
    await taper(r, ['enable', 'configure terminal', 'no cdp run', 'end']);
    const vty = vtyDe(r);
    for (const c of ['enable', 'configure terminal', 'cdp run', 'end']) await vty(c);
    expect(await r.executeCommand('show cdp')).toContain('Global CDP information');
  });

  it('LLDP suit la meme regle', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
    await taper(r, ['enable', 'configure terminal', 'lldp run', 'end']);
    const vty = vtyDe(r);
    await vty('enable');
    expect(await vty('show lldp')).toContain('Global LLDP Information');
  });

  it('deux machines gardent chacune le sien', async () => {
    const a = new CiscoRouter('router-cisco', 'R1', 0, 0);
    const b = new CiscoRouter('router-cisco', 'R2', 200, 0);
    await taper(a, ['enable', 'configure terminal', 'no cdp run', 'end']);
    expect(await a.executeCommand('show cdp')).toContain('CDP is not enabled');
    expect(await b.executeCommand('show cdp')).toContain('Global CDP information');
  });

  it('un commutateur porte le sien aussi', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 0, 0);
    await taper(sw, ['enable', 'configure terminal', 'no cdp run', 'end']);
    expect(await sw.executeCommand('show cdp')).toContain('CDP is not enabled');
  });
});
