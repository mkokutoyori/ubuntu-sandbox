/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * Elle durcit une infrastructure d'entreprise comme le ferait un
 * ingenieur securite, puis ATTAQUE chacun de ses controles. Poser une
 * commande ne prouve rien : ce qui se mesure ici, c'est si le controle
 * APPLIQUE. Le releve est cite dans `docs/AUDIT-SECURITE-INFRA.md`.
 *
 * Releve du 2026-09-10, violation de `port-security` :
 *
 *   [T] PC-A joint le routeur avant durcissement   0% packet loss
 *   [1] PC-A, 1re MAC apprise                      0% packet loss
 *   [2] PC-B, 2e MAC sur le meme port            100% packet loss
 *   [3] Port Status: Secure-shutdown, Violation Count: 1,
 *       Sticky MAC: 1, Last Source Address enregistree
 *   [4] show interfaces status                     Fa0/1 disabled
 *   [5] PC-A APRES la violation                  100% packet loss
 *
 * [5] est le point le plus interessant du releve et il n'est PAS un
 * defaut : `violation shutdown` err-disable le port ENTIER, donc la
 * machine legitime perd le lien elle aussi. C'est ce que fait un vrai
 * Catalyst, et c'est la raison pour laquelle cette violation se
 * configure avec precaution en production.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const notes: string[] = [];
const note = (l: string) => notes.push(l);

async function cli(d: { executeCommand(c: string): Promise<string> }, l: string[]): Promise<string> {
  let out = '';
  for (const c of l) out = await d.executeCommand(c);
  return out;
}
const perte = async (pc: LinuxPC, ip: string) =>
  (await pingOnSimulatedClock(pc, `ping -c 2 ${ip}`))
    .split('\n').filter((l) => /packet loss/.test(l)).join('').trim();

describe('les controles L2 appliquent-ils ?', () => {
  it('violation de port-security', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    const hub = new Hub('HUB', 4, 0, 0);
    const a = new LinuxPC('linux-pc', 'PC-A', -150, -50);
    const b = new LinuxPC('linux-pc', 'PC-B', -150, 50);
    const rt = new CiscoRouter('R', 0, 0);
    sw.powerOn(); hub.powerOn(); a.powerOn(); b.powerOn(); rt.powerOn();

    new Cable('h1').connect(a.getPort('eth0')!, hub.getPort('eth0')!);
    new Cable('h2').connect(b.getPort('eth0')!, hub.getPort('eth1')!);
    new Cable('h3').connect(hub.getPort('eth2')!, sw.getPort('FastEthernet0/1')!);
    new Cable('up').connect(sw.getPort('FastEthernet0/24')!, rt.getPort('GigabitEthernet0/0')!);

    await cli(rt, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
    for (const [pc, ip] of [[a, '10.0.0.10'], [b, '10.0.0.11']] as const) {
      await pc.executeCommand(`ip addr add ${ip}/24 dev eth0`);
      await pc.executeCommand('ip link set eth0 up');
    }

    note(`[T] TEMOIN — PC-A joint le routeur avant durcissement : ${await perte(a, '10.0.0.1')}`);

    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'switchport mode access', 'switchport port-security',
      'switchport port-security maximum 1',
      'switchport port-security mac-address sticky',
      'switchport port-security violation shutdown', 'end']);

    note(`[1] PC-A (1re MAC, apprise) : ${await perte(a, '10.0.0.1')}`);
    note(`[2] PC-B (2e MAC sur le meme port) : ${await perte(b, '10.0.0.1')}`);

    const etat = await sw.executeCommand('show port-security interface FastEthernet0/1');
    note(`[3] etat du port : ${etat.split('\n').filter((l) =>
      /Port Status|Violation Count|Last Source|Sticky/i.test(l)).join(' | ')}`);
    const itf = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    note(`[4] show interfaces status : ${itf.split('\n').filter((l) => /Fa0\/1|err/i.test(l)).join(' | ')}`);
    note(`[5] PC-A apres la violation : ${await perte(a, '10.0.0.1')}`);

    writeFileSync('/tmp/mes/secu3.txt', notes.join('\n') + '\n');
    expect(true).toBe(true);
  }, 180000);
});
