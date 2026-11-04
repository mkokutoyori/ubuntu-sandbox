import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { parseNamedConf } from '../../bind9/NamedConfParser';
import { NamedConfSyntaxError } from '../../bind9/NamedConfLexer';
import { buildNamedConfig, NamedConfigError } from '../../bind9/NamedConfig';
import type { NamedConfig, NamedZone } from '../../bind9/NamedConfig';
import { loadZoneFile, zoneFailureReport, ZoneFileError } from '@/network/dns/zone/ZoneFile';

const DEFAULT_CONF = '/etc/bind/named.conf';

interface ZoneCheck {
  readonly lines: readonly string[];
  readonly failed: boolean;
}

function loadZoneLines(zone: NamedZone, readFile: (path: string) => string | null): ZoneCheck {
  const content = zone.file === null ? null : readFile(zone.file);
  if (content === null) {
    return {
      lines: [
        `zone ${zone.name}/IN: loading from master file ${zone.file} failed: file not found`,
        `zone ${zone.name}/IN: not loaded due to errors.`,
        `_default/${zone.name}/IN: file not found`,
      ],
      failed: true,
    };
  }
  try {
    const { zone: loaded, warnings } = loadZoneFile(content, zone.name);
    return {
      lines: [
        ...warnings.map((warning) => warning(zone.file!, zone.name)),
        `zone ${zone.name}/IN: loaded serial ${loaded.soa.data.serial}`,
      ],
      failed: false,
    };
  } catch (error) {
    if (error instanceof ZoneFileError) {
      return {
        lines: [...zoneFailureReport(zone.name, zone.file!, error), `_default/${zone.name}/IN: ${error.stage === 'load' ? error.reason : 'bad zone'}`],
        failed: true,
      };
    }
    throw error;
  }
}

function checkZones(config: NamedConfig, readFile: (path: string) => string | null): { output: string; exitCode: number } {
  const lines: string[] = [];
  let failed = false;
  for (const zone of config.zones) {
    if (zone.type !== 'primary' && zone.type !== 'hint') continue;
    const check = loadZoneLines(zone, readFile);
    lines.push(...check.lines);
    failed = failed || check.failed;
  }
  return { output: lines.join('\n'), exitCode: failed ? 1 : 0 };
}

export const namedCheckconfCommand: LinuxCommand = {
  name: 'named-checkconf',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'named-checkconf [-z] [filename]',
  help:
    'Named configuration file syntax checking tool.\n\n' +
    'Checks the syntax, but not the semantics, of a named configuration\n' +
    'file. The default file checked is /etc/bind/named.conf.\n\n' +
    'OPTIONS\n' +
    '  -z            Perform a test load of all zones of type primary\n' +
    '                found in named.conf.\n' +
    '  filename      The name of the configuration file to be checked.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
    let file = DEFAULT_CONF;
    let loadZones = false;
    for (const arg of args) {
      if (arg === '-z') loadZones = true;
      else if (!arg.startsWith('-')) file = arg;
    }

    const readFile = (path: string): string | null => ctx.executor.readFile(path);
    const source = readFile(file);
    if (source === null) {
      return { output: `named-checkconf: open: ${file}: file not found`, exitCode: 1 };
    }

    try {
      const config = buildNamedConfig(parseNamedConf(source, { file, readInclude: readFile }));
      return loadZones ? checkZones(config, readFile) : { output: '', exitCode: 0 };
    } catch (error) {
      if (error instanceof NamedConfSyntaxError || error instanceof NamedConfigError) {
        return { output: error.message, exitCode: 1 };
      }
      throw error;
    }
  },
};
