import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';

function normalizeZoneName(name: string): string {
  const lowered = name.toLowerCase();
  return lowered.endsWith('.') && lowered !== '.' ? lowered.slice(0, -1) : lowered;
}

export const namedCheckzoneCommand: LinuxCommand = {
  name: 'named-checkzone',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'named-checkzone zonename filename',
  help:
    'Zone file validity checking tool.\n\n' +
    'Checks the syntax and integrity of a zone file. It performs the same\n' +
    'checks as named does when loading a zone, which makes it useful for\n' +
    'checking zone files before configuring them into a name server.\n\n' +
    'ARGUMENTS\n' +
    '  zonename      The domain name of the zone being checked.\n' +
    '  filename      The name of the zone file.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (positional.length < 2) {
      return 'usage: named-checkzone [-dhjqvD] zonename filename';
    }

    const zoneName = normalizeZoneName(positional[0]);
    const file = positional[1];

    const content = ctx.executor.readFile(file);
    if (content === null) {
      return `zone ${zoneName}/IN: loading from master file ${file} failed: file not found`;
    }

    try {
      const zone = parseZoneFile(content, zoneName);
      return `zone ${zoneName}/IN: loaded serial ${zone.soa.data.serial}\nOK`;
    } catch (error) {
      if (error instanceof ZoneFileError) {
        return `zone ${zoneName}/IN: ${error.message}`;
      }
      throw error;
    }
  },
};
