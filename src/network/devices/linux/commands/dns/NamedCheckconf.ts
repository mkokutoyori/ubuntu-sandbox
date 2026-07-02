import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { parseNamedConf } from '../../bind9/NamedConfParser';
import { NamedConfSyntaxError } from '../../bind9/NamedConfLexer';
import { buildNamedConfig, NamedConfigError } from '../../bind9/NamedConfig';
import type { NamedConfig, NamedZone } from '../../bind9/NamedConfig';
import { parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';

const DEFAULT_CONF = '/etc/bind/named.conf';

function loadZoneLine(zone: NamedZone, readFile: (path: string) => string | null): string {
  const content = zone.file === null ? null : readFile(zone.file);
  if (content === null) {
    return `zone ${zone.name}/IN: loading from master file ${zone.file} failed: file not found`;
  }
  try {
    const parsed = parseZoneFile(content, zone.name);
    return `zone ${zone.name}/IN: loaded serial ${parsed.soa.data.serial}`;
  } catch (error) {
    if (error instanceof ZoneFileError) {
      return `zone ${zone.name}/IN: loading from master file ${zone.file} failed: ${error.message}`;
    }
    throw error;
  }
}

function checkZones(config: NamedConfig, readFile: (path: string) => string | null): string {
  const lines: string[] = [];
  for (const zone of config.zones) {
    if (zone.type !== 'primary' && zone.type !== 'hint') continue;
    lines.push(loadZoneLine(zone, readFile));
  }
  return lines.join('\n');
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
    let file = DEFAULT_CONF;
    let loadZones = false;
    for (const arg of args) {
      if (arg === '-z') loadZones = true;
      else if (!arg.startsWith('-')) file = arg;
    }

    const readFile = (path: string): string | null => ctx.executor.readFile(path);
    const source = readFile(file);
    if (source === null) {
      return `named-checkconf: open: ${file}: file not found`;
    }

    try {
      const config = buildNamedConfig(parseNamedConf(source, { file, readInclude: readFile }));
      return loadZones ? checkZones(config, readFile) : '';
    } catch (error) {
      if (error instanceof NamedConfSyntaxError || error instanceof NamedConfigError) {
        return error.message;
      }
      throw error;
    }
  },
};
