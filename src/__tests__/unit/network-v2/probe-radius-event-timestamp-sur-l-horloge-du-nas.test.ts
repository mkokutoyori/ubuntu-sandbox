/**
 * L'attribut 55 (Event-Timestamp, RFC 2869 §5.3) donne l'instant de l'evenement VU PAR LE NAS, en secondes depuis 1970.
 * Mesure de depart : `acctAttributesFor` le lisait sur l'heure globale du simulateur (`simulationNowMs()`), si bien
 * qu'apres `clock set` sur le routeur la requete d'accounting portait encore l'heure d'origine alors que `show clock`
 * disait la date posee. RadiusAttributePolicy porte maintenant `nowMs` (l'horloge de l'equipement, posee par
 * AaaAuthenticator) et l'attribut le lit.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (l'attribut apres `clock set`). Le TEMOIN
 * (horloge intacte, l'attribut est l'heure courante du routeur) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { getAttr, type RadiusPacket } from '@/network/radius/types';
import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import { radiusLab } from './_helpers/radiusAaaLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function eventTimestamp(setClock: string | null): Promise<{ stamp: number; nasMs: number }> {
  const { nas, live } = await radiusLab(['radius-server attribute 55 include-in-acct-req']);
  const seen: RadiusPacket[] = [];
  (live as CiscoRouter).getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const udp = packet?.type === 'ipv4' ? packet.payload as UDPPacket : undefined;
    if (udp?.type === 'udp' && udp.destinationPort === 1813) seen.push(udp.payload as RadiusPacket);
  });
  if (setClock !== null) await nas.executeCommand(setClock);
  const accounting = nas.getRadiusAccountingClient();
  accounting.start();
  accounting.addServer('10.0.0.3', 'secret', { timeoutMs: 200, retransmit: 0 });
  accounting.setAttributePolicy(nas.getAaaAuthenticator().radiusAttributePolicy());
  accounting.startSession('alice', '10.0.0.3');
  await clock.advanceUntilSettled(Promise.resolve());
  const request = seen.find((p) => p.code === 'accounting-request') as RadiusPacket;
  return { stamp: Number(getAttr(request, 'event-timestamp')?.value), nasMs: nas.getSystemClockMs() };
}

describe('Event-Timestamp suit l horloge du NAS', () => {
  it('TEMOIN — horloge intacte, l attribut est l heure courante du routeur', async () => {
    const { stamp, nasMs } = await eventTimestamp(null);
    expect(Math.abs(stamp - Math.floor(nasMs / 1000))).toBeLessThan(120);
  });

  it('apres clock set, l attribut porte la date posee', async () => {
    const { stamp } = await eventTimestamp('clock set 10:00:00 5 January 2027');
    const wanted = Date.UTC(2027, 0, 5, 10, 0, 0) / 1000;
    expect(Math.abs(stamp - wanted)).toBeLessThan(3600 * 24);
  });
});
