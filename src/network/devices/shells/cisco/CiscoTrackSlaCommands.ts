/**
 * CiscoTrackSlaCommands — object tracking (`track …`) and IP SLA
 * (`ip sla …`) config + their show families, projecting the REAL
 * TrackRepository / IpSlaRepository state. Router-only.
 */
import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { TrackRepository, TrackType }
  from '../../inspection/config/TrackRepository';
import type { IpSlaRepository } from '../../inspection/config/IpSlaRepository';

interface Ctx {
  r(): Router;
  setMode(m: 'config-track' | 'config-ipsla' | 'config'): void;
  getSelectedTrack(): number | null;
  setSelectedTrack(id: number | null): void;
  getSelectedIpSla(): number | null;
  setSelectedIpSla(id: number | null): void;
}

/** Parse `track <id> <type…>` and create the real object. */
function defineTrack(repo: TrackRepository, args: string[]): boolean {
  const id = parseInt(args[0], 10);
  if (Number.isNaN(id)) return false;
  const a = args.slice(1);
  if (a[0] === 'interface') {
    const isRouting = a.includes('ip') && a.includes('routing');
    const o = repo.ensure(id, isRouting ? 'interface-routing' : 'interface-line');
    o.iface = a[1];
    return true;
  }
  if (a[0] === 'ip' && a[1] === 'route') {
    const o = repo.ensure(id, 'route');
    o.prefix = a[2];
    return true;
  }
  if (a[0] === 'ip' && a[1] === 'sla') {
    const o = repo.ensure(id, a[3] === 'state' ? 'ipsla-state' : 'ipsla-reach');
    o.slaId = parseInt(a[2], 10);
    return true;
  }
  if (a[0] === 'list') {
    if (a[1] === 'boolean') {
      const o = repo.ensure(id, 'list-boolean');
      o.boolOp = a[2] === 'or' ? 'or' : 'and';
    } else {
      repo.ensure(id, 'list-threshold');
    }
    return true;
  }
  if (a[0] === 'stub-object' || a.length === 0) {
    repo.ensure(id, 'stub');
    return true;
  }
  repo.ensure(id, 'stub');
  return true;
}

function trackDetail(
  router: Router, sla: IpSlaRepository, repo: TrackRepository,
  o: ReturnType<TrackRepository['get']>,
): string {
  if (!o) return '';
  const st = repo.state(router, sla, o.id);
  const desc: Record<TrackType, string> = {
    'interface-line': `Interface ${o.iface} line-protocol`,
    'interface-routing': `Interface ${o.iface} ip routing`,
    'route': `IP route ${o.prefix} reachability`,
    'ipsla-reach': `IP SLA ${o.slaId} reachability`,
    'ipsla-state': `IP SLA ${o.slaId} state`,
    'list-boolean': `List boolean ${o.boolOp ?? 'and'}`,
    'list-threshold': 'List threshold weight',
    'stub': 'Stub object',
  };
  const lines = [
    `Track ${o.id}`,
    `  ${desc[o.type]}`,
    `  ${st === 'Up' ? 'State is Up' : 'State is Down'}`,
  ];
  for (const m of o.members) {
    lines.push(`    ${m.id}${m.weight !== undefined ? ` weight ${m.weight}` : ''}` +
      ` ${repo.state(router, sla, m.id) }`);
  }
  return lines.join('\n');
}

export function buildTrackSlaConfig(
  configTrie: CommandTrie, trackTrie: CommandTrie, slaTrie: CommandTrie,
  ctx: Ctx, track: TrackRepository, sla: IpSlaRepository,
): void {
  // ── global config ──
  configTrie.registerGreedy('track', 'Configure a tracked object', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Invalid track number';
    defineTrack(track, args);
    ctx.setSelectedTrack(id);
    ctx.setMode('config-track');   // list/threshold sub-config lives here
    return '';
  });
  configTrie.registerGreedy('no track', 'Remove a tracked object', (args) => {
    const id = parseInt(args[0], 10);
    if (!Number.isNaN(id)) track.remove(id);
    return '';
  });

  configTrie.registerGreedy('ip sla schedule', 'Schedule an IP SLA', (args) => {
    const id = parseInt(args[0], 10);
    if (!Number.isNaN(id)) sla.schedule(id);
    return '';
  });
  configTrie.registerGreedy('ip sla group schedule', 'Schedule IP SLA group', (args) => {
    for (const tok of (args[1] ?? '').split(',')) {
      const id = parseInt(tok, 10);
      if (!Number.isNaN(id)) sla.schedule(id);
    }
    return '';
  });
  configTrie.registerGreedy('ip sla responder', 'Enable IP SLA responder', () => {
    sla.responderEnabled = true;
    return '';
  });
  configTrie.registerGreedy('ip sla enable', 'Enable IP SLA', () => { sla.globalEnabled = true; return ''; });
  configTrie.registerGreedy('no ip sla enable', 'Disable IP SLA', () => { sla.globalEnabled = false; return ''; });
  configTrie.registerGreedy('ip sla logging', 'Enable IP SLA logging', () => { sla.loggingTrapsEnabled = true; return ''; });
  configTrie.registerGreedy('no ip sla logging', 'Disable IP SLA logging', () => { sla.loggingTrapsEnabled = false; return ''; });
  configTrie.registerGreedy('ip sla reaction-configuration', 'Reaction config', (args) => {
    const opId = parseInt(args[0] ?? '', 10);
    if (isNaN(opId)) return '% Invalid operation ID';
    const r: import('../../inspection/config/IpSlaRepository').SlaReactionConfiguration = { opId, reactionType: 'rtt' };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'react' && args[i + 1]) { r.reactionType = args[i + 1]; i++; }
      else if (args[i] === 'threshold-type' && args[i + 1]) { r.thresholdType = args[i + 1]; i++; }
      else if (args[i] === 'threshold-value' && args[i + 1] && args[i + 2]) {
        r.thresholdValueLow = parseInt(args[i + 1], 10);
        r.thresholdValueHigh = parseInt(args[i + 2], 10);
        i += 2;
      }
      else if (args[i] === 'action-type' && args[i + 1]) {
        r.actionType = args[i + 1] as 'none' | 'trapAndTrigger' | 'trapOnly' | 'triggerOnly';
        i++;
      }
    }
    sla.addReaction(r);
    return '';
  });
  configTrie.registerGreedy('ip sla', 'Configure an IP SLA operation', (args) => {
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Incomplete command.';
    sla.ensure(id);
    ctx.setSelectedIpSla(id);
    ctx.setMode('config-ipsla');
    return '';
  });

  trackTrie.registerGreedy('track', 'Define another tracked object', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id)) return '% Invalid track number';
    defineTrack(track, args);
    ctx.setSelectedTrack(id);
    return '';
  });

  // ── config-track sub-mode ──
  trackTrie.registerGreedy('object', 'Add object to list', (args) => {
    const o = ctx.getSelectedTrack();
    const obj = o !== null ? track.get(o) : undefined;
    if (!obj) return '';
    const id = parseInt(args[0], 10);
    const wIdx = args.indexOf('weight');
    obj.members.push({
      id,
      weight: wIdx >= 0 ? parseInt(args[wIdx + 1], 10) : undefined,
      negate: args.includes('not'),
    });
    return '';
  });
  trackTrie.registerGreedy('threshold', 'Set list threshold', (args) => {
    const obj = ctx.getSelectedTrack() !== null
      ? track.get(ctx.getSelectedTrack()!) : undefined;
    if (obj) {
      const up = args.indexOf('up'); const dn = args.indexOf('down');
      if (up >= 0) obj.thresholdUp = parseInt(args[up + 1], 10);
      if (dn >= 0) obj.thresholdDown = parseInt(args[dn + 1], 10);
    }
    return '';
  });
  trackTrie.registerGreedy('delay', 'Set track delay', (args) => {
    const obj = ctx.getSelectedTrack() !== null
      ? track.get(ctx.getSelectedTrack()!) : undefined;
    if (obj) {
      const up = args.indexOf('up'); const dn = args.indexOf('down');
      if (up >= 0) obj.delayUp = parseInt(args[up + 1], 10);
      if (dn >= 0) obj.delayDown = parseInt(args[dn + 1], 10);
    }
    return '';
  });

  // ── config-ipsla sub-mode ──
  const slaProto = (type: 'icmp-echo' | 'udp-jitter' | 'tcp-connect' | 'http' | 'dns') =>
    (args: string[]): string => {
      const id = ctx.getSelectedIpSla();
      const op = id !== null ? sla.get(id) : undefined;
      if (op) {
        op.type = type;
        op.target = args.find((a) => /\d+\.\d+\.\d+\.\d+/.test(a)) ?? args[0] ?? null;
      }
      return '';
    };
  slaTrie.registerGreedy('icmp-echo', 'ICMP echo operation', slaProto('icmp-echo'));
  slaTrie.registerGreedy('udp-jitter', 'UDP jitter operation', slaProto('udp-jitter'));
  slaTrie.registerGreedy('tcp-connect', 'TCP connect operation', slaProto('tcp-connect'));
  slaTrie.registerGreedy('http', 'HTTP operation', slaProto('http'));
  slaTrie.registerGreedy('dns', 'DNS operation', slaProto('dns'));
  slaTrie.registerGreedy('frequency', 'Probe frequency', (args) => {
    const id = ctx.getSelectedIpSla();
    const op = id !== null ? sla.get(id) : undefined;
    if (op) op.frequency = parseInt(args[0], 10) || op.frequency;
    return '';
  });
  for (const kw of ['threshold', 'timeout', 'tag', 'history',
    'request-data-size', 'tos', 'verify-data', 'owner']) {
    slaTrie.registerGreedy(kw, `IP SLA ${kw}`, (args) => {
      const id = ctx.getSelectedIpSla();
      const op = id !== null ? sla.get(id) : undefined;
      if (!op) return '';
      const extra = (op as unknown as Record<string, unknown>);
      const n = parseInt(args[0] ?? '', 10);
      if (kw === 'threshold' && !isNaN(n)) extra.thresholdMs = n;
      else if (kw === 'timeout' && !isNaN(n)) extra.timeoutMs = n;
      else if (kw === 'tag') extra.tag = args.join(' ');
      else if (kw === 'history') extra.history = args.join(' ');
      else if (kw === 'request-data-size' && !isNaN(n)) extra.requestDataSize = n;
      else if (kw === 'tos' && !isNaN(n)) extra.tos = n;
      else if (kw === 'verify-data') extra.verifyData = true;
      else if (kw === 'owner') extra.owner = args.join(' ');
      return '';
    });
  }
}

export function registerTrackSlaShow(
  trie: CommandTrie, ctx: Ctx, track: TrackRepository, sla: IpSlaRepository,
): void {
  trie.registerGreedy('show track', 'Display tracked objects', (args) => {
    const router = ctx.r();
    const objs = track.all();
    if (!objs.length) return 'No tracked objects configured.';
    if (/^\d+$/.test(args[0] || '')) {
      const o = track.get(parseInt(args[0], 10));
      return o ? trackDetail(router, sla, track, o) : '% Track object not found';
    }
    if (args[0] === 'brief') {
      const rows = ['Track  Type                     State'];
      for (const o of objs) {
        rows.push(`${String(o.id).padEnd(7)}${o.type.padEnd(25)}` +
          `${track.state(router, sla, o.id)}`);
      }
      return rows.join('\n');
    }
    return objs.map((o) => trackDetail(router, sla, track, o)).join('\n');
  });

  const slaConfig = () => {
    const ops = sla.all();
    const reactions = sla.getReactions();
    const lines: string[] = [];
    lines.push(`IP SLA global state: ${sla.globalEnabled ? 'enabled' : 'disabled'}`);
    lines.push(`IP SLA logging traps: ${sla.loggingTrapsEnabled ? 'enabled' : 'disabled'}`);
    if (!ops.length && !reactions.length) return lines.concat('No IP SLA operations configured.').join('\n');
    for (const o of ops) {
      const extra = o as unknown as Record<string, unknown>;
      lines.push(`IP SLA Operation ${o.id}`);
      lines.push(`  Type of operation: ${o.type}`);
      lines.push(`  Target: ${o.target ?? 'not set'}`);
      lines.push(`  Frequency: ${o.frequency} sec`);
      lines.push(`  Schedule: ${o.scheduled ? 'Active' : 'Pending'}`);
      if (extra.thresholdMs !== undefined) lines.push(`  Threshold: ${extra.thresholdMs}ms`);
      if (extra.timeoutMs !== undefined) lines.push(`  Timeout: ${extra.timeoutMs}ms`);
      if (extra.tag) lines.push(`  Tag: ${extra.tag}`);
      if (extra.owner) lines.push(`  Owner: ${extra.owner}`);
      if (extra.requestDataSize !== undefined) lines.push(`  Request data size: ${extra.requestDataSize}`);
      if (extra.tos !== undefined) lines.push(`  Type of Service: ${extra.tos}`);
      if (extra.verifyData) lines.push('  Verify data: enabled');
    }
    if (reactions.length > 0) {
      lines.push('Reactions:');
      for (const r of reactions) {
        lines.push(`  Op ${r.opId} react=${r.reactionType} thresh-type=${r.thresholdType ?? 'none'} thresh=${r.thresholdValueLow ?? '-'}-${r.thresholdValueHigh ?? '-'} action=${r.actionType ?? 'none'}`);
      }
    }
    return lines.join('\n');
  };
  trie.registerGreedy('show ip sla configuration', 'Display IP SLA config', slaConfig);
  trie.registerGreedy('show ip sla statistics', 'Display IP SLA stats', () => {
    const router = ctx.r();
    const ops = sla.all();
    if (!ops.length) return 'No IP SLA operations configured.';
    return ops.map((o) =>
      `IPSLA operation id: ${o.id}\n` +
      `  Type of operation: ${o.type}\n` +
      `  Latest operation state: ${sla.state(router, o.id)}` +
      `${sla.reachable(router, o.id) ? ' (reachable)' : ' (unreachable)'}`)
      .join('\n');
  });
  trie.registerGreedy('show ip sla responder', 'Display IP SLA responder', () =>
    sla.responderEnabled
      ? 'IP SLA Responder is: Enabled'
      : 'IP SLA Responder is: Disabled');
  trie.registerGreedy('show ip sla', 'Display IP SLA', slaConfig);
}
