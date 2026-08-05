/**
 * NQA (VRP) — le jumeau Huawei d'IP SLA, sur le même moteur de sondes.
 *
 * `NqaEngine` existait, avec les bonnes structures, et n'était alimenté
 * par personne : `recordProbeBatch()` et `isTrackUp()` n'avaient aucun
 * appelant, `display nqa results` affichait donc `Min/Max/Avg RTT:
 * 0/0/0 ms` pour n'importe quelle topologie, et `track nqa` n'était
 * même pas câblé — `HuaweiVRPShell` n'appelait jamais
 * `setRouteTrackResolver` (docs/PRD-NQA.md §0.1).
 *
 * Ce fichier vérifie aussi ce qui distingue NQA d'IP SLA plutôt que ce
 * qui les rapproche : `frequency 0` par défaut (une seule passe), le lot
 * de `probe-count` sondes comme unité de résultat, et `fail-percent`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

/**
 * Le moteur bat toutes les 100 ms ; avancer par pas plus fins ne change
 * rien au résultat et coûte une macrotâche réelle par pas. Les sondes se
 * règlent par promesses, donc vider la file de microtâches suffit à les
 * laisser progresser.
 */
async function settle(ms: number): Promise<void> {
  const step = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.advance(step);
    for (let flush = 0; flush < 12; flush++) await Promise.resolve();
  }
}

/** R1(VRP) ── R2(VRP) ── PC : la cible est deux sauts plus loin. */
async function buildLab() {
  const r1 = new HuaweiRouter('R1');
  const r2 = new HuaweiRouter('R2');
  const pc = new LinuxPC('PC1');

  new Cable('c-r1-r2').connect(
    r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
  const access = new Cable('c-r2-pc');
  access.connect(r2.getPort('GE0/0/1')!, pc.getPort('eth0')!);

  for (const command of [
    'system-view',
    'interface GE0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'undo shutdown', 'quit',
    'ip route-static 192.168.1.0 255.255.255.0 10.0.0.2',
  ]) await r1.executeCommand(command);

  for (const command of [
    'system-view',
    'interface GE0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'undo shutdown', 'quit',
    'interface GE0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'undo shutdown', 'quit',
  ]) await r2.executeCommand(command);

  pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('192.168.1.1'));

  return { r1, r2, pc, access };
}

async function defineIcmpTest(
  router: HuaweiRouter,
  extra: string[] = [],
): Promise<void> {
  for (const command of [
    'nqa test-instance admin test1',
    'test-type icmp',
    'destination-address ipv4 192.168.1.10',
    ...extra,
    'start now',
    'quit',
  ]) await router.executeCommand(command);
}

describe('NQA — la sonde mesure vraiment', () => {
  it('un test icmp rend un lot de trois sondes et un RTT', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    await settle(15000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.sent).toBe(3);
    expect(test.received).toBe(3);
    expect(test.completion).toBe('success');

    const results = await r1.executeCommand('display nqa results test-instance admin test1');
    expect(results).toContain('NQA entry(admin, test1)');
    expect(results).toContain('Send operation times: 3');
    expect(results).toContain('Receive response times: 3');
    expect(results).toContain('Completion:success');
    expect(results).toContain('Destination ip address:192.168.1.10');
  });

  it('LE CAS : la cible tombe, la route de R1 ne bouge pas, le test échoue', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await settle(15000);
    expect(r1.getNqaService().get('admin', 'test1')!.completion).toBe('success');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    expect(r1.getPort('GE0/0/0')!.isOperationallyUp()).toBe(true);
    expect(r1.getRoutingTable().some((route) =>
      String(route.network) === '192.168.1.0')).toBe(true);

    await settle(30000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.received).toBe(0);
    expect(test.completion).not.toBe('success');
    const results = await r1.executeCommand('display nqa results test-instance admin test1');
    expect(results).toContain('Receive response times: 0');
  });
});

describe('NQA — ce qui le distingue d\'IP SLA', () => {
  it('frequency 0 (le défaut VRP) exécute UNE passe et s\'arrête', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    await settle(15000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.attempts).toBe(1);
    expect(test.finished).toBe(true);
    expect(await r1.executeCommand('display nqa results test-instance admin test1'))
      .toContain('The test is finished');

    // Une minute de plus ne relance rien : c'est ce que veut dire
    // « une passe », et c'est l'inverse du défaut d'IOS.
    await settle(60000);
    expect(r1.getNqaService().get('admin', 'test1')!.attempts).toBe(1);
  });

  it('frequency 10 répète les passes', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await settle(15000);
    const first = r1.getNqaService().get('admin', 'test1')!.attempts;
    expect(first).toBeGreaterThanOrEqual(1);

    await settle(25000);
    expect(r1.getNqaService().get('admin', 'test1')!.attempts).toBeGreaterThan(first);
  });

  it('probe-count fixe la taille du lot', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['probe-count 5', 'interval milliseconds 20']);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.sent).toBe(5);
    expect(test.received).toBe(5);
    expect(test.history.length).toBe(5);
  });

  it('fail-percent : une perte sur trois reste un succès par défaut', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['interval milliseconds 20']);
    await settle(5000);

    const service = r1.getNqaService();
    const test = service.get('admin', 'test1')!;
    const runtime = service.runtimeOf(test)!;
    expect(runtime.config.failPercent).toBe(100);

    // Le défaut VRP est « échec seulement si tout se perd ».
    await r1.executeCommand('nqa test-instance admin test1');
    expect(await r1.executeCommand('fail-percent 1')).toBe('');
    expect(service.runtimeOf(test)!.config.failPercent).toBe(1);
  });

  it('threshold rtd compte les dépassements sans faire échouer le test', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['threshold rtd 5000', 'interval milliseconds 20']);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.completion).toBe('success');
    expect(await r1.executeCommand('display nqa results test-instance admin test1'))
      .toContain('RTD OverThresholds number: 0');
  });

  it('un test-type que VRP connaît mais que ce simulateur ne peut pas mesurer est refusé', async () => {
    const { r1 } = await buildLab();
    await r1.executeCommand('nqa test-instance admin test2');
    const refusal = await r1.executeCommand('test-type lspping');
    expect(refusal).toContain('not supported in this simulator');
    expect(refusal).toContain('MPLS');
    expect(r1.getNqaService().get('admin', 'test2')!.testType).toBeNull();
  });

  it('un test-type inexistant est refusé, pas stocké', async () => {
    const { r1 } = await buildLab();
    await r1.executeCommand('nqa test-instance admin test3');
    expect(await r1.executeCommand('test-type nimportequoi')).toContain('Wrong parameter');
    expect(r1.getNqaService().get('admin', 'test3')!.testType).toBeNull();
  });
});

describe('NQA — track nqa conditionne vraiment une route', () => {
  it('la route statique quitte la table quand le test échoue', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await r1.executeCommand('ip route-static 172.16.0.0 255.255.0.0 10.0.0.2 track nqa admin test1');
    await settle(15000);

    expect(r1.getNqaService().isTrackUp('admin', 'test1')).toBe(true);
    expect(await r1.executeCommand('display ip routing-table')).toContain('172.16.0.0');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(30000);

    expect(r1.getNqaService().isTrackUp('admin', 'test1')).toBe(false);
    expect(await r1.executeCommand('display ip routing-table')).not.toContain('172.16.0.0');
  });

  it('la route par défaut aussi est conditionnée', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await r1.executeCommand('ip route-static 0.0.0.0 0.0.0.0 10.0.0.2 track nqa admin test1');
    await settle(15000);
    expect(await r1.executeCommand('display ip routing-table')).toContain('0.0.0.0/0');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(30000);

    expect(await r1.executeCommand('display ip routing-table')).not.toContain('0.0.0.0/0');
  });
});

describe('NQA — le serveur', () => {
  it('nqa-server udpecho ouvre un port qu\'un test udp atteint', async () => {
    const { r1, r2 } = await buildLab();
    for (const command of [
      'nqa-server udpecho 10.0.0.2 5000',
    ]) await r2.executeCommand(command);

    for (const command of [
      'nqa test-instance admin udp1',
      'test-type udp',
      'destination-address ipv4 10.0.0.2',
      'destination-port 5000',
      'interval milliseconds 20',
      'start now',
      'quit',
    ]) await r1.executeCommand(command);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'udp1')!;
    expect(test.received).toBe(3);
    expect(test.completion).toBe('success');
    expect(await r2.executeCommand('display nqa-server')).toContain('udpecho server: 10.0.0.2');
  });

  it('sans nqa-server, le même test échoue', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'nqa test-instance admin udp1',
      'test-type udp',
      'destination-address ipv4 10.0.0.2',
      'destination-port 5000',
      'interval milliseconds 20',
      'start now',
      'quit',
    ]) await r1.executeCommand(command);
    await settle(20000);

    const test = r1.getNqaService().get('admin', 'udp1')!;
    expect(test.received).toBe(0);
    expect(test.completion).not.toBe('success');
  });
});

describe('NQA — la configuration est relue telle qu\'elle a été tapée', () => {
  it('display current-configuration reproduit le bloc nqa test-instance', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, [
      'frequency 30', 'probe-count 5', 'timeout 2',
      'description sonde-wan', 'threshold rtd 200',
    ]);
    await r1.executeCommand('nqa-server udpecho 10.0.0.1 5000');

    const config = await r1.executeCommand('display current-configuration');
    expect(config).toContain('nqa test-instance admin test1');
    expect(config).toContain(' test-type icmp');
    expect(config).toContain(' destination-address ipv4 192.168.1.10');
    expect(config).toContain(' frequency 30');
    expect(config).toContain(' probe-count 5');
    expect(config).toContain(' timeout 2');
    expect(config).toContain(' description sonde-wan');
    expect(config).toContain(' threshold rtd 200');
    expect(config).toContain('nqa-server udpecho 10.0.0.1 5000');
  });

  it('les valeurs par défaut VRP ne sont pas rendues', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    const config = await r1.executeCommand('display current-configuration');
    expect(config).toContain('nqa test-instance admin test1');
    expect(config).not.toContain(' frequency 0');
    expect(config).not.toContain(' probe-count 3');
    expect(config).not.toContain(' timeout 3');
  });
});

describe('NQA — le moteur partagé n\'a pas changé de comportement pour IOS', () => {
  it('une opération IP SLA garde une sonde par cycle', async () => {
    const router = new CiscoRouter('R1');
    const pc = new LinuxPC('PC1');
    new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    pc.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.252'));

    for (const command of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'ip sla 1', 'icmp-echo 10.0.0.2', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await router.executeCommand(command);

    await settle(200);
    const runtime = router.getIpSlaEngine().getOperation(1)!;
    expect(runtime.config.aggregateProbes).toBe(1);
    expect(runtime.lastBatch).toBeNull();
    expect(runtime.counters.successes).toBe(1);
  });
});
