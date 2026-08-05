/**
 * IP SLA — responder, gigue, MOS et réactions.
 *
 * Trois choses que l'implémentation précédente ne pouvait pas faire du
 * tout (docs/PRD-IP-SLA.md §3.4, §3.8, §4) : ouvrir un port par le
 * control protocol UDP/1967, distinguer une perte aller d'une perte
 * retour, et évaluer un seuil avec hystérésis.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { evaluateEModel, mosFromRFactor } from '@/network/ipsla/emodel';
import { createReaction, evaluateReaction } from '@/network/ipsla/reactions';
import type { SlaOperationRuntime } from '@/network/ipsla/IpSlaEngine';

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

async function settle(ms: number): Promise<void> {
  const step = 10;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.advance(step);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

async function buildPair() {
  const source = new CiscoRouter('R1');
  const target = new CiscoRouter('R2');
  const cable = new Cable('c');
  cable.connect(source.getPort('GigabitEthernet0/0')!, target.getPort('GigabitEthernet0/0')!);

  for (const command of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'end',
  ]) await source.executeCommand(command);

  for (const command of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'end',
  ]) await target.executeCommand(command);

  return { source, target, cable };
}

describe('IP SLA Control Protocol — le responder ouvre vraiment un port', () => {
  it('une sonde udp-echo aboutit quand le responder est actif', async () => {
    const { source, target } = await buildPair();
    for (const command of [
      'configure terminal', 'ip sla responder', 'end',
    ]) await target.executeCommand(command);

    for (const command of [
      'configure terminal',
      'ip sla 1', 'udp-echo 10.0.0.2 5000', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(500);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('ok');
    expect(runtime.counters.successes).toBeGreaterThan(0);

    // Le port négocié existe côté responder, et il n'est pas permanent.
    const ports = target.getIpSlaEngine().getResponder().listPorts();
    expect(ports.some((entry) => entry.port === 5000 && !entry.permanent)).toBe(true);
    expect(await target.executeCommand('show ip sla responder'))
      .toContain('IP SLAs Responder is: Enabled');
  });

  it('sans responder, la sonde est refusée (Dropped) et non mise en Timeout', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'udp-echo 10.0.0.2 5000', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(6000);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('dropped');
    expect(runtime.lastDiagText).toContain('IP SLA Control Protocol');
  });

  it('control disable saute la négociation : sans écouteur, c\'est un Timeout', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'udp-echo 10.0.0.2 5000 control disable', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(6000);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('timeout');
  });

  it('une clé discordante fait refuser la négociation', async () => {
    const { source, target } = await buildPair();
    for (const command of [
      'configure terminal',
      'key chain SLA', 'key 1', 'key-string bonjour', 'exit', 'exit',
      'ip sla responder', 'ip sla key-chain SLA', 'end',
    ]) await target.executeCommand(command);

    for (const command of [
      'configure terminal',
      'key chain SLA', 'key 1', 'key-string aurevoir', 'exit', 'exit',
      'ip sla key-chain SLA',
      'ip sla 1', 'udp-echo 10.0.0.2 5000', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(6000);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('dropped');
    expect(runtime.lastDiagText).toContain('authentication failure');
  });

  it('la même clé des deux côtés laisse passer', async () => {
    const { source, target } = await buildPair();
    for (const command of [
      'configure terminal',
      'key chain SLA', 'key 1', 'key-string bonjour', 'exit', 'exit',
      'ip sla responder', 'ip sla key-chain SLA', 'end',
    ]) await target.executeCommand(command);

    for (const command of [
      'configure terminal',
      'key chain SLA', 'key 1', 'key-string bonjour', 'exit', 'exit',
      'ip sla key-chain SLA',
      'ip sla 1', 'udp-echo 10.0.0.2 5000', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(500);
    expect(source.getIpSlaEngine().getOperation(1)!.lastReturnCode).toBe('ok');
  });
});

describe('IP SLA udp-jitter — les pertes sont attribuées à une direction', () => {
  it('mesure un aller-retour complet et compte les paquets envoyés', async () => {
    const { source, target } = await buildPair();
    await target.executeCommand('enable');
    for (const command of [
      'configure terminal', 'ip sla responder', 'end',
    ]) await target.executeCommand(command);

    for (const command of [
      'configure terminal',
      'ip sla 1', 'udp-jitter 10.0.0.2 5000', 'num-packets 10', 'interval 20',
      'frequency 60', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(2000);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('ok');
    expect(runtime.jitter.packetsSent).toBe(10);
    expect(runtime.jitter.packetsReceived).toBe(10);
    expect(runtime.jitter.packetLossSD + runtime.jitter.packetLossDS
      + runtime.jitter.packetMIA).toBe(0);

    const statistics = await source.executeCommand('show ip sla statistics');
    expect(statistics).toContain('Packet Loss Values:');
    expect(statistics).toContain('One Way Values:');
  });

  it('sans NTP, aucun échantillon unidirectionnel n\'est comptabilisé', async () => {
    const { source, target } = await buildPair();
    for (const command of [
      'configure terminal', 'ip sla responder', 'end',
    ]) await target.executeCommand(command);
    for (const command of [
      'configure terminal',
      'ip sla 1', 'udp-jitter 10.0.0.2 5000', 'num-packets 5', 'interval 20', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(2000);
    const runtime = source.getIpSlaEngine().getOperation(1)!;
    expect(runtime.jitter.packetsReceived).toBe(5);
    expect(runtime.jitter.oneWaySD.numSamples).toBe(0);
    expect(runtime.jitter.oneWayDS.numSamples).toBe(0);
    expect(await source.executeCommand('show ip sla statistics'))
      .toContain('Number of SD Samples: 0');
  });
});

describe('E-model ITU-T G.107 — le MOS suit la perte et le codec', () => {
  it('un chemin parfait en G.711 donne le MOS haut de l\'échelle', () => {
    const result = evaluateEModel({
      codec: 'g711alaw', packetLossPercent: 0, oneWayDelayMs: 10, advantageFactor: 0,
    });
    expect(result.rFactor).toBeCloseTo(93.2, 5);
    expect(result.mos).toBeGreaterThan(4.3);
    expect(result.mos).toBeLessThanOrEqual(4.5);
    expect(result.icpif).toBe(0);
  });

  it('5 % de perte effondre le MOS', () => {
    const clean = evaluateEModel({
      codec: 'g711alaw', packetLossPercent: 0, oneWayDelayMs: 10, advantageFactor: 0,
    });
    const lossy = evaluateEModel({
      codec: 'g711alaw', packetLossPercent: 5, oneWayDelayMs: 10, advantageFactor: 0,
    });
    expect(lossy.mos).toBeLessThan(clean.mos - 0.5);
    expect(lossy.icpif).toBeGreaterThan(clean.icpif);
  });

  it('sans perte, G.729A est en dessous de G.711 (Ie 11 contre 0)', () => {
    const g711 = evaluateEModel({
      codec: 'g711ulaw', packetLossPercent: 0, oneWayDelayMs: 30, advantageFactor: 0,
    });
    const g729 = evaluateEModel({
      codec: 'g729a', packetLossPercent: 0, oneWayDelayMs: 30, advantageFactor: 0,
    });
    expect(g729.mos).toBeLessThan(g711.mos);
  });

  it('avec de la perte, G.729A REPASSE devant — c\'est ce que dit G.113', () => {
    // Bpl vaut 4.3 pour G.711 et 19 pour G.729A : le second encaisse
    // beaucoup mieux la perte. Le croisement est une propriété réelle du
    // modèle, pas une anomalie de ce calcul, et l'inverser serait le bug.
    const g711 = evaluateEModel({
      codec: 'g711ulaw', packetLossPercent: 2, oneWayDelayMs: 30, advantageFactor: 0,
    });
    const g729 = evaluateEModel({
      codec: 'g729a', packetLossPercent: 2, oneWayDelayMs: 30, advantageFactor: 0,
    });
    expect(g729.mos).toBeGreaterThan(g711.mos);
  });

  it('un délai unidirectionnel au-delà de G.114 dégrade le score', () => {
    const short = evaluateEModel({
      codec: 'g711alaw', packetLossPercent: 0, oneWayDelayMs: 50, advantageFactor: 0,
    });
    const long = evaluateEModel({
      codec: 'g711alaw', packetLossPercent: 0, oneWayDelayMs: 300, advantageFactor: 0,
    });
    expect(long.mos).toBeLessThan(short.mos);
    expect(long.delayImpairment).toBeGreaterThan(0);
    expect(short.delayImpairment).toBe(0);
  });

  it('la conversion R → MOS est bornée aux deux extrémités', () => {
    expect(mosFromRFactor(-10)).toBe(1);
    expect(mosFromRFactor(150)).toBe(4.5);
  });
});

function fakeRuntime(rtt: number, mos?: number): SlaOperationRuntime {
  return {
    lastRttMs: rtt,
    lastReturnCode: 'ok',
    emodel: mos === undefined ? null : {
      rFactor: 0, mos, icpif: 0, delayImpairment: 0, equipmentImpairment: 0,
    },
    jitter: {
      sourceToDestination: {
        numSamples: 0, min: null, max: null, sum: 0,
        numOfPositives: 0, sumOfPositives: 0, minPositive: null, maxPositive: null,
        numOfNegatives: 0, sumOfNegatives: 0, minNegative: null, maxNegative: null,
        interarrival: 0,
      },
      destinationToSource: {
        numSamples: 0, min: null, max: null, sum: 0,
        numOfPositives: 0, sumOfPositives: 0, minPositive: null, maxPositive: null,
        numOfNegatives: 0, sumOfNegatives: 0, minNegative: null, maxNegative: null,
        interarrival: 0,
      },
      oneWaySD: { numSamples: 0, min: null, max: null, sum: 0 },
      oneWayDS: { numSamples: 0, min: null, max: null, sum: 0 },
      packetsSent: 0, packetsReceived: 0,
      packetLossSD: 0, packetLossDS: 0, packetMIA: 0,
      packetOutOfSequence: 0, packetLateArrival: 0,
    },
  } as unknown as SlaOperationRuntime;
}

describe('Réactions — types de seuil, hystérésis, polarité', () => {
  it('immediate déclenche au premier franchissement', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'immediate';
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('triggered');
  });

  it('consecutive 3 ne déclenche qu\'à la troisième mesure d\'affilée', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'consecutive';
    reaction.consecutiveCount = 3;
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('triggered');
  });

  it('consecutive est remis à zéro par une mesure sous le seuil', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'consecutive';
    reaction.consecutiveCount = 3;
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    evaluateReaction(reaction, fakeRuntime(150));
    evaluateReaction(reaction, fakeRuntime(150));
    evaluateReaction(reaction, fakeRuntime(10));
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('none');
  });

  it('xOfy déclenche sur un motif non consécutif', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'xOfy';
    reaction.xOfyX = 2;
    reaction.xOfyY = 3;
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(10)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('triggered');
  });

  it('average compare la moyenne de la fenêtre, pas la dernière mesure', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'average';
    reaction.averageCount = 3;
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    evaluateReaction(reaction, fakeRuntime(200));
    evaluateReaction(reaction, fakeRuntime(200));
    // Moyenne (200+200+10)/3 = 136 > 100 alors que la dernière est à 10.
    expect(evaluateReaction(reaction, fakeRuntime(10)).verdict).toBe('triggered');
  });

  it('l\'hystérésis exige de repasser sous le seuil BAS pour lever', () => {
    const reaction = createReaction(1, 'rtt');
    reaction.thresholdType = 'immediate';
    reaction.thresholdUpper = 100;
    reaction.thresholdLower = 50;
    expect(evaluateReaction(reaction, fakeRuntime(150)).verdict).toBe('triggered');
    // Entre les deux seuils : la condition reste armée.
    expect(evaluateReaction(reaction, fakeRuntime(75)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(30)).verdict).toBe('cleared');
  });

  it('le MOS a la polarité inverse : c\'est un score BAS qui déclenche', () => {
    const reaction = createReaction(1, 'mos');
    reaction.thresholdType = 'immediate';
    reaction.thresholdUpper = 4;
    reaction.thresholdLower = 3;
    expect(evaluateReaction(reaction, fakeRuntime(1, 4.4)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(1, 2.5)).verdict).toBe('triggered');
    expect(evaluateReaction(reaction, fakeRuntime(1, 3.5)).verdict).toBe('none');
    expect(evaluateReaction(reaction, fakeRuntime(1, 4.4)).verdict).toBe('cleared');
  });
});

describe('Réactions — la CLI et le syslog', () => {
  it('un dépassement écrit %RTT-3-IPSLATHRESHOLD dans le journal', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal',
      'ip sla logging traps',
      'ip sla 1', 'icmp-echo 10.9.9.9', 'frequency 5', 'exit',
      'ip sla reaction-configuration 1 react connectionLoss threshold-type immediate '
      + 'action-type trapOnly',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await source.executeCommand(command);

    await settle(6000);
    const logging = await source.executeCommand('show logging');
    expect(logging).toContain('IPSLATHRESHOLD');
    expect(logging).toContain('IP SLAs(1)');
  });

  it('reaction-trigger exige une opération cible en start-time pending', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'icmp-echo 10.0.0.2', 'exit',
      'ip sla 2', 'icmp-echo 10.0.0.2', 'exit',
      'ip sla schedule 2 life forever start-time now',
    ]) await source.executeCommand(command);

    expect(await source.executeCommand('ip sla reaction-trigger 1 2'))
      .toContain('must be scheduled with start-time pending');

    await source.executeCommand('ip sla schedule 2 life forever start-time pending');
    expect(await source.executeCommand('ip sla reaction-trigger 1 2')).toBe('');
    await source.executeCommand('end');
    expect(await source.executeCommand('show ip sla reaction-trigger')).toContain('Pending');
  });
});

describe('IP SLA et track dans la running-config', () => {
  it('la configuration est relue telle qu\'elle a été tapée', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal',
      'ip sla 1',
      'icmp-echo 10.0.0.2 source-interface GigabitEthernet0/0',
      'frequency 10', 'timeout 2000', 'threshold 1500', 'tag WAN-PRIMAIRE', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'ip sla reaction-configuration 1 react rtt threshold-type consecutive 3 '
      + 'threshold-value 2000 1000 action-type trapOnly',
      'track 1 ip sla 1 reachability',
      'delay down 20 up 5',
      'exit',
      'end',
    ]) await source.executeCommand(command);

    const running = await source.executeCommand('show running-config');
    expect(running).toContain('ip sla 1');
    expect(running).toContain(' icmp-echo 10.0.0.2 source-interface GigabitEthernet0/0');
    expect(running).toContain(' frequency 10');
    expect(running).toContain(' timeout 2000');
    expect(running).toContain(' threshold 1500');
    expect(running).toContain(' tag WAN-PRIMAIRE');
    expect(running).toContain('ip sla schedule 1 life forever start-time now');
    expect(running).toContain('ip sla reaction-configuration 1 react rtt '
      + 'threshold-type consecutive 3 threshold-value 2000 1000 action-type trapOnly');
    expect(running).toContain('track 1 ip sla 1 reachability');
    expect(running).toContain(' delay up 5 down 20');
  });

  it('la valeur par défaut d\'un type n\'est pas rendue', async () => {
    const { source } = await buildPair();
    for (const command of [
      'configure terminal', 'ip sla 1', 'icmp-echo 10.0.0.2', 'exit', 'end',
    ]) await source.executeCommand(command);

    const running = await source.executeCommand('show running-config');
    expect(running).toContain(' icmp-echo 10.0.0.2');
    expect(running).not.toContain(' frequency 60');
    expect(running).not.toContain(' timeout 5000');
  });
});
