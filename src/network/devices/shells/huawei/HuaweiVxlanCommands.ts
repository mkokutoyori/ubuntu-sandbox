import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { VxlanAgent } from '../../../vxlan/VxlanAgent';
import { hms } from '@/lib/format';

interface IfCtx {
  getSelectedInterface(): string | null;
  r(): Router;
}

interface ShowCtx {
  r(): Router;
}

function agent(router: Router): VxlanAgent | undefined {
  return (router as unknown as { getVxlanAgent?: () => VxlanAgent }).getVxlanAgent?.();
}

export function buildHuaweiVxlanInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  trie.registerGreedy('source-interface', 'Set NVE VTEP source interface', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.getSelectedInterface();
    if (!nve) return 'Error: No interface selected';
    const raw = args.join(' ').replace(/\s+/g, '');
    const srcPort = ctx.r().getPort(raw);
    if (!srcPort) return `Error: Interface ${raw} not found`;
    const ip = srcPort.getIPAddress();
    if (!ip) return `Error: Interface ${raw} has no IP address`;
    a.ensureInterface(nve, ip.toString());
    return '';
  });

  trie.registerGreedy('vni', 'Bind VNI to NVE interface with head-end peer-list', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.getSelectedInterface();
    if (!nve) return 'Error: No interface selected';
    const vni = parseInt(args[0], 10);
    if (Number.isNaN(vni)) return 'Error: Invalid VNI';
    const cfgIface = a.getConfig().interfaces.get(nve);
    const localIp = cfgIface?.localVtepIp ?? '0.0.0.0';
    a.bindVni(nve, vni, localIp);
    const headEndIdx = args.findIndex((x) => x.toLowerCase() === 'head-end');
    if (headEndIdx >= 0 && args[headEndIdx + 1] === 'peer-list') {
      for (let i = headEndIdx + 2; i < args.length; i++) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(args[i])) {
          a.addRemoteVtep(vni, args[i]);
        }
      }
    }
    return '';
  });

  trie.registerGreedy('undo vni', 'Unbind VNI from NVE interface', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.getSelectedInterface();
    if (!nve) return 'Error: No interface selected';
    const vni = parseInt(args[0], 10);
    if (Number.isNaN(vni)) return 'Error: Invalid VNI';
    a.unbindVni(nve, vni);
    return '';
  });
}

export function registerHuaweiVxlanDisplayCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('display vxlan vni', 'Display VXLAN VNI bindings', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rows = [
      'VNI        Interface   Local-VTEP       Peers  Status',
    ];
    for (const i of a.getConfig().interfaces.values()) {
      for (const vni of Array.from(i.vnis).sort((x, y) => x - y)) {
        const peers = a.listRemoteVteps(vni).length;
        rows.push(
          `${String(vni).padEnd(11)}${i.name.padEnd(12)}${(i.localVtepIp ?? 'unconfigured').padEnd(17)}${String(peers).padEnd(7)}${i.enabled ? 'active' : 'inactive'}`,
        );
      }
    }
    if (rows.length === 1) rows.push('No VXLAN VNI configured.');
    return rows.join('\n');
  });

  trie.registerGreedy('display vxlan tunnel', 'Display VXLAN tunnel (peer VTEP) table', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    let vniFilter: number | undefined;
    if (args[0] && /^\d+$/.test(args[0])) vniFilter = parseInt(args[0], 10);
    const peers = a.listRemoteVteps(vniFilter);
    const rows = [
      'RemoteVTEP       VNI        Interface   Age       Pkts-In   Pkts-Out',
    ];
    for (const p of peers) {
      const iface = Array.from(a.getConfig().interfaces.values()).find((i) => i.vnis.has(p.vni))?.name ?? 'Nve1';
      const age = p.lastSeenMs > 0 ? hms(Date.now() - p.lastSeenMs) : 'never';
      rows.push(
        `${p.remoteVtepIp.padEnd(17)}${String(p.vni).padEnd(11)}${iface.padEnd(12)}${age.padEnd(10)}${String(p.packetsIn).padEnd(10)}${p.packetsOut}`,
      );
    }
    if (rows.length === 1) rows.push('No VXLAN tunnel entries.');
    return rows.join('\n');
  });

  trie.registerGreedy('display vxlan mac', 'Display VXLAN MAC address table', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rows = ['VNI        MAC Address        Remote-VTEP       Age'];
    for (const e of a.listMacTable()) {
      const age = e.lastSeenMs > 0 ? hms(Date.now() - e.lastSeenMs) : 'never';
      rows.push(`${String(e.vni).padEnd(11)}${e.mac.padEnd(19)}${e.remoteVtepIp.padEnd(18)}${age}`);
    }
    if (rows.length === 1) rows.push('No VXLAN MAC entries.');
    return rows.join('\n');
  });
}
