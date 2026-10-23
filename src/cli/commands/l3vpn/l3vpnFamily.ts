import type { CommandSpec } from '@/cli/CommandTable';
import {
  formatIpVrfBrief, formatIpVrfDetail, formatIpVrfInterfaces, formatVpnv4Labels, formatVpnv4Table,
  formatVrfBrief, formatVrfDetail, type VpnRow, type VrfView,
} from './l3vpnShow';

export interface VrfShowHost {
  vrfs(): readonly VrfView[];
}

export interface L3vpnShellHost extends VrfShowHost {
  routerId(): string;
  tableVersion(): number;
  vpnRows(): readonly VpnRow[];
  vpnv4Summary(): string;
  converge(): void;
}

const SHOW = Object.freeze(['user', 'privileged']);

function select(host: VrfShowHost, name: string | undefined): VrfView[] | string {
  const all = host.vrfs();
  if (name === undefined) return [...all];
  const found = all.filter(vrf => vrf.name === name);
  return found.length === 0 ? `% VRF ${name} does not exist` : found;
}

function vrfSpecs(host: () => VrfShowHost, words: readonly string[], label: string): CommandSpec[] {
  const NAME = { name: 'vrf', type: 'WORD' as const, optional: true, description: 'VRF name' };
  const modern = words[1] === 'vrf';
  const render = (kind: string, name: string | undefined): string => {
    const chosen = select(host(), name);
    if (typeof chosen === 'string') return chosen;
    if (kind === 'detail') return modern ? formatVrfDetail(chosen) : formatIpVrfDetail(chosen);
    if (kind === 'interfaces') return formatIpVrfInterfaces(chosen);
    return modern ? formatVrfBrief(chosen) : formatIpVrfBrief(chosen);
  };
  const forms: ReadonlyArray<readonly [string, string, boolean]> = modern
    ? [['brief', 'Concise information', true], ['detail', 'Detailed information', true]]
    : [['brief', 'Concise information', true], ['detail', 'Detailed information', true], ['interfaces', 'Interfaces bound to a VRF', false]];
  return [
    {
      id: `show-${label}`,
      path: [...words, NAME],
      description: 'Display the defined VRF instances',
      modes: SHOW, minPrivilege: 1,
      run: (_session, args) => render('brief', args.vrf),
    },
    ...forms.map(([keyword, description, named]): CommandSpec => ({
      id: `show-${label}-${keyword}`,
      path: [...words, keyword, ...(named ? [NAME] : [])],
      description,
      modes: SHOW, minPrivilege: 1,
      run: (_session, args) => render(keyword, args.vrf),
    })),
  ];
}

function importedBy(vrf: VrfView, row: VpnRow): boolean {
  return row.rd === vrf.rd || row.routeTargets.some(rt => vrf.importRts.includes(rt));
}

export function vrfShowFamily(host: () => VrfShowHost): CommandSpec[] {
  return [...vrfSpecs(host, ['show', 'ip', 'vrf'], 'ip-vrf'), ...vrfSpecs(host, ['show', 'vrf'], 'vrf')];
}

export function l3vpnFamily(host: () => L3vpnShellHost): CommandSpec[] {
  return [
    {
      id: 'show-ip-bgp-vpnv4',
      path: ['show', 'ip', 'bgp', 'vpnv4',
        { name: 'selector', type: 'WORD', description: 'all, rd <route-distinguisher> or vrf <name>' },
        { name: 'first', type: 'WORD', optional: true, description: 'Route distinguisher or VRF name, or summary / labels' },
        { name: 'second', type: 'WORD', optional: true, description: 'summary or labels' }],
      description: 'Display VPNv4 information from the BGP table',
      modes: SHOW, minPrivilege: 1,
      run: (_session, args) => {
        const selector = String(args.selector);
        const bad = "% Invalid input detected at '^' marker.";
        let target: string | undefined;
        let view: string | undefined;
        if (selector === 'all') {
          view = args.first === undefined ? undefined : String(args.first);
          if (args.second !== undefined) return bad;
        } else if (selector === 'rd' || selector === 'vrf') {
          if (args.first === undefined) return '% Incomplete command.';
          target = String(args.first);
          view = args.second === undefined ? undefined : String(args.second);
        } else {
          return bad;
        }
        if (view !== undefined && view !== 'summary' && view !== 'labels') return bad;
        host().converge();
        if (view === 'summary') return host().vpnv4Summary();
        let rows = [...host().vpnRows()];
        if (selector === 'rd') {
          rows = rows.filter(row => row.rd === target);
        } else if (selector === 'vrf') {
          const vrf = host().vrfs().find(candidate => candidate.name === target);
          if (vrf === undefined) return `% VRF ${target} does not exist`;
          rows = rows.filter(row => importedBy(vrf, row)).map(row => ({ ...row, rd: vrf.rd ?? row.rd, vrfName: vrf.name }));
        }
        return view === 'labels' ? formatVpnv4Labels(rows)
          : formatVpnv4Table({ version: host().tableVersion(), routerId: host().routerId() }, rows);
      },
    },
  ];
}
