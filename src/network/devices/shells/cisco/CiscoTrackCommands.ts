import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import {
  describeTrack, trackStateNoun,
  type TrackObject, type TrackService, type TrackType,
} from '../../../ipsla/TrackService';
import { RETURN_CODE_LABEL } from '../../../ipsla/types';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import {
  specsFromTrieRegistrations, type AdapterKeyword,
} from '@/cli/commands/trieAdapter';

export interface TrackCommandContext {
  r(): Router;
  setMode(mode: 'config-track' | 'config'): void;
  getSelectedTrack(): number | null;
  setSelectedTrack(id: number | null): void;
}

function serviceOf(ctx: TrackCommandContext): TrackService {
  return ctx.r().getTrackService();
}

function selectedObject(ctx: TrackCommandContext): TrackObject | undefined {
  const id = ctx.getSelectedTrack();
  return id === null ? undefined : serviceOf(ctx).get(id);
}

export function formatUptime(millis: number): string {
  const total = Math.max(0, Math.floor(millis / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function defineTrack(service: TrackService, args: string[]): string {
  const id = parseInt(args[0], 10);
  if (Number.isNaN(id)) return '% Invalid track number';
  const rest = args.slice(1);

  if (rest[0] === 'interface') {
    const iface = rest[1];
    if (!iface) return '% Incomplete command.';
    const routing = rest.includes('ip') && rest.includes('routing');
    const type: TrackType = routing ? 'interface-routing' : 'interface-line';
    const object = service.ensure(id, type);
    object.iface = iface;
    return '';
  }

  if (rest[0] === 'ip' && rest[1] === 'route') {
    const prefix = rest[2];
    const mask = rest[3];
    if (!prefix || !mask) return '% Incomplete command.';
    const metric = rest.includes('metric');
    const object = service.ensure(id, metric ? 'route-metric' : 'route-reachability');
    object.prefix = prefix;
    object.mask = mask;
    return '';
  }

  if (rest[0] === 'ip' && rest[1] === 'sla') {
    const slaId = parseInt(rest[2], 10);
    if (Number.isNaN(slaId)) return '% Incomplete command.';
    const object = service.ensure(id, rest[3] === 'state' ? 'ipsla-state' : 'ipsla-reachability');
    object.slaId = slaId;
    return '';
  }

  if (rest[0] === 'list') {
    if (rest[1] === 'boolean') {
      const object = service.ensure(id, 'list-boolean');
      object.boolOp = rest[2] === 'or' ? 'or' : 'and';
      return '';
    }
    if (rest[1] === 'threshold') {
      service.ensure(id, 'list-threshold');
      return '';
    }
    return '% Incomplete command.';
  }

  if (rest.length === 0 || rest[0] === 'stub-object') {
    service.ensure(id, 'stub');
    return '';
  }
  return '% Invalid input detected at \'^\' marker.';
}

function renderDetail(ctx: TrackCommandContext, object: TrackObject): string {
  const service = serviceOf(ctx);
  const engine = ctx.r().getIpSlaEngine();
  service.evaluateAll();
  const lines: string[] = [];
  lines.push(`Track ${object.id}`);
  lines.push(`  ${describeTrack(object)}`);
  const noun = trackStateNoun(object);
  lines.push(`  ${noun} is ${object.state === 'up' ? 'Up' : 'Down'}`);
  const sinceChange = object.lastChangeMs === null
    ? 'never'
    : formatUptime(engine.nowMs() - object.lastChangeMs);
  lines.push(`    ${object.changeCount} change${object.changeCount === 1 ? '' : 's'}, last change ${sinceChange}`);

  if (object.slaId !== null) {
    const runtime = engine.getOperation(object.slaId);
    const code = runtime?.lastReturnCode;
    lines.push(`  Latest operation return code: ${code ? RETURN_CODE_LABEL[code] : 'Unknown'}`);
    if (runtime && runtime.lastRttMs !== null) {
      lines.push(`  Latest RTT (millisecs) ${Math.round(runtime.lastRttMs)}`);
    }
  }
  if (object.delayUpSeconds > 0 || object.delayDownSeconds > 0) {
    lines.push(`  Delay up ${object.delayUpSeconds} secs, down ${object.delayDownSeconds} secs`);
  }
  if (object.type === 'list-threshold') {
    lines.push(`  Threshold weight is ${service.memberWeight(object)}`);
  }
  for (const member of object.members) {
    const child = service.get(member.id);
    const state = child ? (child.state === 'up' ? 'Up' : 'Down') : 'Down';
    const weight = member.weight !== undefined ? ` weight ${member.weight}` : '';
    const negate = member.negate ? ' not' : '';
    lines.push(`    ${member.id}${weight}${negate} ${state}`);
  }
  lines.push('  Tracked by:');
  if (object.trackedBy.size === 0) lines.push('    Nobody');
  else for (const consumer of [...object.trackedBy].sort()) lines.push(`    ${consumer}`);
  return lines.join('\n');
}

function briefParameter(object: TrackObject): string {
  switch (object.type) {
    case 'interface-line': return 'line-protocol';
    case 'interface-routing': return 'ip routing';
    case 'route-reachability':
    case 'ipsla-reachability': return 'reachability';
    case 'route-metric': return 'metric';
    case 'ipsla-state': return 'state';
    case 'list-boolean': return 'boolean';
    case 'list-threshold': return 'threshold';
    default: return 'stub';
  }
}

function briefObject(object: TrackObject): string {
  switch (object.type) {
    case 'interface-line':
    case 'interface-routing':
      return `interface ${object.iface}`;
    case 'route-reachability':
    case 'route-metric':
      return `ip route ${object.prefix}`;
    case 'ipsla-reachability':
    case 'ipsla-state':
      return `ip sla ${object.slaId}`;
    default:
      return object.type;
  }
}

export function buildTrackConfigCommands(
  configTrie: CommandTrie,
  trackTrie: CommandTrie,
  ctx: TrackCommandContext,
): void {
  const enterTrack = (args: string[]): string => {
    if (args.length < 1) return '% Incomplete command.';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Invalid track number';
    const error = defineTrack(serviceOf(ctx), args);
    if (error) return error;
    ctx.setSelectedTrack(id);
    ctx.setMode('config-track');
    return '';
  };

  configTrie.registerGreedy('track', 'Tracking configuration commands', enterTrack);

  configTrie.registerGreedy('no track', 'Remove a tracked object', (args) => {
    const id = parseInt(args[0], 10);
    if (!Number.isNaN(id)) serviceOf(ctx).remove(id);
    return '';
  });

  buildTrackSubmodeOn(trackTrie, ctx);
}

export function buildTrackSubmodeOn(
  trackTrie: CommandTrie, ctx: TrackCommandContext,
): void {
  const enterTrack = (args: string[]): string => {
    if (args.length < 1) return '% Incomplete command.';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Invalid track number';
    const error = defineTrack(serviceOf(ctx), args);
    if (error) return error;
    ctx.setSelectedTrack(id);
    ctx.setMode('config-track');
    return '';
  };
  trackTrie.registerGreedy('track', 'Tracking configuration commands', enterTrack);

  trackTrie.registerGreedy('object', 'Add an object to the list', (args) => {
    const object = selectedObject(ctx);
    if (!object) return '';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Incomplete command.';
    const weightIndex = args.indexOf('weight');
    object.members = object.members.filter((member) => member.id !== id);
    object.members.push({
      id,
      weight: weightIndex >= 0 ? parseInt(args[weightIndex + 1], 10) : undefined,
      negate: args.includes('not'),
    });
    return '';
  });

  trackTrie.registerGreedy('no object', 'Remove an object from the list', (args) => {
    const object = selectedObject(ctx);
    if (!object) return '';
    const id = parseInt(args[0], 10);
    object.members = object.members.filter((member) => member.id !== id);
    return '';
  });

  trackTrie.registerGreedy('threshold', 'Set threshold values', (args) => {
    const object = selectedObject(ctx);
    if (!object) return '';
    const upIndex = args.indexOf('up');
    const downIndex = args.indexOf('down');
    if (upIndex >= 0) object.thresholdUp = parseInt(args[upIndex + 1], 10);
    if (downIndex >= 0) object.thresholdDown = parseInt(args[downIndex + 1], 10);
    return '';
  });

  trackTrie.registerGreedy('delay', 'Delay a state change notification', (args) => {
    const object = selectedObject(ctx);
    if (!object) return '';
    const upIndex = args.indexOf('up');
    const downIndex = args.indexOf('down');
    if (upIndex < 0 && downIndex < 0) return '% Incomplete command.';
    if (upIndex >= 0) {
      const value = parseInt(args[upIndex + 1], 10);
      if (Number.isNaN(value)) return '% Incomplete command.';
      object.delayUpSeconds = value;
    }
    if (downIndex >= 0) {
      const value = parseInt(args[downIndex + 1], 10);
      if (Number.isNaN(value)) return '% Incomplete command.';
      object.delayDownSeconds = value;
    }
    return '';
  });

  trackTrie.registerGreedy('no delay', 'Remove the state change delay', () => {
    const object = selectedObject(ctx);
    if (object) { object.delayUpSeconds = 0; object.delayDownSeconds = 0; }
    return '';
  });
}

export function registerTrackShowCommands(trie: CommandTrie, ctx: TrackCommandContext): void {
  trie.registerGreedy('show track', 'Tracking information', (args) => {
    const service = serviceOf(ctx);
    service.evaluateAll();
    const objects = service.all();
    if (objects.length === 0) return '% No tracked objects configured.';

    if (/^\d+$/.test(args[0] ?? '')) {
      const object = service.get(parseInt(args[0], 10));
      return object ? renderDetail(ctx, object) : '% Track object does not exist';
    }
    if (args[0] === 'brief') {
      const now = ctx.r().getIpSlaEngine().nowMs();
      const lines = ['Track   Object                         Parameter        Value      Last Change'];
      for (const object of objects) {
        const lastChange = object.lastChangeMs === null
          ? 'never'
          : formatUptime(now - object.lastChangeMs);
        lines.push(
          `${String(object.id).padEnd(8)}${briefObject(object).padEnd(31)}`
          + `${briefParameter(object).padEnd(17)}`
          + `${(object.state === 'up' ? 'Up' : 'Down').padEnd(11)}${lastChange}`,
        );
      }
      return lines.join('\n');
    }
    return objects.map((object) => renderDetail(ctx, object)).join('\n');
  });
}

const OBJET_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'not', description: 'Negate the state of this object',
    afterArguments: true, argument: null,
  },
  {
    keyword: 'weight', description: 'Weight of this object in the list',
    afterArguments: true,
    argument: { name: 'poids', type: 'INT', description: 'Weight value', range: [1, 255] },
  },
];

/*
 * `threshold up 2 down 1` et `delay up 10 down 20` posent les DEUX
 * bornes sur une seule ligne, dans l'ordre qu'on veut : chaque mot-cle
 * prend donc sa valeur PUIS de quoi accueillir l'autre paire, sans quoi
 * la seconde moitie de la ligne n'a pas de destination.
 */
const AUTRE_BORNE: ArgumentSpec = {
  name: 'autre', type: 'REST', optional: true,
  description: 'The other bound, `up <value>` or `down <value>`',
};

const SEUIL_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'up', description: 'Value at or above which the list is up',
    argument: [
      { name: 'valeur', type: 'INT', description: 'Threshold value' }, AUTRE_BORNE,
    ],
  },
  {
    keyword: 'down', description: 'Value at or below which the list is down',
    argument: [
      { name: 'valeur', type: 'INT', description: 'Threshold value' }, AUTRE_BORNE,
    ],
  },
];

const DELAI_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'up', description: 'Delay before reporting the object up',
    argument: [
      { name: 'secondes', type: 'INT', description: 'Delay in seconds', range: [0, 180] },
      AUTRE_BORNE,
    ],
  },
  {
    keyword: 'down', description: 'Delay before reporting the object down',
    argument: [
      { name: 'secondes', type: 'INT', description: 'Delay in seconds', range: [0, 180] },
      AUTRE_BORNE,
    ],
  },
];

const TRACK_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  track: { name: 'numero', type: 'INT', description: 'Tracked object number', range: [1, 1000] },
  object: { name: 'numero', type: 'INT', description: 'Object number to add', range: [1, 1000] },
  threshold: null,
  delay: null,
};

export function trackSubmodeSpecs(ctx: TrackCommandContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildTrackSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-track'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => TRACK_ARGUMENTS[path],
      keywordsFor: (path) => path === 'object' ? OBJET_KEYWORDS
        : path === 'threshold' ? SEUIL_KEYWORDS
          : path === 'delay' ? DELAI_KEYWORDS : undefined,
    },
  );
}
