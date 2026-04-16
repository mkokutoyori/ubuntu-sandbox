/**
 * `arp` — display and manipulate the ARP cache.
 *
 * Thin wrapper around the pre-existing `linuxArp` implementation (which
 * handles all the net-tools flag parsing). The command adapts the
 * `LinuxNetKernel` façade to the `LinuxArpContext` expected by the
 * legacy helper.
 *
 * Extracted from `LinuxPC.cmdArp`. See `linux_gap.md` §8.4 (PR 4).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { ARPEntry } from '../../../EndHost';
import { linuxArp, type LinuxArpContext } from '../../LinuxArp';

export const arpCommand: LinuxCommand = {
  name: 'arp',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'arp [-a] [-d hostname] [-s hostname hw_addr] [-i interface]',
  help:
    'Manipulate the system ARP cache.\n\n' +
    'OPTIONS\n' +
    '  -a            Display all entries in the ARP table.\n' +
    '  -d hostname   Delete an entry from the ARP table.\n' +
    '  -s hostname hw_addr   Create a static ARP entry.\n' +
    '  -i interface  Limit operation to a specific interface.',

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    const prev = args.length >= 2 ? args[args.length - 2] : '';
    if (partial.startsWith('-')) {
      return ['-a', '-d', '-s', '-i', '-n'].filter(f => f.startsWith(partial));
    }
    // After -d or -s, complete with IP addresses from the ARP cache
    if (prev === '-d' || prev === '-s') {
      return Array.from(ctx.net.getArpTable().keys());
    }
    // After -i, complete with interface names
    if (prev === '-i') {
      return Array.from(ctx.net.getPorts().keys());
    }
    return [];
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    const ports = ctx.net.getPorts();
    const firstPortName = ports.keys().next().value ?? 'eth0';

    const arpCtx: LinuxArpContext = {
      // `linuxArp` only reads the map (entries/filter). A readonly view
      // is sufficient; the cast is safe because nothing writes through
      // this field.
      arpTable: ctx.net.getArpTable() as Map<string, ARPEntry>,
      addStaticARP: (ip, mac, iface) => ctx.net.addStaticARP(ip, mac, iface),
      deleteARP: (ip) => ctx.net.deleteARP(ip),
      defaultIface: firstPortName,
    };

    return linuxArp(arpCtx, args);
  },
};
