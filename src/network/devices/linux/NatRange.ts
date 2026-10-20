import { IPAddress } from '../../core/types';

export type NatTargetName = 'DNAT' | 'SNAT' | 'MASQUERADE' | 'REDIRECT';

export interface NatPorts {
  readonly min: number;
  readonly max: number;
  readonly base: number | null;
}

export interface NatRange {
  readonly addresses: { readonly min: IPAddress; readonly max: IPAddress } | null;
  readonly ports: NatPorts | null;
  readonly random: boolean;
  readonly randomFully: boolean;
  readonly persistent: boolean;
}

export type NatRangeParse =
  | { readonly kind: 'range'; readonly range: NatRange }
  | { readonly kind: 'problem'; readonly problem: string };

export const NAT_ADDRESS_OPTION: Readonly<Record<NatTargetName, string>> = {
  DNAT: '--to-destination', SNAT: '--to-source', MASQUERADE: '--to-ports', REDIRECT: '--to-ports',
};

const PORTS_NEED_A_PROTOCOL = 'Need TCP, UDP, SCTP or DCCP with port specification';
const MAX_PORT = 65535;

function problem(text: string): NatRangeParse {
  return { kind: 'problem', problem: text };
}

function atoi(text: string): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function strtoui(text: string): { readonly value: number; readonly rest: string } | null {
  const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (match === null) return null;
  const digits = match[1];
  const value = /^0[xX]/.test(digits) ? Number.parseInt(digits, 16) : /^0\d/.test(digits) ? Number.parseInt(digits, 8) : Number.parseInt(digits, 10);
  return value > MAX_PORT ? null : { value, rest: text.slice(digits.length) };
}

function rangeOf(parts: Partial<NatRange>): NatRange {
  return {
    addresses: parts.addresses ?? null,
    ports: parts.ports ?? null,
    random: parts.random ?? false,
    randomFully: parts.randomFully ?? false,
    persistent: parts.persistent ?? false,
  };
}

export function parseAddressAndPorts(text: string, portsAllowed: boolean, offsetAllowed: boolean): NatRangeParse {
  const colon = text.indexOf(':');
  let ports: NatPorts | null = null;
  let addressText = text;
  if (colon >= 0) {
    if (!portsAllowed) return problem(PORTS_NEED_A_PROTOCOL);
    const afterColon = text.slice(colon + 1);
    const first = atoi(afterColon);
    if (first <= 0 || first > MAX_PORT) return problem(`Port \`${afterColon}' not valid\n`);
    if (afterColon.includes(':')) return problem('Invalid port:port syntax - use dash\n');
    const dash = text.indexOf('-', colon);
    if (dash < 0) {
      ports = { min: first, max: first, base: null };
    } else {
      const afterDash = text.slice(dash + 1);
      const last = atoi(afterDash);
      if (last <= 0 || last > MAX_PORT) return problem(`Port \`${afterDash}' not valid\n`);
      if (last < first) return problem(`Port range \`${afterColon}' funky\n`);
      const slash = offsetAllowed ? text.indexOf('/', dash) : -1;
      let base: number | null = null;
      if (slash >= 0) {
        const afterSlash = text.slice(slash + 1);
        base = atoi(afterSlash);
        if (base <= 0 || base > MAX_PORT) return problem(`Port \`${afterSlash}' not valid\n`);
      }
      ports = { min: first, max: last, base };
    }
    if (colon === 0) return { kind: 'range', range: rangeOf({ ports }) };
    addressText = text.slice(0, colon);
  }
  const dash = addressText.indexOf('-');
  const firstText = dash < 0 ? addressText : addressText.slice(0, dash);
  const first = IPAddress.tryParse(firstText);
  if (first === null) return problem(`Bad IP address "${firstText}"\n`);
  let last = first;
  if (dash >= 0) {
    const lastText = addressText.slice(dash + 1);
    const parsed = IPAddress.tryParse(lastText);
    if (parsed === null) return problem(`Bad IP address "${lastText}"\n`);
    last = parsed;
  }
  return { kind: 'range', range: rangeOf({ addresses: { min: first, max: last }, ports }) };
}

export function parsePortRange(target: 'MASQUERADE' | 'REDIRECT', text: string): NatRangeParse {
  const bad = problem(`${target}: Bad value for "--to-ports" option: "${text}"`);
  const first = strtoui(text);
  if (first === null) return bad;
  if (first.rest === '') return { kind: 'range', range: rangeOf({ ports: { min: first.value, max: first.value, base: null } }) };
  if (!first.rest.startsWith('-')) return bad;
  const last = strtoui(first.rest.slice(1));
  if (last === null || last.rest !== '' || last.value < first.value) return bad;
  return { kind: 'range', range: rangeOf({ ports: { min: first.value, max: last.value, base: null } }) };
}

export interface NatTargetOptions {
  readonly toAddress: string | undefined;
  readonly toPorts: string | undefined;
  readonly random: boolean;
  readonly randomFully: boolean;
  readonly persistent: boolean;
  readonly toAddressCount: number;
}

export function natRangeOfTarget(target: NatTargetName, options: NatTargetOptions, portsAllowed: boolean): NatRangeParse {
  const flags = { random: options.random, randomFully: options.randomFully, persistent: options.persistent };
  if (target === 'DNAT' || target === 'SNAT') {
    const label = target === 'DNAT' ? '--to-destination' : '--to-source';
    if (options.toAddress === undefined) return problem(`${target}: option "${label}" must be specified\n`);
    if (options.toAddressCount > 1) return problem(`${target}: Multiple ${label} not supported`);
    const parsed = parseAddressAndPorts(options.toAddress, portsAllowed, target === 'DNAT');
    return parsed.kind === 'problem' ? parsed : { kind: 'range', range: rangeOf({ ...parsed.range, ...flags }) };
  }
  if (options.toPorts === undefined) return { kind: 'range', range: rangeOf(target === 'REDIRECT' ? {} : flags) };
  if (!portsAllowed) return problem(PORTS_NEED_A_PROTOCOL);
  const parsed = parsePortRange(target, options.toPorts);
  return parsed.kind === 'problem' ? parsed : { kind: 'range', range: rangeOf({ ...parsed.range, ...flags }) };
}

function portsText(ports: NatPorts): string {
  const span = ports.min === ports.max ? String(ports.min) : `${ports.min}-${ports.max}`;
  return ports.base === null ? span : `${span}/${ports.base}`;
}

function addressesText(range: NatRange): string {
  if (range.addresses === null) return '';
  const { min, max } = range.addresses;
  return min.equals(max) ? min.toString() : `${min.toString()}-${max.toString()}`;
}

function toText(range: NatRange): string {
  return `${addressesText(range)}${range.ports === null ? '' : `:${portsText(range.ports)}`}`;
}

export function natListing(target: NatTargetName, range: NatRange): string {
  switch (target) {
    case 'DNAT':
      return [`to:${toText(range)}`, ...(range.random ? ['random'] : []), ...(range.persistent ? ['persistent'] : [])].join(' ');
    case 'SNAT':
      return [`to:${toText(range)}`, ...(range.random ? ['random'] : []), ...(range.randomFully ? ['random-fully'] : []),
        ...(range.persistent ? ['persistent'] : [])].join(' ');
    case 'MASQUERADE':
      return [...(range.ports === null ? [] : [`masq ports: ${portsText(range.ports)}`]), ...(range.random ? ['random'] : []),
        ...(range.randomFully ? ['random-fully'] : [])].join(' ');
    case 'REDIRECT':
      return range.ports === null ? '' : [`redir ports ${portsText(range.ports)}`, ...(range.random ? ['random'] : [])].join(' ');
  }
}

export function natSaveOptions(target: NatTargetName, range: NatRange): string[] {
  const options: string[] = [];
  if (target === 'DNAT' || target === 'SNAT') options.push(NAT_ADDRESS_OPTION[target], toText(range));
  else if (range.ports !== null) options.push('--to-ports', portsText(range.ports));
  if (range.random) options.push('--random');
  if (range.randomFully) options.push('--random-fully');
  if (range.persistent) options.push('--persistent');
  return options;
}
