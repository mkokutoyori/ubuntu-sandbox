import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const nmcliCommand: LinuxCommand = {
  name: 'nmcli',
  package: 'network-manager',
  needsNetworkContext: true,
  usage: 'nmcli [ device status | device show INTERFACE ]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const filtered = args.filter(a => !a.startsWith('-'));
    const [object, verb, ...rest] = filtered;
    const isDevice = object === 'device' || object === 'dev' || object === 'd';
    if (isDevice && (!verb || verb === 'status')) {
      return ctx.netConfig.nmcliDeviceStatus(ctx.net);
    }
    if (isDevice && verb === 'show') {
      const iface = rest[0];
      if (!iface) {
        return [...ctx.net.getPorts().keys()].map(n => ctx.netConfig.nmcliDeviceShow(ctx.net, n)).join('\n\n');
      }
      return ctx.netConfig.nmcliDeviceShow(ctx.net, iface);
    }
    return `nmcli: '${filtered.join(' ')}' is not a valid command`;
  },
};
