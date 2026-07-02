/**
 * Barrel file for the Linux command module.
 *
 * Re-exports the command interfaces and the registry so that callers only
 * ever need to import from `./commands`.
 *
 * The `CORE_LINUX_COMMANDS` array is intentionally empty for Phase 1 — it
 * will be populated during Phase 2 of the migration, as commands are
 * progressively extracted from `LinuxPC` into their own files under
 * `commands/net/`, `commands/dhcp/`, `commands/dns/`, etc.
 *
 * See `linux_gap.md` §8.5 and §9 (Phase 2).
 */

export type { LinuxCommand } from './LinuxCommand';
export type { LinuxCommandContext } from './LinuxCommandContext';
export { LinuxCommandRegistry } from './LinuxCommandRegistry';

import type { LinuxCommand } from './LinuxCommand';
import { sysctlCommand } from './net/Sysctl';
import { arpCommand } from './net/Arp';
import { ifconfigCommand } from './net/Ifconfig';
import { pingCommand, ping6Command } from './net/Ping';
import { tracerouteCommand } from './net/Traceroute';
import { routeCommand } from './net/Route';
import { digCommand } from './dns/Dig';
import { nslookupCommand } from './dns/Nslookup';
import { hostCommand } from './dns/Host';
import { dnsmasqCommand } from './dns/Dnsmasq';
import { ipCommand } from './net/Ip';
import { dhclientCommand } from './dhcp/Dhclient';
import { readDhcpLeaseFile, isDhcpLeasePath } from './dhcp/DhcpLeaseFile';
import { dhclientPsLines } from './dhcp/PsDhclientAugment';
import { applyIptablesNatHook } from './net/IptablesNatHook';
import { namedCheckconfCommand } from './dns/NamedCheckconf';
import { nmapCommand } from './net/Nmap';
import { curlCommand } from './net/Curl';
import { ssCommand } from './net/Ss';
import { ncCommand } from './net/Nc';

export {
  sysctlCommand,
  arpCommand,
  ifconfigCommand,
  pingCommand,
  ping6Command,
  tracerouteCommand,
  routeCommand,
  ipCommand,
  digCommand,
  nslookupCommand,
  hostCommand,
  dnsmasqCommand,
  namedCheckconfCommand,
  dhclientCommand,
  readDhcpLeaseFile,
  isDhcpLeasePath,
  dhclientPsLines,
  applyIptablesNatHook,
  nmapCommand,
  curlCommand,
  ssCommand,
  ncCommand,
};

/**
 * Core commands registered on every `LinuxMachine`.
 *
 * Populated progressively during Phase 2 as commands are extracted
 * from `LinuxPC` into their own files (see `linux_gap.md` §9).
 */
export const CORE_LINUX_COMMANDS: readonly LinuxCommand[] = [
  sysctlCommand,
  arpCommand,
  ifconfigCommand,
  pingCommand,
  ping6Command,
  tracerouteCommand,
  routeCommand,
  ipCommand,
  digCommand,
  nslookupCommand,
  hostCommand,
  dnsmasqCommand,
  namedCheckconfCommand,
  dhclientCommand,
  nmapCommand,
  curlCommand,
  ssCommand,
  ncCommand,
];
