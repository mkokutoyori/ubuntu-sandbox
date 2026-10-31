/**
 * Les evenements du bus de sshd (`client_connected`, `auth_success`, `auth_failure`, ...) portent un `timestamp` que la
 * journalisation et les abonnes reactifs lisent. Mesure de depart : le gestionnaire le prenait a l'heure globale du
 * simulateur (`simulationNowMs()`), si bien qu'apres `date -s` sur le serveur l'evenement etait date de l'heure
 * d'origine alors que `who`, `last` et auth.log disaient la date posee. ISshServerContext expose desormais `nowMs()`
 * (l'horloge de la machine : `simulatedDate()` sous Linux, l'executeur sous Windows) et le gestionnaire date ses
 * evenements dessus. Les DUREES (canal, session) restent des ecarts de temps global, donc monotones.
 *
 * Discrimine par `git stash` sur src/network : 2 des 3 cas tombent avant (client_connected, auth_success). Le TEMOIN
 * (horloge non touchee, l'evenement porte l'heure courante) passe des deux cotes. Le chemin Windows partage le meme
 * gestionnaire et la meme interface mais n'a pas de sonde propre ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { SshServerEvent } from '@/network/protocols/ssh/server/SshServerEvent';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const SSH = 'sshpass -p admin ssh -o StrictHostKeyChecking=no alice@10.0.0.2';

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer; events: SshServerEvent[] }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('useradd -m -s /bin/bash alice');
  await srv.executeCommand("echo 'alice:admin' | chpasswd");
  const events: SshServerEvent[] = [];
  srv.getSshServerContext().events.on('*', (e) => events.push(e));
  return { pc, srv, events };
}

function stampOf(events: SshServerEvent[], kind: SshServerEvent['kind']): number {
  const event = events.find((e) => e.kind === kind) as { timestamp?: number } | undefined;
  expect(event, `no ${kind} event`).toBeDefined();
  return event!.timestamp as number;
}

describe('les evenements de sshd sont dates sur l horloge de la machine', () => {
  it('TEMOIN — horloge intacte, l evenement porte l heure courante du serveur', async () => {
    const { pc, srv, events } = await lab();
    await pc.executeCommand(`${SSH} true`);
    expect(Math.abs(stampOf(events, 'auth_success') - srv.getSystemClockMs())).toBeLessThan(120_000);
  }, 120_000);

  it('client_connected suit date -s', async () => {
    const { pc, srv, events } = await lab();
    await srv.executeCommand('date -s "2027-03-15 09:30:00"');
    await pc.executeCommand('date -s "2027-03-15 09:30:00"');
    await pc.executeCommand(`${SSH} true`);
    const wanted = Date.UTC(2027, 2, 15, 9, 30, 0);
    expect(Math.abs(stampOf(events, 'client_connected') - wanted)).toBeLessThan(120_000);
  }, 120_000);

  it('auth_success suit date -s', async () => {
    const { pc, srv, events } = await lab();
    await srv.executeCommand('date -s "2027-03-15 09:30:00"');
    await pc.executeCommand('date -s "2027-03-15 09:30:00"');
    await pc.executeCommand(`${SSH} true`);
    const wanted = Date.UTC(2027, 2, 15, 9, 30, 0);
    expect(Math.abs(stampOf(events, 'auth_success') - wanted)).toBeLessThan(120_000);
  }, 120_000);
});
