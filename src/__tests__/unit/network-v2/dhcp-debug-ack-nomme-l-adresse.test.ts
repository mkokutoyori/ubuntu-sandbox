/**
 * `debug ip dhcp server events` : le DHCPACK d'un RENOUVELLEMENT ne
 * nommait aucune adresse.
 *
 * Le serveur a DEUX portes pour un REQUEST, et elles ne rendaient pas la
 * meme trace pour la meme question. `processRequestWithNak` — la porte du
 * fil, celle qu'un client cable emprunte — lisait
 * `binding?.ipAddress ?? requestedIP` et etait juste.
 * `processRequest` — la porte du RENOUVELLEMENT (`DHCPClient` l'appelle a
 * l'echeance de T1) et celle du plan de donnees IPv6 — lisait
 * `dbgAck.ip`, une propriete qui n'existe sur AUCUN `DHCPAckResult` :
 * l'adresse vit dans `binding.ipAddress`. Un operateur regardant le
 * renouvellement d'un bail lisait donc
 * `DHCPACK sent to client 0200.0000.0037 for undefined`, suivi d'un
 * `yiaddr: undefined` — precisement l'information qu'il cherchait.
 *
 * Le correctif n'est pas de corriger la propriete : les deux portes
 * appellent desormais `traceAck`, ecrit une fois, parce que deux rendus
 * d'une meme trace finissent toujours par diverger — c'est exactement ce
 * qui venait de se produire.
 *
 * Discrimine par `git stash` de `DHCPServer.ts` : le cas du
 * renouvellement tombe. Les cas du fil passent des deux cotes et sont la
 * comme TEMOIN — sans eux, « pas d'adresse dans la ligne » ne
 * distinguerait pas un defaut de trace d'un bail qui n'a pas eu lieu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

async function labo() {
  const r = new CiscoRouter('R1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const pc = new LinuxPC('linux-pc', 'CLI');
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(pc.getPorts()[0], sw.getPorts()[1]);
  pc.powerOn();
  r.getPort('GigabitEthernet0/0')!.configureIP(
    new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 10.0.0.1 10.0.0.9',
    'ip dhcp pool LAN',
    'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1',
    'end',
  ]) await run(r, c);

  const lignes: string[] = [];
  r.getDebugService().subscribe((l: string) => lignes.push(l));
  await run(r, 'debug ip dhcp server events');
  await run(r, 'debug ip dhcp server packet');
  await pc.executeCommand('dhclient eth0');
  return { r, pc, lignes };
}

describe('DHCP : la trace de l acquittement nomme l adresse servie', () => {
  it('TEMOIN — la ligne d OFFRE la nomme deja', async () => {
    const { pc, lignes } = await labo();

    const adresse = pc.getPorts()[0].getIPAddress()?.toString();
    expect(adresse).toMatch(/^10\.0\.0\./);
    expect(lignes.some(l => l.includes('DHCPOFFER') && l.includes(adresse!))).toBe(true);
  });

  it('la ligne DHCPACK nomme la meme adresse', async () => {
    const { pc, lignes } = await labo();

    const adresse = pc.getPorts()[0].getIPAddress()!.toString();
    const ack = lignes.filter(l => l.includes('DHCPACK sent to client'));
    expect(ack.length).toBeGreaterThan(0);
    expect(ack.every(l => l.includes(adresse))).toBe(true);
    expect(ack.some(l => l.includes('undefined'))).toBe(false);
  });

  it('TEMOIN — la trace du fil porte un yiaddr et non `undefined`', async () => {
    const { lignes } = await labo();

    const reply = lignes.filter(l => l.includes('BOOTREPLY'));
    expect(reply.length).toBeGreaterThan(0);
    expect(reply.some(l => /yiaddr\s*[:=]?\s*undefined/.test(l))).toBe(false);
  });

  it('le RENOUVELLEMENT nomme l adresse comme le premier bail', async () => {
    const { r, pc, lignes } = await labo();
    const adresse = pc.getPorts()[0].getIPAddress()!.toString();
    const mac = pc.getPorts()[0].getMAC().toString();
    const serveur = (r as unknown as {
      _getDHCPServerInternal(): {
        processRequest(p: { clientMAC: string; requestedIP: string; xid: number }): unknown;
      };
    })._getDHCPServerInternal();
    lignes.length = 0;

    serveur.processRequest({ clientMAC: mac, requestedIP: adresse, xid: 0x1234 });

    const ack = lignes.filter(l => l.includes('DHCPACK sent to client'));
    expect(ack.length).toBeGreaterThan(0);
    expect(ack.every(l => l.includes(adresse))).toBe(true);
    expect(lignes.some(l => l.includes('undefined'))).toBe(false);
  });
});
