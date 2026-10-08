/*
 * `debug snmp packets` et les lignes de `debug ntp packets`.
 *
 * `debug snmp` etait inconnu : le moteur SNMP publiait pourtant
 * snmp.packet.received / sent, snmp.auth.rejected et snmp.trap.sent. Le
 * service de debug du routeur s'y abonne : une interrogation recue donne
 * `SNMP: Packet received via UDP from <ip>: <pdu>, community <c>`, une
 * reponse `... sent ...`, un refus d'authentification la raison. Le
 * commutateur Cisco simule n'a pas d'agent SNMP : la famille n'y est pas
 * offerte.
 *
 * Defaut trouve en lisant l'abonnement voisin : `debug ntp packets`
 * lisait des champs `destIp` / `srcIp` que l'evenement ne porte pas
 * (il porte serverIp et fromIp), donc chaque ligne disait `xmit packet to
 * ?` / `rcv packet from ?`. Les lignes lisent maintenant les champs typés.
 *
 * Le texte des lignes SNMP est derive des charges utiles ; sa forme exacte
 * sur un IOS n'est pas attestee depuis ce reseau.
 *
 * Avant le correctif : 4 des 5 cas tombent (git stash de src/network).
 * Passe des deux cotes le TEMOIN « sans drapeau, une interrogation SNMP
 * ne trace rien », qui prouve que le laboratoire fait bien parler l'agent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { DomainEvent } from '@/events/types';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function run(d: { executeCommand(c: string): Promise<string> }, ...lines: string[]): Promise<string> {
  let last = '';
  for (const l of lines) last = await d.executeCommand(l);
  return last;
}

async function lab() {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  new Cable('c1').connect(router.getPorts()[0], pc.getPort('eth0')!);
  await run(router, 'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.9.1 255.255.255.0', 'no shutdown', 'exit',
    'snmp-server community public RO', 'end');
  await run(pc, 'ip addr add 10.0.9.2/24 dev eth0', 'ip link set eth0 up');
  const lines: string[] = [];
  collecteDebug((router as unknown as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService(), lines);
  return { router, pc, lines };
}

describe('debug snmp packets', () => {
  it('WITNESS : sans drapeau, une interrogation SNMP ne trace rien et l agent repond', async () => {
    const { pc, lines } = await lab();
    const out = await run(pc, 'snmpwalk -v2c -c public 10.0.9.1 1.3.6.1.2.1.1');
    expect(out).toContain('STRING: "Cisco');
    expect(lines.some((l) => l.startsWith('SNMP:'))).toBe(false);
  });

  it('la commande est acceptee, listee et retiree', async () => {
    const { router } = await lab();
    expect(await run(router, 'debug snmp packets')).toBe('SNMP packets debugging is on');
    expect(await run(router, 'show debugging')).toContain('SNMP packets debugging is on');
    expect(await run(router, 'no debug snmp packets')).toBe('SNMP packets debugging is off');
  });

  it('une interrogation reelle est tracee a l arrivee et a la reponse', async () => {
    const { router, pc, lines } = await lab();
    await run(router, 'debug snmp packets');
    await run(pc, 'snmpwalk -v2c -c public 10.0.9.1 1.3.6.1.2.1.1');
    const out = lines.join('\n');
    expect(out).toMatch(/SNMP: Packet received via UDP from 10\.0\.9\.2: \S+, community public/);
    expect(out).toMatch(/SNMP: Packet sent via UDP to 10\.0\.9\.2/);
  });

  it('une communaute inconnue est tracee comme refus', async () => {
    const { router, pc, lines } = await lab();
    await run(router, 'debug snmp packets');
    await run(pc, 'snmpwalk -v2c -c wrong 10.0.9.1 1.3.6.1.2.1.1');
    expect(lines.join('\n')).toMatch(/SNMP: Packet from 10\.0\.9\.2 rejected \(unknown-community\), community wrong/);
  }, 30000);

  it('debug ntp packets nomme le serveur au lieu de « ? »', async () => {
    const { router, lines } = await lab();
    await run(router, 'debug ntp packets');
    router.getBus().publish({
      topic: 'ntp.packet.sent',
      payload: { deviceId: router.id, hostname: 'R1', serverIp: '10.0.9.50', mode: 'client' },
    } as unknown as DomainEvent);
    expect(lines.join('\n')).toContain('NTP: xmit packet to 10.0.9.50, mode client');
  });
});
