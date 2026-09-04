/**
 * HuaweiPimCommands - PIM CLI commands for Huawei VRP Shell
 *
 * Counterpart of `cisco/CiscoPimCommands.ts`, driving the same `PimAgent`
 * through VRP's own grammar:
 *   - System view: "multicast routing-enable", "pim" (enters PIM view)
 *   - PIM view: "static-rp <ip>", "undo static-rp <ip>", "timer join-prune"
 *   - Interface view: "pim sm", "pim dm", "undo pim sm|dm",
 *                     "pim hello-option dr-priority", "pim timer hello"
 *   - Display: "display pim neighbor", "display pim interface",
 *              "display pim rp-info", "display multicast routing-table"
 *
 * VRP's interface view offers only `pim sm` and `pim dm` — there is no
 * `sparse-dense` equivalent, so none is registered here; the engine's
 * third mode stays reachable from the Cisco side only.
 */
import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { PimAgent } from '../../../pim/PimAgent';
import { hms } from '@/lib/format';
import { HUAWEI_ERRORS } from '../cli-utils';

export interface HuaweiPimContext {
  r(): Router;
  getSelectedInterface(): string | null;
}

/**
 * Same disclosure as the Cisco side: the engine only ever builds
 * explicit-join state, so `pim dm` must not silently imply flood-and-prune.
 */
export const HUAWEI_PIM_DM_NOTE =
  'Info: PIM-DM is accepted but behaves as PIM-SM in this simulator '
  + '(explicit join only — flood-and-prune is not modelled).';

function agent(router: Router): PimAgent | undefined {
  return (router as unknown as { getPimAgent?: () => PimAgent }).getPimAgent?.();
}

export function registerHuaweiPimInterfaceCommands(trie: CommandTrie, ctx: HuaweiPimContext): void {
  trie.registerGreedy('pim', 'Configure PIM on the interface', (args) => {
    const a = agent(ctx.r());
    const iface = ctx.getSelectedInterface();
    if (!a || !iface) return '';
    if (args[0] === undefined) {
      return HUAWEI_ERRORS.INCOMPLETE('pim');
    }
    const sub = args[0].toLowerCase();

    if (sub === 'sm') { a.enableInterface(iface, 'sparse'); return ''; }
    if (sub === 'dm') { a.enableInterface(iface, 'dense'); return HUAWEI_PIM_DM_NOTE; }

    if (sub === 'hello-option' && (args[1] ?? '').toLowerCase() === 'dr-priority') {
      const prio = parseInt(args[2] ?? '', 10);
      if (Number.isNaN(prio) || prio < 0) return 'Error: Wrong parameter found at \'^\' position.';
      a.setDrPriority(iface, prio);
      return '';
    }

    if (sub === 'timer' && (args[1] ?? '').toLowerCase() === 'hello') {
      const secs = parseInt(args[2] ?? '', 10);
      if (Number.isNaN(secs) || secs <= 0) return 'Error: Wrong parameter found at \'^\' position.';
      a.setHelloInterval(iface, secs);
      return '';
    }

    return 'Error: Unrecognized command found at \'^\' position.';
  });

  trie.registerGreedy('undo pim', 'Remove PIM from the interface', (args) => {
    const a = agent(ctx.r());
    const iface = ctx.getSelectedInterface();
    if (!a || !iface) return '';
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === '' || sub === 'sm' || sub === 'dm') { a.disableInterface(iface); return ''; }
    if (sub === 'hello-option') { a.setDrPriority(iface, 1); return ''; }
    if (sub === 'timer') { a.setHelloInterval(iface, 30); return ''; }
    return 'Error: Unrecognized command found at \'^\' position.';
  });
}

export function registerHuaweiPimViewCommands(trie: CommandTrie, ctx: HuaweiPimContext): void {
  trie.registerGreedy('static-rp', 'Configure a static RP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rp = args[0];
    if (!rp) return 'Error: Incomplete command.';
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(rp)) return 'Error: Wrong parameter found at \'^\' position.';
    a.addStaticRp(rp);
    return '';
  });

  trie.registerGreedy('undo static-rp', 'Remove a static RP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rp = args[0];
    if (!rp) return 'Error: Incomplete command.';
    a.removeStaticRp(rp);
    return '';
  });

  // VRP names the BSR/RP candidates after the interface they take their
  // address from: `c-bsr GigabitEthernet0/0/0 [hash-len] [priority]`.
  const resolveIfaceIp = (iface: string | undefined): string | null =>
    iface ? (ctx.r().getPort(iface)?.getIPAddress()?.toString() ?? null) : null;

  trie.registerGreedy('c-bsr', 'Configure this router as a candidate BSR', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (!args[0]) return 'Error: Incomplete command.';
    const ip = resolveIfaceIp(args[0]);
    if (!ip) return 'Error: The interface has no IP address.';
    const priority = args[2] !== undefined ? parseInt(args[2], 10) : 0;
    if (Number.isNaN(priority) || priority < 0 || priority > 255) {
      return 'Error: Wrong parameter found at \'^\' position.';
    }
    a.setBsrCandidate(ip, priority);
    return '';
  });

  trie.registerGreedy('undo c-bsr', 'Remove the candidate BSR configuration', () => {
    agent(ctx.r())?.clearBsrCandidate();
    return '';
  });

  trie.registerGreedy('c-rp', 'Advertise this router as a candidate RP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (!args[0]) return 'Error: Incomplete command.';
    const ip = resolveIfaceIp(args[0]);
    if (!ip) return 'Error: The interface has no IP address.';
    const pIdx = args.findIndex(x => x.toLowerCase() === 'priority');
    const priority = pIdx >= 0 ? parseInt(args[pIdx + 1] ?? '', 10) : 0;
    if (Number.isNaN(priority) || priority < 0 || priority > 255) {
      return 'Error: Wrong parameter found at \'^\' position.';
    }
    a.setRpCandidate(ip, priority);
    return '';
  });

  trie.registerGreedy('undo c-rp', 'Remove the candidate RP configuration', () => {
    agent(ctx.r())?.clearRpCandidate();
    return '';
  });

  trie.registerGreedy('timer join-prune', 'Set the Join/Prune interval', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const secs = parseInt(args[0] ?? '', 10);
    if (Number.isNaN(secs) || secs <= 0) return 'Error: Wrong parameter found at \'^\' position.';
    a.setJoinPruneInterval(secs);
    return '';
  });
}

export function registerHuaweiPimDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('display pim neighbor', 'Display PIM neighbors', (args) => {
    const r = getRouter();
    const a = agent(r);
    if (!a) return '';
    const now = a.nowMs();
    const idx = args.findIndex(x => x.toLowerCase() === 'interface');
    const iface = idx >= 0 ? args[idx + 1] : undefined;
    const neighbors = a.listNeighbors(iface);
    if (neighbors.length === 0) return 'Info: No PIM neighbor exists.';
    const lines = [
      ' VPN-Instance: public net',
      ` Total Number of Neighbors = ${neighbors.length}`,
      '',
      ' Neighbor        Interface            Uptime   Expires  Dr-Priority BFD-Session',
    ];
    for (const n of neighbors) {
      const uptime = hms(now - n.upSinceMs);
      const expires = hms(Math.max(0, n.helloHoldSec * 1000 - (now - n.lastHeardMs)));
      lines.push(
        ` ${n.neighborIp.padEnd(16)}${n.iface.padEnd(21)}${uptime.padEnd(9)}${expires.padEnd(9)}${String(n.drPriority).padEnd(12)}N`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display pim interface', 'Display PIM interface state', (args) => {
    const r = getRouter();
    const a = agent(r);
    if (!a) return '';
    const requested = args.find(x => x.toLowerCase() !== 'verbose');
    const ifaces = Array.from(a.getConfig().interfaces.keys())
      .filter(n => !requested || n.toLowerCase() === requested.toLowerCase());
    if (ifaces.length === 0) return 'Info: No PIM interface exists.';
    const lines = [
      ' VPN-Instance: public net',
      ' Interface           State NbrCnt HelloInt   DR-Pri     DR-Address',
    ];
    let anyDense = false;
    for (const name of ifaces) {
      const rt = a.getInterfaceRuntime(name);
      if (!rt) continue;
      if (rt.mode !== 'sparse') anyDense = true;
      const port = r.getPort(name);
      const up = port?.getIsUp() && port?.isConnected();
      lines.push(
        ` ${name.padEnd(20)}${(up ? 'up' : 'down').padEnd(6)}${String(a.listNeighbors(name).length).padEnd(7)}${String(rt.helloIntervalSec).padEnd(11)}${String(rt.drPriority).padEnd(11)}${rt.designatedRouterIp ?? '0.0.0.0'}`);
    }
    if (anyDense) {
      lines.push('');
      lines.push(' Note: PIM-DM is displayed as configured but behaves as PIM-SM in this');
      lines.push('       simulator (explicit join only — no flood-and-prune).');
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display pim rp-info', 'Display PIM RP information', (args) => {
    const a = agent(getRouter());
    if (!a) return '';
    const groupFilter = args.find(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
    const rps = a.listRps().filter(rp =>
      !groupFilter || a.resolveRpForGroup(groupFilter) === rp.rpAddress);
    if (rps.length === 0) return 'Info: No RP information is available.';
    const now = a.nowMs();
    const statics = rps.filter(rp => rp.isStatic);
    const learned = rps.filter(rp => !rp.isStatic);
    const lines = [' VPN-Instance: public net'];
    if (statics.length > 0) {
      lines.push(` PIM-SM static RP Number:${statics.length}`);
      for (const rp of statics) {
        lines.push(`   Static RP Address is: ${rp.rpAddress}`);
        lines.push(`   Group/MaskLen: ${rp.groupRangeAddress}/${rp.groupRangeMaskBits}`);
      }
    }
    if (learned.length > 0) {
      lines.push(` PIM-SM BSR RP Number:${learned.length}`);
      for (const rp of learned) {
        lines.push(`   Group/MaskLen: ${rp.groupRangeAddress}/${rp.groupRangeMaskBits}`);
        lines.push(`     RP: ${rp.rpAddress}`);
        lines.push(`     Priority: ${rp.priority ?? 0}`);
        lines.push(`     Expires: ${hms(Math.max(0, (rp.expiresMs ?? now) - now))}`);
      }
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display pim bsr-info', 'Display PIM BSR information', () => {
    const a = agent(getRouter());
    if (!a) return '';
    const cfg = a.getConfig();
    if (!cfg.currentBsr && !cfg.bsrCandidate) return 'Info: No BSR information is available.';
    const lines = [' VPN-Instance: public net'];
    if (cfg.currentBsr) {
      lines.push(' Elected BSR Address: ' + cfg.currentBsr.address);
      lines.push('   Priority: ' + cfg.currentBsr.priority);
      lines.push('   Hash mask length: 30');
      lines.push('   State: ' + (cfg.bsrCandidate
        && cfg.bsrCandidate.address === cfg.currentBsr.address ? 'Elected' : 'Accept Preferred'));
    }
    if (cfg.bsrCandidate) {
      lines.push(' Candidate BSR Address: ' + cfg.bsrCandidate.address);
      lines.push('   Priority: ' + cfg.bsrCandidate.priority);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display multicast routing-table', 'Display the multicast routing table', (args) => {
    const a = agent(getRouter());
    if (!a) return '';
    const now = a.nowMs();
    const groupFilter = args.find(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
    const mroutes = a.listMroutes().filter(m => !groupFilter || m.groupAddress === groupFilter);
    if (mroutes.length === 0) return 'Info: No multicast routing entry is found.';
    const lines = [
      ' Multicast routing table of VPN-Instance: public net',
      ` Total ${mroutes.length} entry`,
      '',
    ];
    let n = 0;
    for (const m of mroutes) {
      n++;
      lines.push(` ${String(n).padStart(5, '0')}. (${m.sourceAddress ?? '*'}, ${m.groupAddress})`);
      lines.push(`       Uptime: ${hms(now - m.uptimeMs)}`);
      lines.push(`       Upstream Interface: ${m.incomingInterface ?? 'NULL'}`);
      const oifs = Array.from(m.outgoingInterfaces);
      lines.push(`           List of ${oifs.length} downstream interface${oifs.length === 1 ? '' : 's'}`);
      oifs.forEach((oif, i) => lines.push(`               ${i + 1}: ${oif}`));
    }
    return lines.join('\n');
  });
}
