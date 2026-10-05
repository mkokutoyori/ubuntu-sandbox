/**
 * Une connexion TCP que le ROUTEUR ouvre lui-meme apprend ce que le chemin
 * lui repond : l'interdiction administrative d'un pare-feu la termine tout de
 * suite, une erreur douce la laisse vivre.
 *
 * Mesure de depart (commit precedent), trois equipements reels sur des cables
 * reels (R1 — R2 — poste) : R2 refuse le telnet sortant par une ACL et R1
 * recoit « administratively prohibited » :
 *
 *   - `Router.processIPv4` publiait l'erreur sur le bus mais ne la remettait
 *     JAMAIS a la pile TCP du routeur (seul `EndHost` le faisait) : la
 *     tentative de connexion de R1 restait sans reponse jusqu'a l'expiration
 *     du SYN (180 s), au lieu d'etre refusee sur-le-champ comme sur un poste.
 *     La meme lacune valait pour IPv6 (`onIcmpv6Error` ne faisait que publier).
 *
 * Autorite (docs/rfc/tcp/rfc9293.txt, lue) : §3.9.2.2 (une erreur ICMP recue
 * DOIT etre remise a la connexion qu'elle cite, MUST-54 ; une erreur dure
 * interrompt la connexion, SHLD-26 ; une erreur douce ne l'interrompt pas,
 * MUST-56). Les routeurs portent des pairs TCP (BGP, SSH, telnet) : MUST-54
 * ne distingue pas un poste d'un routeur.
 *
 * Ce qui est construit : la remise est celle d'`EndHost`, extraite dans
 * `tcp/IcmpErrorDelivery` et partagee par les deux familles d'equipements.
 *
 * Discrimination (fichier copie sur le commit precedent) : UN cas sur trois
 * tombe (`timeout` au lieu de `prohibited`). Les DEUX autres sont des TEMOINS
 * du laboratoire : un port que l'ACL laisse passer est refuse par le poste, et
 * l'interdiction arrive bien a R1 comme erreur ICMP, quoi que sa pile TCP en
 * fasse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function configure(router: CiscoRouter, lines: string[]): Promise<void> {
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  for (const line of lines) await router.executeCommand(line);
  await router.executeCommand('end');
}

async function lab(aclLines: string[], bus = new EventBus()) {
  const scheduler = new VirtualTimeScheduler();
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const host = new LinuxServer('linux-server', 'SRV', 0, 0);
  for (const device of [r1, r2, host]) {
    device.setEventBus(bus);
    device.powerOn();
    device.setScheduler(scheduler);
  }
  const link1 = new Cable('r1-r2'); link1.setEventBus(bus);
  link1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  const link2 = new Cable('r2-host'); link2.setEventBus(bus);
  link2.connect(r2.getPort('GigabitEthernet0/1')!, host.getPort('eth0')!);

  await host.executeCommand('ifconfig eth0 10.0.2.10 netmask 255.255.255.0');
  await host.executeCommand('ip route add default via 10.0.2.1');
  await configure(r1, [
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.0.12.2',
  ]);
  await configure(r2, [
    ...aclLines,
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown',
    'ip access-group BLOCK out', 'exit',
  ]);
  return { r1, r2, host, scheduler };
}

describe('a router that dials out learns what the path answers (RFC 9293 §3.9.2.2, MUST-54)', () => {
  it('an administrative prohibition ends the connection attempt at once', async () => {
    const { r1 } = await lab([
      'ip access-list extended BLOCK', 'deny tcp any any eq 23', 'permit ip any any', 'exit',
    ]);
    expect(r1.getTcpStack().connectOutcome('10.0.2.10', 23)).toBe('prohibited');
  });

  it('WITNESS: a port the ACL lets through is refused by the host itself, not prohibited', async () => {
    const { r1 } = await lab([
      'ip access-list extended BLOCK', 'deny tcp any any eq 23', 'permit ip any any', 'exit',
    ]);
    expect(r1.getTcpStack().connectOutcome('10.0.2.10', 9999)).toBe('refused');
  });

  it('WITNESS: the prohibition does reach R1 as an ICMP error, whatever its TCP stack does with it', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe('host.icmp.unreachable', (event) => events.push(`${event.payload.fromIp} ${event.payload.code}`));
    const { r1 } = await lab([
      'ip access-list extended BLOCK', 'deny tcp any any eq 23', 'permit ip any any', 'exit',
    ], bus);
    r1.getTcpStack().connectOutcome('10.0.2.10', 23);
    expect(events).toContain('10.0.12.2 admin-prohibited');
  });
});
