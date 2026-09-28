/*
 * tcpdump, lance dans une ligne composee ou sous `timeout`, ecrivait son
 * en-tete APRES les paquets.
 *
 * Mesure de depart, sur le lab de l'utilisateur construit a la CLI :
 * Server3 capture pendant que PC1 pinge 192.168.40.11.
 *
 *   sudo timeout 4 tcpdump -i eth0 -n
 *   10:50:09.254000 ARP, Request who-has 192.168.1.99 tell 192.168.1.3, length 46
 *   10:50:09.261000 ARP, Request who-has 192.168.1.99 tell 192.168.1.1, length 46
 *   tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
 *   listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes
 *   2 packets captured
 *
 * tcpdump produit deja une vue entrelacee des deux flux, dans l'ordre ou
 * il les ecrit ; seul le chemin d'une commande isolee la lisait.
 * L'interpreteur bash, par ou passent une ligne composee et les
 * enveloppes, rendait la sortie puis l'erreur.
 *
 * L'AUTORITE EST TCPDUMP 4.99.1 (`tcpdump.c`, lu sur
 * the-tcpdump-group/tcpdump) : l'en-tete (« verbose output suppressed »,
 * « listening on ») part sur stderr AVANT la boucle de capture. Et quand
 * un signal interrompt la boucle (`cleanup` → `pcap_breakloop`, status
 * -2) alors que tcpdump imprime les paquets, il ecrit un saut de ligne
 * supplementaire sur stdout avant son pied. Au terminal, ce saut termine
 * l'echo `^C` ; sous `timeout`, rien ne l'a precede : c'est une ligne
 * vide.
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire l'interpreteur.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network
 * src/bash src/terminal`) : 3 des 5 cas tombent. Passent des deux cotes
 * les deux TEMOINS : stderr jete (`2>/dev/null`), il ne reste que les
 * paquets, ce que l'ancien rendu donnait deja ; et au terminal le pied
 * suit directement l'echo `^C`, qui tient lieu du saut de ligne de
 * tcpdump — le cas qui interdit d'ecrire ce saut quand l'interruption a
 * ete echoee.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
});

afterEach(() => { __setDefaultScheduler(null); });

const run = (pc: LinuxPC, command: string): Promise<string> =>
  scheduler.advanceUntilSettled(Promise.resolve(pc.executeCommand(command)));

async function captureDuringPing(capture: string): Promise<string[]> {
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  new Cable('a').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(b.getPorts()[0], sw.getPorts()[1]);
  await run(a, 'sudo ip addr add 10.0.0.1/24 dev eth0');
  await run(b, 'sudo ip addr add 10.0.0.2/24 dev eth0');
  const captured = Promise.resolve(a.executeCommand(capture));
  await run(b, 'ping -c 2 10.0.0.1');
  return (await scheduler.advanceUntilSettled(captured)).split('\n');
}

const HEADER = 'listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes';
const isPacket = (line: string) => /^\d\d:\d\d:\d\d\.\d{6} /.test(line);

describe('tcpdump writes in the order the terminal shows', () => {
  it('in a compound line, the header comes before the packets', async () => {
    const lines = await captureDuringPing('sudo timeout 3 tcpdump -i eth0 -n icmp; echo done');

    expect(lines.indexOf(HEADER)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(HEADER)).toBeLessThan(lines.findIndex(isPacket));
  });

  it('interrupted by a signal, it leaves a blank line before its footer', async () => {
    const lines = await captureDuringPing('sudo timeout 3 tcpdump -i eth0 -n icmp; echo done');
    const footer = lines.indexOf('4 packets captured');

    expect(footer).toBeGreaterThan(0);
    expect(lines[footer - 1]).toBe('');
    expect(isPacket(lines[footer - 2])).toBe(true);
  });

  it('ended by its count, it does not', async () => {
    const lines = await captureDuringPing('sudo tcpdump -c 2 -i eth0 -n icmp; echo done');
    const footer = lines.indexOf('2 packets captured');

    expect(footer).toBeGreaterThan(0);
    expect(isPacket(lines[footer - 1])).toBe(true);
  });

  it('with stderr thrown away, only the packets remain — WITNESS', async () => {
    const lines = await captureDuringPing('sudo timeout 3 tcpdump -i eth0 -n icmp 2>/dev/null; echo done');

    expect(lines.filter((l) => l !== '' && l !== 'done').every(isPacket)).toBe(true);
    expect(lines.filter(isPacket)).toHaveLength(4);
  });
});

describe('at the terminal, the echoed ^C already ends the line', () => {
  const key = (k: string, ctrlKey = false): KeyEvent => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

  it('the footer follows ^C directly — WITNESS', async () => {
    __setDefaultScheduler(null);
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const session = new LinuxTerminalSession('term-1', pc);
    session.setInput('sudo tcpdump');
    session.handleKey(key('Enter'));
    await tick();
    session.setPasswordBuf('admin');
    session.handleKey(key('Enter'));
    await tick();
    session.handleKey(key('c', true));
    await tick();

    const texts = session.lines.map((l) => l.text);
    const interrupt = texts.lastIndexOf('^C');
    expect(interrupt).toBeGreaterThan(0);
    expect(texts[interrupt + 1]).toBe('0 packets captured');
  });
});
