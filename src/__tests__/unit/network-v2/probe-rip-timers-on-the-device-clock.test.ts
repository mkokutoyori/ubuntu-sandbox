/**
 * Les minuteries RIP se lisent sur l'horloge de l'ordonnanceur qui les
 * arme : une route dont le voisin se tait expire, puis disparait, et les
 * ages affiches sont ceux de cette horloge.
 *
 * Mesure de depart (07f4483d), deux routeurs Cisco sous horloge
 * virtuelle, R1 rendu muet (`no router rip`) lien actif : 181 s puis
 * 301 s plus tard, R2 montrait toujours `R 192.168.1.0/24 [120/1] via
 * 10.0.12.1` — jamais `possibly down`, jamais supprimee ; 100 s apres la
 * derniere mise a jour, `show ip rip database` et `show ip protocols`
 * lisaient un age de 00:00:00. Les minuteries etaient armees sur
 * l'ordonnanceur, mais comparees a Date.now() augmente d'un decalage que
 * seul Router.processTimers avancait.
 *
 * Autorite : RFC 2453 §3.8 — une route non rafraichie pendant 180 s
 * (timeout) passe a la metrique 16 et quitte le service ; 120 s plus
 * tard (garbage-collection) elle est supprimee. Cisco IOS ecrit une route
 * RIP invalide `is possibly down`.
 *
 * Discrimination, mesuree sur le commit de base (07f4483d) avec ce
 * fichier copie : 4 des 6 cas tombent. Passent des deux cotes le TEMOIN
 * (R2 apprend la boucle locale de R1) et la NON-REGRESSION « une route
 * rafraichie toutes les 30 s n'expire jamais », qui garde que chaque mise
 * a jour recue rearme bien le timeout.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

async function type(router: CiscoRouter, commands: readonly string[]): Promise<void> {
  for (const command of commands) await router.executeCommand(command);
}

async function lab() {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'network 192.168.1.0', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'end']);
  clock.advance(35_000);
  return { clock, r1, r2 };
}

async function silence(r1: CiscoRouter): Promise<void> {
  await type(r1, ['configure terminal', 'no router rip', 'end']);
}

function secondsOf(clock: string): number {
  const [hours, minutes, seconds] = clock.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

describe('RIP timers run on the scheduler that arms them', () => {
  it('WITNESS: R2 learns the loopback R1 advertises', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toMatch(/^R\s+192\.168\.1\.0\/24 \[120\/1\] via 10\.0\.12\.1,/m);
  });

  it('181 s after its neighbour falls silent, the route is possibly down', async () => {
    const { clock, r1, r2 } = await lab();
    await silence(r1);
    clock.advance(181_000);
    const table = await r2.executeCommand('show ip route');
    expect(table).toMatch(/192\.168\.1\.0\/24 is possibly down/);
    expect(table).not.toMatch(/192\.168\.1\.0\/24 \[120\/1\]/);
  });

  it('the garbage-collection timer then deletes it', async () => {
    const { clock, r1, r2 } = await lab();
    await silence(r1);
    clock.advance(181_000);
    clock.advance(120_000);
    expect(await r2.executeCommand('show ip route')).not.toContain('192.168.1.0');
    expect(await r2.executeCommand('show ip rip database')).not.toContain('192.168.1.0/24');
  });

  it('a route refreshed every 30 s never expires', async () => {
    const { clock, r2 } = await lab();
    clock.advance(600_000);
    expect(await r2.executeCommand('show ip route')).toMatch(/^R\s+192\.168\.1\.0\/24 \[120\/1\]/m);
  });

  it('show ip rip database dates the entry by the last update received', async () => {
    const { clock, r1, r2 } = await lab();
    await silence(r1);
    clock.advance(100_000);
    const age = /\[1\] via 10\.0\.12\.1, (\d\d:\d\d:\d\d)/.exec(await r2.executeCommand('show ip rip database'));
    expect(age).not.toBeNull();
    expect(secondsOf(age![1])).toBeGreaterThanOrEqual(100);
    expect(secondsOf(age![1])).toBeLessThanOrEqual(130);
  });

  it('show ip protocols dates the routing information source the same way', async () => {
    const { clock, r1, r2 } = await lab();
    await silence(r1);
    clock.advance(100_000);
    const source = /^ {4}10\.0\.12\.1 +120 +(\d\d:\d\d:\d\d)$/m.exec(await r2.executeCommand('show ip protocols'));
    expect(source).not.toBeNull();
    expect(secondsOf(source![1])).toBeGreaterThanOrEqual(100);
    expect(secondsOf(source![1])).toBeLessThanOrEqual(130);
  });
});
