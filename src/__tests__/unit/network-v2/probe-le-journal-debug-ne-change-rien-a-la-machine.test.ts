/**
 * Sonde — le niveau `debug` du Logger est lu par celui qui le demande, pas construit pour tout le monde.
 *
 * Mesure d'origine (voir TODO.md [performance]) : une traversee de cable coutait 90 us avec le journal actif contre
 * 29 us quand les cinq sites chauds (cable:transmit, port:send, port:recv, switch:mac-learn, switch:forward) ne
 * construisent ni message ni entree ; 4 entrees `debug` sur 4,25 par traversee. Aucune n'a d'equivalent chez un vrai
 * equipement, et le seul lecteur cote appareil (LoggingConfig) ne tient que info / warn / error.
 *
 * Ce que la sonde prouve : le niveau `debug` est eteint par defaut, `reset()` le remet eteint, les cinq sites ne rendent
 * pas leurs adresses pour un message que personne ne lit — et SURTOUT que la machine ne voit pas la difference : meme
 * sortie de ping, memes compteurs de cable, meme flux info / warn / error, drapeau leve ou non. Deux champs sont
 * normalises avant comparaison, et ils le sont dans l'arbre d'avant aussi : l'identifiant d'un appareil porte l'horloge
 * murale de sa creation, et le `time Nms` de la derniere ligne de ping suit l'horloge de simulation, pompee en temps
 * reel : deux executions identiques different d'une ou deux millisecondes.
 *
 * Discrimination `git stash` : 3 cas sur 8 tombent contre l'arbre d'avant (« records no debug entry by default », « reset puts the level back off », « does not render the addresses… » ; on y appelle un setDebugEnabled
 * qui n'existe pas : l'assistant `setDebug` ci-dessous ne fait alors rien, donc le niveau reste allume comme avant).
 * Passent des deux cotes, et pourquoi :
 *  - « with debug on, a ping records the five hot events » — TEMOIN : prouve que le lab et l'instrument voient bien
 *    les entrees, donc qu'un « aucune entree » ailleurs n'est pas un banc muet.
 *  - « the machine answers the same with debug on and off », « the info / warn / error stream is the same » et
 *    « info, warn and error are recorded with debug off » — NON-REGRESSION : avant, le drapeau n'existait pas et
 *    les deux executions etaient identiques par construction ; ils figent que le drapeau ne deplace rien.
 *  - « silenced still mutes every level » — NON-REGRESSION de Logger.silenced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { MACAddress, resetCounters, createIPv4Packet, IPAddress, IP_PROTO_ICMP, ETHERTYPE_IPV4, type EthernetFrame, type ICMPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

const HOT_EVENTS = ['cable:transmit', 'port:send', 'port:recv', 'switch:mac-learn', 'switch:forward'];

const withoutWallClock = (text: string): string => text.replace(/\d{13}-\d+/g, '<id>').replace(/time \d+ms/g, 'time <t>ms');

const setDebug = (enabled: boolean): void => {
  if ('setDebugEnabled' in Logger) Logger.setDebugEnabled(enabled);
};

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab() {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  for (const device of [a, b, sw]) device.powerOn();
  const first = new Cable('c1');
  first.connect(a.getPorts()[0], sw.getPorts()[0]);
  const second = new Cable('c2');
  second.connect(b.getPorts()[0], sw.getPorts()[1]);
  await a.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
  await b.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  return { a, b, sw, cables: [first, second] };
}

async function session(debug: boolean) {
  setDebug(debug);
  const { a, b, sw, cables } = await lab();
  const ping = await a.executeCommand('ping -c 2 10.0.0.2');
  const counters = await b.executeCommand('ip -s link show eth0');
  Logger.warn(b.getId(), 'probe:warn', 'a warning');
  Logger.error(b.getId(), 'probe:error', 'an error');
  const kept = Logger.getLogs()
    .filter((entry) => entry.level !== 'debug')
    .map((entry) => withoutWallClock(`${entry.level} ${entry.source} ${entry.event} ${entry.message}`));
  return { ping, counters, cableStats: cables.map((cable) => JSON.stringify(cable.getStats())), kept, a, b, sw };
}

const events = (): string[] => Logger.getLogs().map((entry) => entry.event);

describe('Probe — the debug level costs nothing unless someone asks for it', () => {
  it('TEMOIN: with debug on, a ping records the five hot events', async () => {
    await session(true);
    for (const event of HOT_EVENTS) expect(events()).toContain(event);
  }, 60_000);

  it('records no debug entry by default', async () => {
    await session(false);
    expect(Logger.getLogs().filter((entry) => entry.level === 'debug')).toEqual([]);
  }, 60_000);

  it('reset puts the level back off', async () => {
    setDebug(true);
    Logger.reset();
    Logger.debug('probe', 'probe:debug', 'after reset');
    expect(events()).not.toContain('probe:debug');
  });

  it('does not render the addresses of a frame for a message nobody reads', async () => {
    const countFor = async (debug: boolean): Promise<number> => {
      setDebug(debug);
      const { a, b, cables } = await lab();
      await a.executeCommand('ping -c 1 10.0.0.2');
      const macA = a.getPorts()[0].getMAC();
      const frame = (sequence: number): EthernetFrame => {
        const icmp: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence, dataSize: 56 };
        return {
          srcMAC: macA, dstMAC: b.getPorts()[0].getMAC(), etherType: ETHERTYPE_IPV4,
          payload: createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), IP_PROTO_ICMP, 64, icmp, 64),
        };
      };
      const spy = vi.spyOn(MACAddress.prototype, 'toString');
      const before = cables[0].getStats().framesTransmitted;
      for (let i = 0; i < 20; i++) a.getPorts()[0].sendFrame(frame(i));
      const rendered = spy.mock.calls.length;
      spy.mockRestore();
      expect(cables[0].getStats().framesTransmitted - before).toBeGreaterThanOrEqual(20);
      return rendered;
    };
    const withDebug = await countFor(true);
    Logger.reset();
    EquipmentRegistry.resetInstance();
    const withoutDebug = await countFor(false);
    expect(withDebug).toBeGreaterThan(0);
    expect(withoutDebug).toBeLessThan(withDebug);
  }, 120_000);

  it('the machine answers the same with debug on and off', async () => {
    const on = await session(true);
    Logger.reset();
    EquipmentRegistry.resetInstance();
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    const off = await session(false);
    expect(withoutWallClock(off.ping)).toBe(withoutWallClock(on.ping));
    expect(off.counters).toBe(on.counters);
    expect(off.cableStats).toEqual(on.cableStats);
  }, 120_000);

  it('the info / warn / error stream is the same', async () => {
    const on = await session(true);
    Logger.reset();
    EquipmentRegistry.resetInstance();
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    const off = await session(false);
    expect(on.kept.length).toBeGreaterThan(1);
    expect(off.kept).toEqual(on.kept);
  }, 120_000);

  it('info, warn and error are recorded with debug off', () => {
    setDebug(false);
    Logger.info('s', 'probe:info', 'm');
    Logger.warn('s', 'probe:warn', 'm');
    Logger.error('s', 'probe:error', 'm');
    expect(events()).toEqual(['probe:info', 'probe:warn', 'probe:error']);
  });

  it('silenced still mutes every level', () => {
    setDebug(true);
    Logger.silenced(() => {
      Logger.debug('s', 'probe:debug', 'm');
      Logger.info('s', 'probe:info', 'm');
      Logger.error('s', 'probe:error', 'm');
    });
    expect(events()).toEqual([]);
  });
});
