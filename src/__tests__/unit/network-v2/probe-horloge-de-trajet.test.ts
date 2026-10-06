/**
 * Le temps de trajet d'une trame est celui de la physique du lien : propagation du cable
 * (`CABLE_SPECS`), serialisation (octets de trame + preambule de 8 octets, a la vitesse
 * negociee du port emetteur) et delai `netem` de la sortie. `Cable.transmit` le fait avancer
 * sur `PathClock` pendant la livraison ; les RTT (ping, traceroute, nmap, dig, IP SLA) et les
 * horodatages de capture le lisent, plus `performance.now()`.
 *
 * MESURE DE DEPART, A -- SW -- B, trois cables, `ping -c 2` :
 *  - le RTT valait 3,62 ms puis 1,21 ms puis 2,76 ms sur la meme topologie : du temps CPU ;
 *  - `tc qdisc add dev eth0 root netem delay 50ms` sur B (deuxieme cable) ne changeait rien au
 *    RTT vu de A : seul le cable du premier saut etait lu ;
 *  - un ping `-W 1` a travers un lien de 1,5 s recevait sa reponse ;
 *  - les horodatages de capture etaient `new Date()` bruts : pas l'horloge de la machine, et la
 *    fraction « .123000 » de tcpdump portait trois zeros inventes ;
 *  - la propagation de la fibre valait 3,3 ns/m, la vitesse de la lumiere dans le vide.
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`, `PathClock.ts` conserve) :
 * 7 des 10 cas tombent. Les trois qui passent des deux cotes sont NOMMES : « le temoin » (le labo
 * repond a un ping), « un lien sans delai ne perd aucune reponse » (non-regression du seuil de
 * delai d'attente) et « l'horloge de trajet ne recule jamais » (unite structurelle de `PathClock`).
 * Limite assumee : ni file d'attente ni latence de traitement d'equipement, faute de chiffre
 * source ; un RTT de LAN vaut donc quelques microsecondes.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PathClock } from '@/network/core/time/PathClock';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const MASK = new SubnetMask('255.255.255.0');

async function lab(hops = 1) {
  const a = new LinuxPC('linux-pc', 'A');
  const b = new LinuxPC('linux-pc', 'B');
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), MASK);
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), MASK);
  const switches = Array.from({ length: hops }, (_, i) => new GenericSwitch('switch-generic', `SW${i}`));
  const cables: Cable[] = [];
  let previous = a.getPort('eth0')!;
  switches.forEach((sw, i) => {
    const cable = new Cable(`c${i}a`);
    cable.connect(previous, sw.getPort('eth0')!);
    cables.push(cable);
    previous = sw.getPort('eth1')!;
  });
  const last = new Cable('last');
  last.connect(previous, b.getPort('eth0')!);
  cables.push(last);
  return { a, b, cables };
}

function virtualClock(): VirtualTimeScheduler {
  const scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  return scheduler;
}

async function rtts(host: LinuxPC, args = '-c 3 10.0.0.2'): Promise<number[]> {
  const out = String(await host.executeCommand(`ping ${args}`));
  return [...out.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1]));
}

describe('the path clock makes round-trip times physical', () => {
  it('the lab answers a ping — WITNESS', async () => {
    const { a } = await lab();
    expect((await rtts(a)).length).toBe(3);
  });

  it('the RTT is the same on every probe: no CPU time in it', async () => {
    const { a } = await lab();
    const values = await rtts(a, '-c 5 10.0.0.2');
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(0);
  });

  it('a second switch lengthens the path', async () => {
    const one = await rtts((await lab(1)).a);
    const two = await rtts((await lab(2)).a);
    expect(two[0]).toBeGreaterThan(one[0]);
  });

  it('netem delay on a cable that is not the first hop shows in the RTT', async () => {
    const { a, b } = await lab();
    await b.executeCommand('sudo tc qdisc add dev eth0 root netem delay 50ms');
    const values = await rtts(a);
    expect(values[0]).toBeGreaterThanOrEqual(50);
    expect(values[0]).toBeLessThan(51);
  });

  it('a reply that comes back after the wait timeout is lost', async () => {
    const { a, b } = await lab();
    await b.executeCommand('sudo tc qdisc add dev eth0 root netem delay 1500ms');
    expect(await rtts(a, '-c 2 -W 1 10.0.0.2')).toEqual([]);
  });

  it('a link without delay loses no reply to the wait timeout', async () => {
    const { a } = await lab();
    expect((await rtts(a, '-c 2 -W 1 10.0.0.2')).length).toBe(2);
  });

  it('the capture timestamps of a request and its reply differ by the RTT, in microseconds', async () => {
    virtualClock();
    const { a, b } = await lab();
    await b.executeCommand('sudo tc qdisc add dev eth0 root netem delay 3ms');
    await a.executeCommand('ping -c 1 10.0.0.2');
    const seen: number[] = [];
    a.attachCapture((tapped) => {
      if (tapped.frame.etherType === 0x0800) seen.push(tapped.atMicros);
    });
    const [rtt] = await rtts(a, '-c 1 10.0.0.2');
    expect(seen.length).toBe(2);
    expect((seen[1] - seen[0]) / 1000).toBeCloseTo(rtt, 2);
  });

  it('tcpdump prints the microsecond fraction of that difference, not three padded zeros', async () => {
    const scheduler = virtualClock();
    const { a, b } = await lab();
    await b.executeCommand('sudo tc qdisc add dev eth0 root netem delay 3ms');
    await a.executeCommand('ping -c 1 10.0.0.2');
    const capture = Promise.resolve(a.executeCommand('sudo timeout 1 tcpdump -n -tt -c 2 -i eth0 icmp'));
    await rtts(a, '-c 1 10.0.0.2');
    const lines = String(await scheduler.advanceUntilSettled(capture)).split('\n').filter((line) => /^\d+\.\d{6} /.test(line));
    expect(lines.length).toBe(2);
    const [first, second] = lines.map((line) => Number(line.split(' ')[0]));
    expect((second - first) * 1000).toBeGreaterThan(3);
    expect((second - first) * 1000).toBeLessThan(4);
    expect(lines.some((line) => !/\.\d{3}000 /.test(line))).toBe(true);
  });

  it('fibre propagates at 4.9 ns/m, not at the speed of light in vacuum', () => {
    const fiber = new Cable('f', { cableType: 'fiber-single', lengthMeters: 1000 });
    expect(fiber.getPropagationDelay()).toBeCloseTo(0.0049, 6);
  });

  it('the path clock never runs backwards inside a delivery and restores after it', () => {
    PathClock.reset();
    const before = PathClock.now();
    const inside = PathClock.carry(2, () => PathClock.carry(3, () => PathClock.now()));
    expect(inside).toBe(before + 5);
    expect(PathClock.now()).toBe(before + 5);
    PathClock.carry(4, () => undefined);
    expect(PathClock.now()).toBe(before + 9);
  });
});
