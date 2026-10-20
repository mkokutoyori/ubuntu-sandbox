/**
 * L'adresse qu'une plage de traduction distribue est celle que le noyau distribue. `find_best_ips_proto` (net/netfilter/nf_nat_core.c)
 * choisit dans la plage `min + reciprocal_scale(jhash2(source, destination ou 0 sous --persistent), distance)` : le choix est
 * deterministe, et c'est ce qui fait que « les serveurs voient le meme client depuis la meme adresse ». Les reponses attendues ne sont
 * pas celles d'une reecriture du meme algorithme : elles viennent du code du noyau lui-meme -- `include/linux/jhash.h` de la version 6.1
 * et `reciprocal_scale` de `include/linux/kernel.h`, compiles tels quels avec gcc et appeles sur les memes mots (l'adresse source lue en
 * memoire, octets dans l'ordre du fil, puis trois mots nuls ; l'initialisation est l'adresse de destination, lue de meme, ou zero).
 *
 * Mesure de depart (cd198baf ; passerelle qui porte 203.0.113.9 a .12, `-A POSTROUTING -o eth1 -p udp -j SNAT --to-source
 * 203.0.113.9-203.0.113.12`, un datagramme de chacun de deux hotes internes) : les sources sortaient intactes, 10.0.0.2 et 10.0.0.3, la
 * plage n'etant pas appliquee. Les sept couples ci-dessous tombent a des decalages de 99, 44, 34, 98, 74, 91 et 52 dans une plage de
 * cent adresses (97, 97, 82, 62, 12, 73 et 86 sous --persistent). La fonction qui calcule ce choix n'existait pas, le fichier ne peut
 * donc pas tourner contre l'arbre de base ; il sert aussi de preuve de la ronde du hash, que rien d'autre ne lit : sans lui, les
 * dix-neuf mutants de jhash2 qui survivaient ne pouvaient etre tues par aucun comportement.
 *
 * Le second bloc lit `uniqueTuple` dans un monde de substitution (`NatWorld`) dont les tirages sont fixes, pour les chemins que la
 * sonde de bout en bout ne peut pas viser parce qu'elle ne choisit pas le hasard : les trois plages par defaut de
 * `nf_nat_l4proto_unique_tuple` (1-511, 600-1023, 1024-65535, selon la classe du port d'origine), l'identifiant d'echo sur 0-65535, le
 * decalage `off = port - base` pris en entier non signe sur 32 bits (un port sous la base ne se replie pas sur 16 bits), la reutilisation
 * d'une traduction deja faite (`find_appropriate_src`), les bornes d'une plage de ports, et l'epuisement des essais (128, puis 64, 32, 16
 * et 8, un nouveau tirage a chaque tour). Chaque resultat attendu se calcule a la main depuis le C. Mesure de depart : `uniqueKey` tirait
 * son decalage de base sur 16 bits, si bien qu'un port de destination de 8999 sous la base 9000 allait en 8008 au lieu de 8003.
 *
 * Le troisieme bloc lit `ConnectionTracker` seul, pour ce que la sonde de bout en bout ne peut pas viser parce que le moteur est
 * synchrone et ne laisse jamais deux flux en vol : un flux n'est lie qu'une fois (`nf_nat_inet_fn` ne relit pas la chaine pour un flux
 * dont le crochet est initialise), et deux flux en vol qui ont choisi le meme tuple de reponse se departagent a l'insertion
 * (`__nf_conntrack_confirm` : `insert_failed`, le paquet du second est jete), un tuple tenu par un flux echu etant libre a l'instant
 * de l'echeance et pas une milliseconde avant. Le TEMOIN du bloc est le meme laboratoire avec un second flux qui choisit un autre port :
 * les deux entrent. Les seize mutants que ces cas tuent (la comparaison d'echeance, la condition de refus, la valeur rendue au
 * refus, la garde et l'initialisation du crochet, la garde de la traduction d'erreur, l'indexation d'un flux avant son insertion qui
 * est aussi son reindexage sous le nouveau tuple, les sept conditions du filtre des traductions deja faites -- protocole, hote,
 * port, identifiant, et la facon dont elles se combinent --, et les deux decalages du generateur de tirages, qui doit couvrir seize
 * bits) survivaient aux sondes de bout en bout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { PathClock } from '@/network/core/time/PathClock';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { jhash2, reciprocalScale, uniqueTuple, type NatWorld } from '@/network/devices/linux/NatMapping';
import type { NatRange } from '@/network/devices/linux/NatRange';
import { ConnectionTracker, type ConnectionTuple, type TrackedPacket } from '@/network/devices/linux/ConnectionTracker';

describe('the address a range hands out is the one the kernel hands out', () => {
  const memoryWord = (ip: string): number => {
    const [a, b, c, d] = ip.split('.').map(Number);
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  };

  const vectors: ReadonlyArray<readonly [string, string, number, number, number, number]> = [
    ['10.0.0.2', '203.0.113.2', 4269181698, 4196863909, 99, 97],
    ['10.0.0.2', '8.8.8.8', 1895213053, 4196863909, 44, 97],
    ['10.0.0.3', '203.0.113.2', 1477263203, 3560244302, 34, 82],
    ['192.168.1.77', '198.51.100.254', 4231714828, 2696702155, 98, 62],
    ['172.16.5.9', '1.1.1.1', 3179851391, 521002489, 74, 12],
    ['0.0.0.0', '8.8.8.8', 3943787836, 3136882572, 91, 73],
    ['255.255.255.255', '1.1.1.1', 2258168723, 3709219277, 52, 86],
  ];

  const currentTuple = (source: string, destination: string): ConnectionTuple => ({
    protocol: 17, srcIP: source, srcPort: 40000, dstIP: destination, dstPort: 5000,
  });

  const pool = (persistent: boolean): NatRange => ({
    addresses: { min: new IPAddress('203.0.113.100'), max: new IPAddress('203.0.113.199') },
    ports: null, random: false, randomFully: false, persistent,
  });

  const world = { taken: () => false, mappedSources: () => [], randomOffset: () => 0 };

  it.each(vectors)('jhash2 of %s toward %s is %d, and %d without the destination', (source, destination, normal, persistent) => {
    const words = [memoryWord(source), 0, 0, 0];
    expect(jhash2(words, memoryWord(destination))).toBe(normal);
    expect(jhash2(words, 0)).toBe(persistent);
  });

  it.each(vectors)('the range 203.0.113.100-203.0.113.199 gives %s toward %s the address at offsets %d and %d', (source, destination, normal, persistent, normalOffset, persistentOffset) => {
    const current = currentTuple(source, destination);
    expect(uniqueTuple(current, pool(false), 'source', world).srcIP).toBe(`203.0.113.${100 + normalOffset}`);
    expect(uniqueTuple(current, pool(true), 'source', world).srcIP).toBe(`203.0.113.${100 + persistentOffset}`);
    expect(reciprocalScale(normal, 100)).toBe(normalOffset);
    expect(reciprocalScale(persistent, 100)).toBe(persistentOffset);
  });

  it('reciprocal_scale does not lose bits when the product is wider than a double', () => {
    expect(reciprocalScale(4269181698, 0xfffffff0)).toBe(4269181682);
    expect(reciprocalScale(1895213053, 0xfffffff0)).toBe(1895213045);
    expect(reciprocalScale(4269181698, 0x01000000)).toBe(16676491);
  });

  it('the lengths that stop on a block of three, or on none, give the kernel numbers too', () => {
    expect(jhash2([1000, 2000], 21)).toBe(1045075550);
    expect(jhash2([10, 20, 30], 11)).toBe(4145087357);
    expect(jhash2([7, 8, 9, 10], 17)).toBe(3475691126);
    expect(jhash2([1, 2, 3, 4, 5, 6], 13)).toBe(1863683728);
    expect(jhash2([9, 8, 7, 6, 5, 4, 3, 2, 1], 99)).toBe(3713447626);
  });

  it('the length of the key counts : words of 1, 5 and 7 give the kernel numbers', () => {
    expect(jhash2([1, 2, 3, 4, 5], 7)).toBe(1515141918);
    expect(jhash2([11, 22, 33, 44, 55, 66, 77], 9)).toBe(1680845371);
    expect(jhash2([0xdeadbeef], 3)).toBe(1361672343);
    expect(jhash2([], 5)).toBe(3735928564);
  });
});

describe('the unique tuple falls where nf_nat_l4proto_unique_tuple puts it', () => {
  const UDP = 17;
  const ICMP = 1;
  const open: NatRange = { addresses: null, ports: null, random: false, randomFully: false, persistent: false };
  const portsOf = (min: number, max: number, base: number | null = null): NatRange => ({ ...open, ports: { min, max, base } });
  const udp = (srcPort: number, dstPort = 5000): ConnectionTuple => ({ protocol: UDP, srcIP: '10.0.0.2', srcPort, dstIP: '203.0.113.2', dstPort });
  const echo = (id: number): ConnectionTuple => ({ protocol: ICMP, srcIP: '10.0.0.2', srcPort: 0, dstIP: '203.0.113.2', dstPort: 0, icmpType: 8, icmpCode: 0, icmpId: id });
  const same = (first: ConnectionTuple, second: ConnectionTuple): boolean => JSON.stringify(first) === JSON.stringify(second);

  const world = (taken: (candidate: ConnectionTuple) => boolean, offsets: readonly number[], mapped: readonly ConnectionTuple[] = []): NatWorld => {
    let drawn = 0;
    return { taken, mappedSources: () => mapped, randomOffset: () => offsets[Math.min(drawn++, offsets.length - 1)] };
  };
  const occupied = (current: ConnectionTuple, ...offsets: number[]): NatWorld => world((candidate) => same(candidate, current), offsets);

  it.each([
    [100, 0, 1], [100, 510, 511], [100, 511, 1],
    [511, 0, 1], [512, 0, 600], [512, 423, 1023], [512, 424, 600],
    [1023, 0, 600], [5000, 0, 1024], [5000, 64511, 65535], [5000, 64512, 1024],
  ])('a source port of %d with the offset %d is moved to %d, in the default range of its class', (port, offset, expected) => {
    const current = udp(port);
    expect(uniqueTuple(current, open, 'source', occupied(current, offset)).srcPort).toBe(expected);
  });

  it.each([[0, 0], [65535, 65535], [65536, 0]])('an echo identifier is moved over 0-65535 : the offset %d gives %d', (offset, expected) => {
    const current = echo(5);
    expect(uniqueTuple(current, open, 'source', occupied(current, offset)).icmpId).toBe(expected);
  });

  it('a destination is never given another port when the rule names none', () => {
    const current = udp(40000, 8080);
    expect(uniqueTuple(current, open, 'destination', occupied(current, 3))).toEqual(current);
  });

  it.each([[6, 'TCP'], [17, 'UDP'], [136, 'UDP-Lite'], [132, 'SCTP'], [33, 'DCCP']])('protocol %d (%s) carries ports : a source port outside the range is moved into it', (protocol) => {
    const current = { ...udp(5000), protocol };
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', occupied(current, 5)).srcPort).toBe(1005);
  });

  it('a protocol that carries no ports keeps its tuple whatever the range says', () => {
    const current = { ...udp(5000), protocol: 47 };
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', occupied(current, 5))).toEqual(current);
  });

  it('a range that is all taken gives back the last candidate it tried, after as many tries as the range is wide', () => {
    const current = udp(5);
    expect(uniqueTuple(current, portsOf(1000, 1002), 'source', world(() => true, [0])).srcPort).toBe(1002);
  });

  it('a wide range that is all taken halves its tries from 128 down to 8, drawing a new offset each time', () => {
    const current = udp(5000);
    expect(uniqueTuple(current, open, 'source', world(() => true, [0, 100, 200, 300, 400])).srcPort).toBe(1024 + 407);
  });

  it.each([[9003, 8003], [9013, 8002], [8999, 8003]])('a destination port of %d is mapped by offset onto 8000-8010 from the base 9000 : %d', (port, expected) => {
    const current = udp(40000, port);
    expect(uniqueTuple(current, portsOf(8000, 8010, 9000), 'destination', world(() => false, [0])).dstPort).toBe(expected);
  });

  it('a destination port ten under the base walks on from its 32-bit offset : 4294967286 gives 8005, and 4294967287 the next candidate 8006', () => {
    const current = udp(40000, 8990);
    const taken = (candidate: ConnectionTuple): boolean => candidate.dstPort === 8005;
    expect(uniqueTuple(current, portsOf(8000, 8010, 9000), 'destination', world(taken, [0])).dstPort).toBe(8006);
  });

  it.each([[1000, 1000], [1500, 1500], [2000, 2000]])('a source port of %d inside 1000-2000 stays where it is even if the same source was mapped before', (port, expected) => {
    const current = udp(port);
    const earlier = udp(1200);
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', world(() => false, [0], [earlier])).srcPort).toBe(expected);
  });

  it.each([[999, 1005], [2001, 1005]])('a source port of %d outside 1000-2000 is moved into the range : %d', (port, expected) => {
    const current = udp(port);
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', world((candidate) => same(candidate, current), [5])).srcPort).toBe(expected);
  });

  it('a source that was mapped before keeps its mapping when the mapping is inside the range and free', () => {
    const current = udp(5000);
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', world(() => false, [5], [udp(1500)])).srcPort).toBe(1500);
  });

  it('it does not reuse a mapping that is taken, nor one that is outside the range', () => {
    const current = udp(5000);
    const busy = world((candidate) => candidate.srcPort === 1500, [5], [udp(1500)]);
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', busy).srcPort).toBe(1005);
    expect(uniqueTuple(current, portsOf(1000, 2000), 'source', world(() => false, [5], [udp(3000)])).srcPort).toBe(1005);
  });

  it.each([[8000, 8000], [8010, 8010]])('a destination port of %d inside 8000-8010 is left alone', (port, expected) => {
    const current = udp(40000, port);
    expect(uniqueTuple(current, portsOf(8000, 8010), 'destination', world(() => false, [4])).dstPort).toBe(expected);
  });

  it.each([[7999, 8004], [8011, 8004]])('a destination port of %d outside 8000-8010 is moved into it : %d', (port, expected) => {
    const current = udp(40000, port);
    expect(uniqueTuple(current, portsOf(8000, 8010), 'destination', world(() => false, [4])).dstPort).toBe(expected);
  });
});

describe('a flow is bound once, and a flow whose reply tuple another flow holds is refused when it is inserted', () => {
  beforeEach(() => {
    __setDefaultScheduler(new VirtualTimeScheduler());
  });

  const pinnedTo = (port: number): NatRange => ({
    addresses: { min: new IPAddress('203.0.113.1'), max: new IPAddress('203.0.113.1') },
    ports: { min: port, max: port, base: null }, random: false, randomFully: false, persistent: false,
  });
  const request = (source: string, sourcePort: number): TrackedPacket => ({
    protocol: 17, srcIP: source, srcPort: sourcePort, dstIP: '198.51.100.9', dstPort: 53,
  });
  const bound = (tracker: ConnectionTracker, source: string, sourcePort: number, port: number) => {
    const entry = tracker.enter(request(source, sourcePort));
    tracker.bind(entry, pinnedTo(port), 'source');
    return entry;
  };

  it('the first bind initializes the hook and a second bind leaves the mapping where it was', () => {
    const tracker = new ConnectionTracker(4);
    const entry = tracker.enter(request('10.0.0.2', 5000));
    expect(tracker.initialized(entry, 'source')).toBe(false);
    tracker.bind(entry, pinnedTo(4000), 'source');
    expect(tracker.initialized(entry, 'source')).toBe(true);
    tracker.confirm(entry);
    tracker.bind(entry, pinnedTo(4100), 'source');
    expect(tracker.flows()[0].reply).toMatchObject({ dstIP: '203.0.113.1', dstPort: 4000 });
  });

  it('TEMOIN : two flows in flight that chose different reply tuples are both inserted', () => {
    const tracker = new ConnectionTracker(4);
    const first = bound(tracker, '10.0.0.2', 5000, 4000);
    const second = bound(tracker, '10.0.0.3', 6000, 4001);
    expect(tracker.confirm(first)).toBe(true);
    expect(tracker.confirm(second)).toBe(true);
    expect(tracker.statistics.insert_failed).toBe(0);
    expect(tracker.flows()).toHaveLength(2);
  });

  it('two flows in flight that chose the same reply tuple : the second is refused and counted, the first stays', () => {
    const tracker = new ConnectionTracker(4);
    const first = bound(tracker, '10.0.0.2', 5000, 4000);
    const second = bound(tracker, '10.0.0.3', 6000, 4000);
    expect(tracker.confirm(first)).toBe(true);
    expect(tracker.confirm(second)).toBe(false);
    expect(tracker.statistics.insert_failed).toBe(1);
    expect(tracker.flows().map((flow) => flow.original.srcIP)).toEqual(['10.0.0.2']);
  });

  it('only an ICMP error has an error translation : the answer of the flow itself has none', () => {
    const tracker = new ConnectionTracker(4);
    const flow = bound(tracker, '10.0.0.2', 5000, 4000);
    tracker.confirm(flow);
    const answer = tracker.enter({ protocol: 17, srcIP: '198.51.100.9', srcPort: 53, dstIP: '203.0.113.1', dstPort: 4000 });
    expect(answer.state).toBe('ESTABLISHED');
    expect(tracker.errorTranslation(answer, 'destination')).toBeNull();
    const error = tracker.enter({
      protocol: 1, srcIP: '198.51.100.9', srcPort: 0, dstIP: '203.0.113.1', dstPort: 0, icmpType: 3,
      related: { protocol: 17, srcIP: '203.0.113.1', srcPort: 4000, dstIP: '198.51.100.9', dstPort: 53 },
    });
    expect(error.state).toBe('RELATED');
    expect(tracker.errorTranslation(error, 'destination')?.inner).toEqual({ side: 'source', address: '10.0.0.2', key: 5000 });
  });

  it('a flow that was bound and never inserted leaves nothing in the table', () => {
    const tracker = new ConnectionTracker(4);
    bound(tracker, '10.0.0.2', 5000, 4000);
    expect(tracker.flows()).toEqual([]);
  });

  it('a flow that is already in the table is found under its new reply tuple after a bind, and no longer under the old one', () => {
    const tracker = new ConnectionTracker(4);
    const entry = tracker.enter(request('10.0.0.2', 5000));
    tracker.confirm(entry);
    tracker.bind(entry, pinnedTo(4000), 'source');
    const answerTo = (port: number, address: string) => tracker.classify({
      protocol: 17, srcIP: '198.51.100.9', srcPort: 53, dstIP: address, dstPort: port,
    });
    expect(answerTo(4000, '203.0.113.1')).toBe('ESTABLISHED');
    expect(answerTo(5000, '10.0.0.2')).toBe('NEW');
  });

  describe('a source socket that was mapped before', () => {
    const wide: NatRange = { ...pinnedTo(1000), ports: { min: 1000, max: 2000, base: null } };
    const mappedPorts = (...packets: TrackedPacket[]): Array<number | undefined> => {
      const tracker = new ConnectionTracker(4);
      return packets.map((packet) => {
        const entry = tracker.enter(packet);
        tracker.bind(entry, wide, 'source');
        tracker.confirm(entry);
        return tracker.flows().find((flow) => flow.original.protocol === packet.protocol && flow.original.srcIP === packet.srcIP
          && flow.original.srcPort === packet.srcPort && flow.original.dstIP === packet.dstIP)?.reply.dstPort;
      });
    };
    const toward = (peer: string, source = '10.0.0.2', sourcePort = 5000): TrackedPacket => ({ ...request(source, sourcePort), dstIP: peer });

    it('keeps its translated port toward another peer', () => {
      const [first, again] = mappedPorts(toward('198.51.100.9'), toward('198.51.100.10'));
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThanOrEqual(2000);
      expect(again).toBe(first);
    });

    it('does not lend it to another host with the same port, to the same host with another port, nor to another protocol', () => {
      const [first, otherHost, otherPort, otherProtocol] = mappedPorts(
        toward('198.51.100.9'),
        toward('198.51.100.10', '10.0.0.3'),
        toward('198.51.100.11', '10.0.0.2', 5001),
        { ...toward('198.51.100.12'), protocol: 6, tcpFlags: 0x02 },
      );
      expect(new Set([first, otherHost, otherPort, otherProtocol]).size).toBe(4);
    });
  });

  it('a random choice draws sixteen bits : sixty flows reach both ends of the default range', () => {
    const tracker = new ConnectionTracker(4);
    const random: NatRange = { addresses: null, ports: null, random: true, randomFully: false, persistent: false };
    const ports = Array.from({ length: 60 }, (_, index) => {
      const entry = tracker.enter({ ...request('10.0.0.2', 5000 + index), dstIP: `198.51.100.${index + 1}` });
      tracker.bind(entry, random, 'source');
      tracker.confirm(entry);
      return tracker.flows().find((flow) => flow.original.srcPort === 5000 + index)?.reply.dstPort as number;
    });
    expect(Math.max(...ports)).toBeGreaterThan(40000);
    expect(Math.min(...ports)).toBeLessThan(20000);
  });

  const secondAfter = (waitMs: number): boolean => {
    const tracker = new ConnectionTracker(4);
    const first = bound(tracker, '10.0.0.2', 5000, 4000);
    const second = bound(tracker, '10.0.0.3', 6000, 4000);
    tracker.confirm(first);
    PathClock.wait(waitMs);
    return tracker.confirm(second);
  };

  it('a reply tuple held by a flow is still taken a millisecond before that flow expires', () => {
    expect(secondAfter(29_999)).toBe(false);
  });

  it('and it is free at the moment the flow expires : the second flow is inserted in its place', () => {
    expect(secondAfter(30_000)).toBe(true);
  });
});
