import type { Router } from '../../Router';
import {
  describeTrack, trackStateNoun,
  type TrackObject, type TrackService,
} from '../../../ipsla/TrackService';
import {
  parseTrackDefinition, TRACK_ID_RANGE, TRACK_INVALID_ID, type TrackDefinition,
} from './trackSyntax';
import { RETURN_CODE_LABEL } from '../../../ipsla/types';
import { CliInvalidInput, INCOMPLETE_MESSAGE } from '../cli/CliDiagnostic';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { OptionSpec } from '@/cli/OptionBag';
import { showTrackSpec } from './showViewSpecs';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

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

function applyTrackDefinition(service: TrackService, def: TrackDefinition): void {
  const object = service.ensure(def.id, def.type);
  if (def.iface !== undefined) object.iface = def.iface;
  if (def.prefix !== undefined) object.prefix = def.prefix;
  if (def.mask !== undefined) object.mask = def.mask;
  if (def.slaId !== undefined) object.slaId = def.slaId;
  if (def.boolOp !== undefined) object.boolOp = def.boolOp;
}

function defineTrack(service: TrackService, args: string[]): string {
  const lu = parseTrackDefinition(args);
  if (lu.idInvalide) return TRACK_INVALID_ID;
  if (lu.incomplet) return '% Incomplete command.';
  if (lu.refus !== undefined || !lu.definition) {
    return '% Invalid input detected at \'^\' marker.';
  }
  applyTrackDefinition(service, lu.definition);
  return '';
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

export function trackShowSpecs(ctx: TrackCommandContext): CommandSpec[] {
  return [showTrackSpec((cible) => {
    const service = serviceOf(ctx);
    service.evaluateAll();
    const objects = service.all();
    if (objects.length === 0) return '% No tracked objects configured.';

    if (cible !== undefined && cible !== 'brief') {
      const object = service.get(Number(cible));
      return object ? renderDetail(ctx, object) : '% Track object does not exist';
    }
    if (cible === 'brief') {
      const now = ctx.r().getIpSlaEngine().nowMs();
      const lines = ['Track   Object                         Parameter        Value      Last Change'];
      for (const object of objects) {
        const lastChange = object.lastChangeMs === null
          ? 'never'
          : formatUptime(now - object.lastChangeMs);
        lines.push(
          `${padToWidth(String(object.id), 8)}${padToWidth(briefObject(object), 31)}`
          + `${padToWidth(briefParameter(object), 17)}`
          + `${padToWidth(object.state === 'up' ? 'Up' : 'Down', 11)}${lastChange}`,
        );
      }
      return lines.join('\n');
    }
    return objects.map((object) => renderDetail(ctx, object)).join('\n');
  })];
}

/**
 * Ce qu'une plateforme fait d'un objet suivi qu'on vient de declarer.
 *
 * Le routeur ecrit dans `TrackService` et entre en `config-track` ; le
 * commutateur, qui n'a ni table de routage complete ni moteur IP SLA,
 * ecrit dans son propre registre et ne retient que les deux formes
 * d'interface. Ce sont deux CORPS pour une commande, et c'est justifie ;
 * ce qui ne l'etait pas est qu'ils aient eu deux DECLARATIONS, chacune
 * libre de border son numero autrement et d'ouvrir un sous-mode ou non.
 */
export interface TrackEntryHost {
  define(definition: TrackDefinition): string;
  remove(id: number): void;
}

const TRACK_ID_PLACE: ArgumentSpec = {
  name: 'numero', type: 'INT', range: TRACK_ID_RANGE,
  description: 'Tracked object number',
};

export function trackEntrySpecs(
  ctx: () => TrackEntryHost, modes: readonly string[],
): CommandSpec[] {
  return [
    {
      id: 'track-entry',
      path: ['track', TRACK_ID_PLACE,
        { name: 'suite', type: 'REST', literal: 'LINE', optional: true,
          description: 'What this object tracks' }],
      description: 'Tracking configuration commands',
      undoDescription: 'Remove a tracked object',
      modes, minPrivilege: 15,
      run: (_session, args) => {
        const mots = [args.numero, ...(args.suite ?? '').split(/\s+/)]
          .filter((mot) => mot.length > 0);
        const lu = parseTrackDefinition(mots);
        if (lu.idInvalide) return TRACK_INVALID_ID;
        if (lu.incomplet) return INCOMPLETE_MESSAGE;
        if (lu.refus !== undefined || !lu.definition) {
          throw new CliInvalidInput({ token: lu.refus });
        }
        return ctx().define(lu.definition);
      },
      undo: (_session, args) => {
        ctx().remove(Number(args.numero));
        return '';
      },
    },
  ];
}

export function routerTrackEntryHost(ctx: TrackCommandContext): TrackEntryHost {
  return {
    define: (definition) => {
      applyTrackDefinition(serviceOf(ctx), definition);
      ctx.setSelectedTrack(definition.id);
      ctx.setMode('config-track');
      return '';
    },
    remove: (id) => { serviceOf(ctx).remove(id); },
  };
}

const OBJECT_NUMBER: ArgumentSpec = {
  name: 'number', type: 'INT', range: [1, 1000], description: 'Object number',
};

const thresholdOptions: readonly OptionSpec[] = [
  { keyword: 'up', description: 'Value at or above which the list is up',
    argument: { name: 'up', type: 'INT', description: 'Threshold value' } },
  { keyword: 'down', description: 'Value at or below which the list is down',
    argument: { name: 'down', type: 'INT', description: 'Threshold value' } },
];

const delayOptions: readonly OptionSpec[] = [
  { keyword: 'up', description: 'Delay before reporting the object up',
    argument: { name: 'up', type: 'INT', range: [0, 180], description: 'Delay in seconds' } },
  { keyword: 'down', description: 'Delay before reporting the object down',
    argument: { name: 'down', type: 'INT', range: [0, 180], description: 'Delay in seconds' } },
];

export function trackSubmodeSpecs(ctx: TrackCommandContext): CommandSpec[] {
  const base = { modes: ['config-track'], minPrivilege: 15 };
  const object = () => selectedObject(ctx);
  return [
    {
      ...base, id: 'track-object', path: ['object', OBJECT_NUMBER],
      description: 'Add an object to the list', undoDescription: 'Remove an object from the list',
      options: [
        { keyword: 'not', description: 'Negate the state of this object' },
        { keyword: 'weight', description: 'Weight of this object in the list',
          argument: { name: 'weight', type: 'INT', range: [1, 255], description: 'Weight value' } },
      ],
      run: (_session, args) => {
        const tracked = object();
        if (!tracked) return '';
        const id = Number(args.number);
        tracked.members = tracked.members.filter((member) => member.id !== id);
        tracked.members.push({
          id,
          weight: args.weight === undefined ? undefined : Number(args.weight),
          negate: args.not !== undefined,
        });
        return '';
      },
      undo: (_session, args) => {
        const tracked = object();
        if (tracked) {
          tracked.members = tracked.members.filter((member) => member.id !== Number(args.number));
        }
        return '';
      },
    },
    {
      ...base, id: 'track-threshold', path: ['threshold'],
      description: 'Set threshold values', options: thresholdOptions, requiresOneOption: true,
      run: (_session, args) => {
        const tracked = object();
        if (!tracked) return '';
        if (args.up !== undefined) tracked.thresholdUp = Number(args.up);
        if (args.down !== undefined) tracked.thresholdDown = Number(args.down);
        return '';
      },
    },
    {
      ...base, id: 'track-delay', path: ['delay'],
      description: 'Delay a state change notification', undoDescription: 'Remove the state change delay',
      options: delayOptions, requiresOneOption: true,
      run: (_session, args) => {
        const tracked = object();
        if (!tracked) return '';
        if (args.up !== undefined) tracked.delayUpSeconds = Number(args.up);
        if (args.down !== undefined) tracked.delayDownSeconds = Number(args.down);
        return '';
      },
      undo: () => {
        const tracked = object();
        if (tracked) { tracked.delayUpSeconds = 0; tracked.delayDownSeconds = 0; }
        return '';
      },
    },
  ];
}
