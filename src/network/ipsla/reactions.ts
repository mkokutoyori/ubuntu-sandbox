import type { SlaOperationRuntime } from './IpSlaEngine';
import { averageJitter, averageOneWay, packetLossPercent } from './statistics';

export type ReactionElement =
  | 'rtt'
  | 'timeout'
  | 'connectionLoss'
  | 'verifyError'
  | 'jitterAvg'
  | 'jitterSDAvg'
  | 'jitterDSAvg'
  | 'packetLoss'
  | 'packetLossSD'
  | 'packetLossDS'
  | 'packetLateArrival'
  | 'packetOutOfSequence'
  | 'maxOfPositiveSD'
  | 'maxOfNegativeSD'
  | 'maxOfPositiveDS'
  | 'maxOfNegativeDS'
  | 'mos'
  | 'icpif'
  | 'latencyDSAvg'
  | 'latencySDAvg';

export type ReactionThresholdType = 'never' | 'immediate' | 'consecutive' | 'xOfy' | 'average';

export type ReactionActionType = 'none' | 'trapOnly' | 'triggerOnly' | 'trapAndTrigger';

/**
 * Un élément surveillé est soit un ÉVÉNEMENT (il s'est produit ou non),
 * soit une MESURE comparée à un seuil — et pour les mesures, le sens de la
 * comparaison n'est pas le même partout : un RTT élevé est mauvais, un MOS
 * bas l'est. Traiter les deux avec la même comparaison serait un bug
 * silencieux, d'où cette table plutôt qu'un `>` en dur.
 */
export const REACTION_ELEMENTS: Record<ReactionElement, {
  kind: 'event' | 'measure';
  polarity: 'rising' | 'falling';
}> = {
  rtt: { kind: 'measure', polarity: 'rising' },
  timeout: { kind: 'event', polarity: 'rising' },
  connectionLoss: { kind: 'event', polarity: 'rising' },
  verifyError: { kind: 'event', polarity: 'rising' },
  jitterAvg: { kind: 'measure', polarity: 'rising' },
  jitterSDAvg: { kind: 'measure', polarity: 'rising' },
  jitterDSAvg: { kind: 'measure', polarity: 'rising' },
  packetLoss: { kind: 'measure', polarity: 'rising' },
  packetLossSD: { kind: 'measure', polarity: 'rising' },
  packetLossDS: { kind: 'measure', polarity: 'rising' },
  packetLateArrival: { kind: 'measure', polarity: 'rising' },
  packetOutOfSequence: { kind: 'measure', polarity: 'rising' },
  maxOfPositiveSD: { kind: 'measure', polarity: 'rising' },
  maxOfNegativeSD: { kind: 'measure', polarity: 'rising' },
  maxOfPositiveDS: { kind: 'measure', polarity: 'rising' },
  maxOfNegativeDS: { kind: 'measure', polarity: 'rising' },
  mos: { kind: 'measure', polarity: 'falling' },
  icpif: { kind: 'measure', polarity: 'rising' },
  latencySDAvg: { kind: 'measure', polarity: 'rising' },
  latencyDSAvg: { kind: 'measure', polarity: 'rising' },
};

export function isReactionElement(name: string): name is ReactionElement {
  return Object.prototype.hasOwnProperty.call(REACTION_ELEMENTS, name);
}

export interface SlaReaction {
  operationId: number;
  element: ReactionElement;
  thresholdType: ReactionThresholdType;
  consecutiveCount: number;
  xOfyX: number;
  xOfyY: number;
  averageCount: number;
  thresholdUpper: number;
  thresholdLower: number;
  actionType: ReactionActionType;
  armed: boolean;
  samples: boolean[];
  values: number[];
}

export function createReaction(operationId: number, element: ReactionElement): SlaReaction {
  return {
    operationId,
    element,
    thresholdType: 'never',
    consecutiveCount: 5,
    xOfyX: 5,
    xOfyY: 5,
    averageCount: 5,
    thresholdUpper: 5000,
    thresholdLower: 3000,
    actionType: 'none',
    armed: false,
    samples: [],
    values: [],
  };
}

export function measureElement(
  element: ReactionElement,
  runtime: SlaOperationRuntime,
): number | null {
  const jitter = runtime.jitter;
  switch (element) {
    case 'rtt':
      return runtime.lastRttMs;
    case 'timeout':
      return runtime.lastReturnCode === 'timeout' ? 1 : 0;
    case 'connectionLoss':
      return runtime.lastReturnCode === 'notConnected' ? 1 : 0;
    case 'verifyError':
      return runtime.lastReturnCode === 'verifyError' ? 1 : 0;
    case 'jitterAvg':
      return (averageJitter(jitter.sourceToDestination)
        + averageJitter(jitter.destinationToSource)) / 2;
    case 'jitterSDAvg':
      return averageJitter(jitter.sourceToDestination);
    case 'jitterDSAvg':
      return averageJitter(jitter.destinationToSource);
    case 'packetLoss':
      return packetLossPercent(jitter);
    case 'packetLossSD':
      return jitter.packetLossSD;
    case 'packetLossDS':
      return jitter.packetLossDS;
    case 'packetLateArrival':
      return jitter.packetLateArrival;
    case 'packetOutOfSequence':
      return jitter.packetOutOfSequence;
    case 'maxOfPositiveSD':
      return jitter.sourceToDestination.maxPositive ?? 0;
    case 'maxOfNegativeSD':
      return jitter.sourceToDestination.maxNegative ?? 0;
    case 'maxOfPositiveDS':
      return jitter.destinationToSource.maxPositive ?? 0;
    case 'maxOfNegativeDS':
      return jitter.destinationToSource.maxNegative ?? 0;
    case 'mos':
      return runtime.emodel ? runtime.emodel.mos : null;
    case 'icpif':
      return runtime.emodel ? runtime.emodel.icpif : null;
    case 'latencySDAvg':
      return averageOneWay(jitter.oneWaySD);
    case 'latencyDSAvg':
      return averageOneWay(jitter.oneWayDS);
    default:
      return null;
  }
}

function breaches(reaction: SlaReaction, value: number): boolean {
  return REACTION_ELEMENTS[reaction.element].polarity === 'rising'
    ? value > reaction.thresholdUpper
    : value < reaction.thresholdLower;
}

function clears(reaction: SlaReaction, value: number): boolean {
  return REACTION_ELEMENTS[reaction.element].polarity === 'rising'
    ? value < reaction.thresholdLower
    : value > reaction.thresholdUpper;
}

export type ReactionVerdict = 'none' | 'triggered' | 'cleared';

/**
 * L'hystérésis est la raison d'être des DEUX seuils : une réaction armée
 * ne se lève qu'en repassant sous le seuil bas (au-dessus du seuil haut
 * pour un élément à polarité descendante comme le MOS). Sans cela une
 * valeur qui oscille autour d'un seuil unique produit un battement.
 */
export function evaluateReaction(
  reaction: SlaReaction,
  runtime: SlaOperationRuntime,
): { verdict: ReactionVerdict; value: number } {
  const measured = measureElement(reaction.element, runtime);
  if (measured === null) return { verdict: 'none', value: 0 };
  if (reaction.thresholdType === 'never') return { verdict: 'none', value: measured };

  const spec = REACTION_ELEMENTS[reaction.element];
  const over = spec.kind === 'event' ? measured > 0 : breaches(reaction, measured);

  reaction.samples.push(over);
  reaction.values.push(measured);
  const window = Math.max(reaction.xOfyY, reaction.consecutiveCount, reaction.averageCount, 1);
  while (reaction.samples.length > window) reaction.samples.shift();
  while (reaction.values.length > window) reaction.values.shift();

  let condition = false;
  switch (reaction.thresholdType) {
    case 'immediate':
      condition = over;
      break;
    case 'consecutive': {
      const needed = Math.max(1, reaction.consecutiveCount);
      const tail = reaction.samples.slice(-needed);
      condition = tail.length === needed && tail.every(Boolean);
      break;
    }
    case 'xOfy': {
      const window = Math.max(1, reaction.xOfyY);
      const tail = reaction.samples.slice(-window);
      condition = tail.filter(Boolean).length >= Math.max(1, reaction.xOfyX);
      break;
    }
    case 'average': {
      const needed = Math.max(1, reaction.averageCount);
      const tail = reaction.values.slice(-needed);
      if (tail.length < needed) break;
      const mean = tail.reduce((total, value) => total + value, 0) / tail.length;
      condition = spec.kind === 'event' ? mean > 0 : breaches(reaction, mean);
      break;
    }
    default:
      break;
  }

  if (!reaction.armed && condition) {
    reaction.armed = true;
    return { verdict: 'triggered', value: measured };
  }
  if (reaction.armed) {
    const released = spec.kind === 'event' ? !over : clears(reaction, measured);
    if (released) {
      reaction.armed = false;
      reaction.samples = [];
      reaction.values = [];
      return { verdict: 'cleared', value: measured };
    }
  }
  return { verdict: 'none', value: measured };
}
