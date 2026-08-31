export interface AggregateMemberView {
  readonly name: string;
  readonly up: boolean;
  readonly speedMbps: number | null;
  readonly actorState: string;
  readonly partnerState: string;
  readonly aggregatorId: number;
  readonly partnerMac: string;
  readonly linkFailureCount: number;
  readonly permanentMac: string;
}

export interface AggregateView {
  readonly name: string;
  readonly up: boolean;
  readonly lacpMode: 'static' | 'active' | 'passive';
  readonly lacpSpeed: 'slow' | 'fast';
  readonly algorithm: 'L2' | 'L3' | 'L4';
  readonly minLinks: number;
  readonly systemMac: string;
  readonly members: readonly AggregateMemberView[];
}

export const ACTOR_STATE_SYNCED = 'ASAIEE';

export function actorStateFlags(
  mode: 'static' | 'active' | 'passive',
  speed: 'slow' | 'fast',
  synced: boolean,
): string {
  return [
    mode === 'active' ? 'A' : 'P',
    speed === 'fast' ? 'F' : 'S',
    'A',
    synced ? 'I' : 'O',
    synced ? 'E' : 'D',
    synced ? 'E' : 'D',
  ].join('');
}

export function renderAggregateList(views: readonly AggregateView[]): string {
  if (views.length === 0) return '';
  const lines: string[] = [];
  for (const v of views) {
    lines.push(`${v.name}: ${v.up ? 'up' : 'down'} lacp-mode ${v.lacpMode} `
      + `algorithm ${v.algorithm}`);
  }
  return lines.join('\n');
}

export function renderAggregateDetail(v: AggregateView): string {
  const lines: string[] = [];
  lines.push(`${v.name}`);
  lines.push(`\tstatus: ${v.up ? 'up' : 'down'}`);
  lines.push(`\tnum_ports=${v.members.length} min_links=${v.minLinks}`);
  lines.push(`\tlacp-mode: ${v.lacpMode}`);
  lines.push(`\tlacp-speed: ${v.lacpSpeed}`);
  lines.push(`\tdistribution algorithm: ${v.algorithm}`);
  lines.push(`\tLACP flags: (A|P) - LACP mode is Active or Passive`);
  lines.push(`\t            (S|F) - LACP speed is Slow or Fast`);
  lines.push(`\t            (A|I) - Aggregatable or Individual`);
  lines.push(`\t            (I|O) - Port In sync or Out of sync`);
  lines.push(`\t            (E|D) - Frame collection is Enabled or Disabled`);
  lines.push(`\t            (E|D) - Frame distribution is Enabled or Disabled`);
  for (const m of v.members) {
    lines.push('');
    lines.push(`slave: ${m.name}`);
    lines.push(`\tstatus: ${m.up ? 'up' : 'down'}`);
    lines.push(`\tlink failure count: ${m.linkFailureCount}`);
    lines.push(`\tpermanent MAC addr: ${m.permanentMac}`);
    lines.push(`\taggregator ID: ${m.aggregatorId}`);
    lines.push(`\tactor state: ${m.actorState}`);
    lines.push(`\tpartner state: ${m.partnerState}`);
    lines.push(`\tpartner system MAC addr: ${m.partnerMac}`);
    lines.push(`\tspeed: ${m.speedMbps === null ? 'unknown' : `${m.speedMbps}Mbps`}`);
  }
  return lines.join('\n');
}
