import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { VxlanAgent } from '../../../vxlan/VxlanAgent';
import { hms } from '@/lib/format';

interface IfCtx {
  selectedInterface(): string | null;
  resolveInterfaceName(input: string): string | null;
  r(): Router;
}

interface ShowCtx {
  r(): Router;
}

function agent(router: Router): VxlanAgent | undefined {
  return (router as unknown as { getVxlanAgent?: () => VxlanAgent }).getVxlanAgent?.();
}

export function buildVxlanInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  trie.registerGreedy('source-interface', 'Set the NVE VTEP source interface', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.selectedInterface();
    if (!nve) return '% No interface selected';
    const raw = args.join(' ').replace(/\s+/g, '');
    const srcName = ctx.resolveInterfaceName(raw) ?? ctx.resolveInterfaceName(args.join(' '));
    if (!srcName) return `% Invalid interface "${args.join(' ')}"`;
    const ip = ctx.r().getPort(srcName)?.getIPAddress();
    if (!ip) return `% Interface ${srcName} has no IP address`;
    a.ensureInterface(nve, ip.toString());
    return '';
  });

  trie.registerGreedy('member vni', 'Bind a VNI to the NVE interface', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.selectedInterface();
    if (!nve) return '% No interface selected';
    const vni = parseInt(args[0], 10);
    if (Number.isNaN(vni)) return '% Invalid VNI';
    const cfgIface = a.getConfig().interfaces.get(nve);
    const localIp = cfgIface?.localVtepIp ?? '0.0.0.0';
    a.bindVni(nve, vni, localIp);
    for (let i = 1; i + 1 < args.length; i += 2) {
      const key = args[i].toLowerCase();
      const ip = args[i + 1];
      if ((key === 'peer-ip' || key === 'mcast-group') && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        a.addRemoteVtep(vni, ip);
      }
    }
    return '';
  });

  trie.registerGreedy('no member vni', 'Unbind a VNI from the NVE interface', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.selectedInterface();
    if (!nve) return '% No interface selected';
    const vni = parseInt(args[0], 10);
    if (Number.isNaN(vni)) return '% Invalid VNI';
    a.unbindVni(nve, vni);
    return '';
  });

  trie.registerGreedy('peer-ip', 'Add a static ingress-replication VTEP peer', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.selectedInterface();
    if (!nve) return '% No interface selected';
    const ip = args[0];
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return '% Invalid peer IP';
    const cfgIface = a.getConfig().interfaces.get(nve);
    if (!cfgIface) return '';
    for (const vni of cfgIface.vnis) a.addRemoteVtep(vni, ip);
    return '';
  });

  trie.registerGreedy('no peer-ip', 'Remove a static ingress-replication VTEP peer', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const nve = ctx.selectedInterface();
    if (!nve) return '% No interface selected';
    const ip = args[0];
    if (!ip) return '';
    const cfgIface = a.getConfig().interfaces.get(nve);
    if (!cfgIface) return '';
    for (const vni of cfgIface.vnis) a.removeRemoteVtep(vni, ip);
    return '';
  });
}

export function registerVxlanShowCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('show nve peers', 'Display VXLAN VTEP peers', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    let vniFilter: number | undefined;
    const vi = args.findIndex((x) => x.toLowerCase() === 'vni');
    if (vi >= 0 && args[vi + 1]) {
      const n = parseInt(args[vi + 1], 10);
      if (!Number.isNaN(n)) vniFilter = n;
    }
    const peers = a.listRemoteVteps(vniFilter);
    const rows = ['Interface  Peer-IP          VNI       State  LearnType  Uptime    Pkts-In   Pkts-Out'];
    for (const p of peers) {
      const iface = Array.from(a.getConfig().interfaces.values()).find((i) => i.vnis.has(p.vni))?.name ?? 'nve1';
      const age = p.lastSeenMs > 0 ? hms(Date.now() - p.lastSeenMs) : 'never';
      rows.push(`${iface.padEnd(11)}${p.remoteVtepIp.padEnd(17)}${String(p.vni).padEnd(10)}${'Up'.padEnd(7)}${'CP'.padEnd(11)}${age.padEnd(10)}${String(p.packetsIn).padEnd(10)}${p.packetsOut}`);
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show nve vni', 'Display VXLAN VNI bindings', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rows = ['Interface  VNI       Multicast-group  State  Mode  Source-IP'];
    for (const i of a.getConfig().interfaces.values()) {
      for (const vni of Array.from(i.vnis).sort((x, y) => x - y)) {
        rows.push(`${i.name.padEnd(11)}${String(vni).padEnd(10)}${'n/a'.padEnd(17)}${(i.enabled ? 'Up' : 'Down').padEnd(7)}${'CP'.padEnd(6)}${i.localVtepIp ?? 'n/a'}`);
      }
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show vxlan vni', 'Display VXLAN VNI table', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rows = ['VNI       Interface  Peers  MAC-entries  State'];
    for (const i of a.getConfig().interfaces.values()) {
      for (const vni of Array.from(i.vnis).sort((x, y) => x - y)) {
        const peers = a.listRemoteVteps(vni).length;
        const macs = a.listMacTable().filter((m) => m.vni === vni).length;
        rows.push(`${String(vni).padEnd(10)}${i.name.padEnd(11)}${String(peers).padEnd(7)}${String(macs).padEnd(13)}${i.enabled ? 'Up' : 'Down'}`);
      }
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show mac address-table vxlan', 'Display VXLAN learned MAC table', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rows = ['Vni       Mac Address       Remote-VTEP       Age'];
    for (const e of a.listMacTable()) {
      const age = e.lastSeenMs > 0 ? hms(Date.now() - e.lastSeenMs) : 'never';
      rows.push(`${String(e.vni).padEnd(10)}${e.mac.padEnd(18)}${e.remoteVtepIp.padEnd(18)}${age}`);
    }
    return rows.join('\n');
  });
}
