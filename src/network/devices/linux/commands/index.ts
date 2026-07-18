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
import { applyIptablesNatHook } from './net/IptablesNatHook';
import { namedCheckconfCommand } from './dns/NamedCheckconf';
import { namedCheckzoneCommand } from './dns/NamedCheckzone';
import { rndcCommand } from './dns/Rndc';
import { nmapCommand } from './net/Nmap';
import { curlCommand } from './net/Curl';
import { ssCommand } from './net/Ss';
import { ncCommand } from './net/Nc';
import { radtestCommand } from './net/Radtest';
import { tcpdumpCommand } from './net/Tcpdump';
import { arpingCommand } from './net/Arping';
import { netplanCommand } from './net/Netplan';
import { networkctlCommand } from './net/Networkctl';
import { nmcliCommand } from './net/Nmcli';
import { ifupCommand, ifdownCommand } from './net/Ifupdown';
import { nftCommand } from './net/Nft';
import { firewallCmdCommand } from './net/FirewallCmd';
import { fail2banClientCommand } from './net/Fail2banClient';
import { iptablesCommand } from './net/Iptables';
import { ip6tablesCommand } from './net/Ip6tables';
import { chageCommand } from './iam/Chage';
import { useraddCommand } from './iam/Useradd';
import { adduserCommand, addgroupCommand } from './iam/Adduser';
import { usermodCommand } from './iam/Usermod';
import { userdelCommand } from './iam/Userdel';
import { deluserCommand } from './iam/Deluser';
import { groupaddCommand, groupmodCommand, groupdelCommand } from './iam/Group';
import { faillockCommand } from './iam/Faillock';
import { passwdCommand } from './iam/Passwd';
import { lastlogCommand } from './iam/Lastlog';
import { pwckCommand } from './iam/Pwck';
import { grpckCommand } from './iam/Grpck';
import { visudoCommand } from './iam/Visudo';
import { ausearchCommand } from './audit/Ausearch';
import { aureportCommand } from './audit/Aureport';
import { auditctlCommand } from './audit/Auditctl';
import { logrotateCommand } from './system/Logrotate';
import { rebootCommand } from './system/Reboot';
import { dmesgCommand } from './system/Dmesg';
import { ufwCommand } from './system/Ufw';
import { chownCommand } from './fs/Chown';
import { chgrpCommand } from './fs/Chgrp';
import { mountCommand } from './fs/Mount';
import { umountCommand } from './fs/Umount';
import { mkfsCommand, mkfsExt4Command, mkfsXfsCommand, mkfsBtrfsCommand } from './fs/Mkfs';
import { lvdisplayCommand } from './fs/Lvm';
import { lspciCommand } from './hw/Lspci';
import { lsusbCommand } from './hw/Lsusb';
import { lscpuCommand } from './hw/Lscpu';
import { fdiskCommand } from './hw/Fdisk';
import { hdparmCommand } from './hw/Hdparm';
import { dmidecodeCommand } from './hw/Dmidecode';
import { lshwCommand } from './hw/Lshw';
import { hwinfoCommand } from './hw/Hwinfo';
import { blkidCommand } from './hw/Blkid';
import { partedCommand } from './hw/Parted';
import { lsblkCommand } from './hw/Lsblk';
import { hostnameCommand } from './system/Hostname';
import { archCommand } from './system/Arch';
import { dateCommand } from './system/Date';
import { uptimeCommand } from './system/Uptime';
import { unameCommand } from './system/Uname';
import { hostnamectlCommand } from './system/Hostnamectl';
import { timedatectlCommand } from './system/Timedatectl';
import { nprocCommand } from './system/Nproc';

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
  namedCheckzoneCommand,
  rndcCommand,
  dhclientCommand,
  readDhcpLeaseFile,
  isDhcpLeasePath,
  applyIptablesNatHook,
  nmapCommand,
  curlCommand,
  ssCommand,
  ncCommand,
  radtestCommand,
  tcpdumpCommand,
  arpingCommand,
  netplanCommand,
  networkctlCommand,
  nmcliCommand,
  ifupCommand,
  ifdownCommand,
  nftCommand,
  firewallCmdCommand,
  fail2banClientCommand,
  iptablesCommand,
  ip6tablesCommand,
  chageCommand,
  useraddCommand,
  adduserCommand,
  addgroupCommand,
  usermodCommand,
  userdelCommand,
  deluserCommand,
  groupaddCommand,
  groupmodCommand,
  groupdelCommand,
  faillockCommand,
  passwdCommand,
  lastlogCommand,
  pwckCommand,
  grpckCommand,
  visudoCommand,
  ausearchCommand,
  aureportCommand,
  auditctlCommand,
  logrotateCommand,
  rebootCommand,
  dmesgCommand,
  ufwCommand,
  chownCommand,
  chgrpCommand,
  mountCommand,
  umountCommand,
  mkfsCommand,
  mkfsExt4Command,
  mkfsXfsCommand,
  mkfsBtrfsCommand,
  lvdisplayCommand,
  lspciCommand,
  lsusbCommand,
  lscpuCommand,
  fdiskCommand,
  hdparmCommand,
  dmidecodeCommand,
  lshwCommand,
  hwinfoCommand,
  blkidCommand,
  partedCommand,
  lsblkCommand,
  hostnameCommand,
  archCommand,
  dateCommand,
  uptimeCommand,
  unameCommand,
  hostnamectlCommand,
  timedatectlCommand,
  nprocCommand,
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
  namedCheckzoneCommand,
  rndcCommand,
  dhclientCommand,
  nmapCommand,
  curlCommand,
  ssCommand,
  ncCommand,
  radtestCommand,
  tcpdumpCommand,
  arpingCommand,
  netplanCommand,
  networkctlCommand,
  nmcliCommand,
  ifupCommand,
  ifdownCommand,
  nftCommand,
  firewallCmdCommand,
  fail2banClientCommand,
  iptablesCommand,
  ip6tablesCommand,
  chageCommand,
  useraddCommand,
  adduserCommand,
  addgroupCommand,
  usermodCommand,
  userdelCommand,
  deluserCommand,
  groupaddCommand,
  groupmodCommand,
  groupdelCommand,
  faillockCommand,
  passwdCommand,
  lastlogCommand,
  pwckCommand,
  grpckCommand,
  visudoCommand,
  ausearchCommand,
  aureportCommand,
  auditctlCommand,
  logrotateCommand,
  rebootCommand,
  dmesgCommand,
  ufwCommand,
  chownCommand,
  chgrpCommand,
  mountCommand,
  umountCommand,
  mkfsCommand,
  mkfsExt4Command,
  mkfsXfsCommand,
  mkfsBtrfsCommand,
  lvdisplayCommand,
  lspciCommand,
  lsusbCommand,
  lscpuCommand,
  fdiskCommand,
  hdparmCommand,
  dmidecodeCommand,
  lshwCommand,
  hwinfoCommand,
  blkidCommand,
  partedCommand,
  lsblkCommand,
  hostnameCommand,
  archCommand,
  dateCommand,
  uptimeCommand,
  unameCommand,
  hostnamectlCommand,
  timedatectlCommand,
  nprocCommand,
];
