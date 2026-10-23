/**
 * `ip ospf message-digest-key <id> md5 <cle>` etait range comme une cle SIMPLE : le gestionnaire ne gardait que le
 * mot suivant `md5` dans `authKey` et jetait l'identifiant, `show running-config` rendait alors
 * `ip ospf authentication-key SECRET` -- la ligne que l'operateur a tapee disparaissait --, `no ip ospf
 * message-digest-key 1` remettait l'authentification a zero au lieu de retirer la cle 1, deux routeurs dont les
 * identifiants de cle different (R1 `1 md5 SECRET`, R2 `2 md5 SECRET`) s'authentifiaient, et le paquet portait la
 * cle EN CLAIR (`authKey: 'SECRET'`) alors qu'un paquet MD5 porte l'identifiant, un numero de sequence et un
 * condense de 16 octets, jamais le secret.
 *
 * Autorite (regle 8) : la documentation officielle du depot,
 * official_docs/cisco/ios-ip-routing/ios-ip-routing-ospf-command-reference-2024.pdf, `ip ospf message-digest-key
 * md5` : l'identifiant va de 1 a 255, « the same key identifier on the neighbor router must have the same key
 * value », `no ip ospf message-digest-key key-id` retire UNE cle, plusieurs cles servent au passage d'une cle a
 * l'autre (« it sends multiple copies of the same packet, each authenticated by different keys »), la cle est
 * rendue en clair tant que `service password-encryption` n'est pas pose (exemple : `ip ospf message-digest-key 10 md5
 * xvv560qle` puis `19 md5 8ry4222` sur la meme interface) ; RFC 2328 Appendix D (le condense MD5 couvre le paquet et
 * la cle completee de zeros a 16 octets, le numero de sequence cryptographique ne decroit pas). Le simulateur n'a pas
 * de codec binaire OSPF : le condense couvre la serialisation canonique de l'objet paquet, pas la disposition
 * d'octets de la RFC -- limite nommee dans TODO.md.
 *
 * Discrimine par `git stash` sur src/network : 12 des 18 cas tombent avant.  Les 6 qui passent des deux cotes sont des
 * TEMOINS nommes dans les titres : deux routeurs avec le meme identifiant et le meme secret restent adjacents,
 * deux secrets differents sous le meme identifiant ne s'authentifient pas, un identifiant hors de 1 a 255 etait deja
 * refuse par la declaration de la commande, et les deux cas de passage de cle ou la derniere cle tapee est celle que
 * les deux routeurs partagent passent par accident avant (la derniere cle tapee etait la seule rangee), et le
 * temoin FortiGate a l'identifiant 1.
 *
 * Le test `ospf-interface-negation` listait `no ip ospf message-digest-key` NU parmi les negations « sans
 * diagnostic » : la syntaxe officielle est `no ip ospf message-digest-key key-id`, l'identifiant est obligatoire, la
 * forme nue est `% Incomplete command.` ; le test dit a present `no ip ospf message-digest-key 1`, et le cas
 * « n est pas rangee » ci-dessous epingle la forme nue.  La FortiGate (FirewallRouting) portait le meme defaut en
 * troisieme exemplaire : `md5Keys[0].key` copie dans `authKey`, l'identifiant jete, la cle posee apres le premier
 * Hello.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { encryptType7 } from '@/crypto';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});
afterEach(() => { __setDefaultScheduler(null); });

async function configure(router: CiscoRouter, lines: readonly string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

function interfaceLines(n: number, authentication: readonly string[]): string[] {
  return [
    'interface GigabitEthernet0/0', `ip address 10.0.0.${n} 255.255.255.252`, 'ip ospf network point-to-point',
    ...authentication, 'no shutdown', 'exit',
    'router ospf 1', `router-id ${n}.${n}.${n}.${n}`, 'network 10.0.0.0 0.0.0.3 area 0',
  ];
}

async function link(first: readonly string[], second: readonly string[]): Promise<CiscoRouter[]> {
  const routers = [new CiscoRouter('R1'), new CiscoRouter('R2')];
  await configure(routers[0], interfaceLines(1, first));
  await configure(routers[1], interfaceLines(2, second));
  new Cable('c').connect(routers[0].getPort('GigabitEthernet0/0')!, routers[1].getPort('GigabitEthernet0/0')!);
  horloge.advance(45_000);
  return routers;
}

const md5 = (id: number, secret: string): string[] => ['ip ospf authentication message-digest', `ip ospf message-digest-key ${id} md5 ${secret}`];

async function adjacent(router: CiscoRouter, peerId: string): Promise<boolean> {
  const row = (await router.executeCommand('show ip ospf neighbor')).split('\n').find((line) => line.startsWith(`${peerId} `)) ?? '';
  return / FULL\//.test(row);
}

describe('ip ospf message-digest-key range la cle sous son identifiant', () => {
  it('TEMOIN — meme identifiant, meme secret : les deux routeurs sont adjacents', async () => {
    const [r1, r2] = await link(md5(1, 'SECRET'), md5(1, 'SECRET'));
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
    expect(await adjacent(r2, '1.1.1.1')).toBe(true);
  });

  it('TEMOIN — meme identifiant, secrets differents : pas d adjacence', async () => {
    const [r1, r2] = await link(md5(1, 'SECRET'), md5(1, 'AUTRE'));
    expect(await adjacent(r1, '2.2.2.2')).toBe(false);
    expect(await adjacent(r2, '1.1.1.1')).toBe(false);
  });

  it('identifiants differents, meme secret : pas d adjacence', async () => {
    const [r1, r2] = await link(md5(1, 'SECRET'), md5(2, 'SECRET'));
    expect(await adjacent(r1, '2.2.2.2')).toBe(false);
    expect(await adjacent(r2, '1.1.1.1')).toBe(false);
  });

  it('le running-config rend la ligne tapee et ne la transforme pas en authentication-key', async () => {
    const [r1] = await link(md5(1, 'SECRET'), md5(1, 'SECRET'));
    const config = await r1.executeCommand('show running-config interface GigabitEthernet0/0');
    expect(config).toContain(' ip ospf authentication message-digest');
    expect(config).toContain(' ip ospf message-digest-key 1 md5 SECRET');
    expect(config).not.toContain('ip ospf authentication-key');
  });

  it('deux cles sur la meme interface sont rendues dans l ordre des identifiants, chacune a sa ligne', async () => {
    const [r1] = await link([...md5(19, '8ry4222'), 'ip ospf message-digest-key 10 md5 xvv560qle'], md5(19, '8ry4222'));
    const lines = (await r1.executeCommand('show running-config interface GigabitEthernet0/0')).split('\n');
    expect(lines.filter((line) => line.includes('message-digest-key'))).toEqual([
      ' ip ospf message-digest-key 10 md5 xvv560qle',
      ' ip ospf message-digest-key 19 md5 8ry4222',
    ]);
  });

  it('no ip ospf message-digest-key <id> retire cette cle et garde l authentification et les autres cles', async () => {
    const [r1] = await link([...md5(1, 'OLD'), 'ip ospf message-digest-key 2 md5 NEW', 'no ip ospf message-digest-key 1'], md5(2, 'NEW'));
    const config = await r1.executeCommand('show running-config interface GigabitEthernet0/0');
    expect(config).toContain(' ip ospf authentication message-digest');
    expect(config).toContain(' ip ospf message-digest-key 2 md5 NEW');
    expect(config).not.toContain('message-digest-key 1 ');
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
  });

  it('un identifiant hors de 1 a 255 est refuse, la cle n est pas rangee', async () => {
    const router = new CiscoRouter('R1');
    await configure(router, ['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252']);
    await router.executeCommand('enable'); await router.executeCommand('configure terminal'); await router.executeCommand('interface GigabitEthernet0/0');
    expect(await router.executeCommand('ip ospf message-digest-key 256 md5 X')).toContain("% Invalid input detected at '^' marker.");
    expect(await router.executeCommand('no ip ospf message-digest-key')).toContain('% Incomplete command.');
    await router.executeCommand('end');
    expect(await router.executeCommand('show running-config interface GigabitEthernet0/0')).not.toContain('message-digest-key');
  });
});

describe('le type de chiffrement de la cle : md5 [0|7] <cle>', () => {
  it('md5 7 <cle chiffree> est la meme cle que md5 <cle> : les deux routeurs sont adjacents', async () => {
    const [r1, r2] = await link(md5(1, 'SECRET'), ['ip ospf authentication message-digest', `ip ospf message-digest-key 1 md5 7 ${encryptType7('SECRET', 3)}`]);
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
    expect(await adjacent(r2, '1.1.1.1')).toBe(true);
  });

  it('md5 0 <cle> est la cle en clair, rendue sans le 0', async () => {
    const [r1] = await link(['ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 0 SECRET'], md5(1, 'SECRET'));
    expect(await r1.executeCommand('show running-config interface GigabitEthernet0/0')).toContain(' ip ospf message-digest-key 1 md5 SECRET\n');
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
  });

  it('avec service password-encryption la cle est rendue en type 7 et ne ressort pas en clair', async () => {
    const router = new CiscoRouter('R1');
    await configure(router, ['service password-encryption', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', ...md5(3, 'SECRET')]);
    const config = await router.executeCommand('show running-config interface GigabitEthernet0/0');
    expect(config).toMatch(/ ip ospf message-digest-key 3 md5 7 [0-9A-F]+\n/);
    expect(config).not.toContain('SECRET');
  });

  it('un mot autre que md5, un type inconnu ou une cle type 7 illisible sont refuses, rien n est range', async () => {
    const router = new CiscoRouter('R1');
    await configure(router, ['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252']);
    for (const line of ['ip ospf message-digest-key 1 sha1 SECRET', 'ip ospf message-digest-key 1 md5 5 SECRET', 'ip ospf message-digest-key 1 md5 7 zz']) {
      await router.executeCommand('enable'); await router.executeCommand('configure terminal'); await router.executeCommand('interface GigabitEthernet0/0');
      expect(await router.executeCommand(line)).toContain("% Invalid input detected at '^' marker.");
      await router.executeCommand('end');
    }
    expect(await router.executeCommand('show running-config interface GigabitEthernet0/0')).not.toContain('message-digest-key');
  });
});

describe('le secret ne circule pas : le paquet porte l identifiant et un condense', () => {
  it('aucun paquet sorti ne contient le secret, tous portent l identifiant de cle et un condense de 32 hexa', async () => {
    const routers = [new CiscoRouter('R1'), new CiscoRouter('R2')];
    const sent: { authType?: number; authKey?: string; authKeyId?: number; authDigest?: string }[] = [];
    routers[0].getBus().subscribeAll((event) => {
      if (event.topic === 'ospf.packet.outgoing') sent.push((event as unknown as { payload: { packet: typeof sent[number] } }).payload.packet);
    });
    await configure(routers[0], interfaceLines(1, md5(7, 'SECRET')));
    await configure(routers[1], interfaceLines(2, md5(7, 'SECRET')));
    new Cable('c').connect(routers[0].getPort('GigabitEthernet0/0')!, routers[1].getPort('GigabitEthernet0/0')!);
    horloge.advance(45_000);
    expect(sent.length).toBeGreaterThan(3);
    expect(JSON.stringify(sent)).not.toContain('SECRET');
    for (const packet of sent) {
      expect(packet.authType).toBe(2);
      expect(packet.authKeyId).toBe(7);
      expect(packet.authDigest).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('plusieurs cles : le passage d une cle a l autre', () => {
  it('TEMOIN — R1 garde les cles 1 et 2, R2 n a que la 2 : l adjacence se forme', async () => {
    const [r1, r2] = await link([...md5(1, 'OLD'), 'ip ospf message-digest-key 2 md5 NEW'], md5(2, 'NEW'));
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
    expect(await adjacent(r2, '1.1.1.1')).toBe(true);
  });

  it('R1 a ajoute la cle 2 mais R2 n a encore que la 1 : R1 signe aussi sous la cle 1 et l adjacence tient', async () => {
    const [r1, r2] = await link([...md5(1, 'OLD'), 'ip ospf message-digest-key 2 md5 NEW'], md5(1, 'OLD'));
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
    expect(await adjacent(r2, '1.1.1.1')).toBe(true);
  });

  it('TEMOIN — R1 n a que la cle 2, R2 garde les cles 1 et 2 : l adjacence se forme aussi', async () => {
    const [r1, r2] = await link(md5(2, 'NEW'), [...md5(1, 'OLD'), 'ip ospf message-digest-key 2 md5 NEW']);
    expect(await adjacent(r1, '2.2.2.2')).toBe(true);
    expect(await adjacent(r2, '1.1.1.1')).toBe(true);
  });

  it('une fois que le voisin signe avec la cle la plus recente, les paquets ne portent plus que celle-la', async () => {
    const routers = [new CiscoRouter('R1'), new CiscoRouter('R2')];
    const sent: { authKeyId?: number }[] = [];
    routers[0].getBus().subscribeAll((event) => {
      if (event.topic === 'ospf.packet.outgoing') sent.push((event as unknown as { payload: { packet: typeof sent[number] } }).payload.packet);
    });
    await configure(routers[0], interfaceLines(1, [...md5(1, 'OLD'), 'ip ospf message-digest-key 2 md5 NEW']));
    await configure(routers[1], interfaceLines(2, md5(2, 'NEW')));
    new Cable('c').connect(routers[0].getPort('GigabitEthernet0/0')!, routers[1].getPort('GigabitEthernet0/0')!);
    horloge.advance(45_000);
    sent.length = 0;
    horloge.advance(30_000);
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent.map((packet) => packet.authKeyId))]).toEqual([2]);
  });
});

describe('la FortiGate range ses cles sous leur identifiant, comme le routeur Cisco en face', () => {
  async function adjacencyWith(fortigateKeyId: number): Promise<boolean> {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const r1 = new CiscoRouter('R1');
    new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);
    for (const line of [
      'config system interface', 'edit port1', 'set mode static', 'set ip 192.168.100.99 255.255.255.0', 'next', 'end',
      'config router ospf', 'set router-id 10.255.255.1', 'config area', 'edit 0.0.0.0', 'next', 'end',
      'config network', 'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end',
      'config ospf-interface', 'edit "vers-R1"', 'set interface "port1"', 'set authentication md5',
      'config md5-keys', `edit ${fortigateKeyId}`, 'set key "CleOspfLab2026"', 'next', 'end', 'next', 'end', 'end',
    ]) await fgt.executeCommand(line);
    await configure(r1, [
      'interface GigabitEthernet0/1', 'ip address 192.168.100.1 255.255.255.0', 'no shutdown',
      'ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 CleOspfLab2026', 'exit',
      'router ospf 1', 'router-id 10.255.255.254', 'network 192.168.100.0 0.0.0.255 area 0',
    ]);
    horloge.advance(60_000);
    return /Full/.test(await fgt.executeCommand('get router info ospf neighbor'));
  }

  it('TEMOIN — meme identifiant 1 des deux cotes : adjacence', async () => {
    expect(await adjacencyWith(1)).toBe(true);
  });

  it('identifiants differents (FortiGate 2, Cisco 1), meme secret : pas d adjacence', async () => {
    expect(await adjacencyWith(2)).toBe(false);
  });
});
