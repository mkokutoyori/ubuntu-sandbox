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
import { ethtoolCommand } from './net/Ethtool';
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
import { scpCommand } from './net/Scp';
import { sftpCommand } from './net/Sftp';
import { opensslCommand } from './crypto/OpenSsl';
import { updateCaCertificatesCommand } from './crypto/UpdateCaCertificates';
import { nginxCommand } from './net/Nginx';
import { rsyslogdCommand } from './net/Rsyslogd';
import { apachectlCommand } from './net/Apachectl';
import { dhcpdCommand, dhcpLeaseListCommand } from './net/Dhcpd';
import {
  a2ensiteCommand, a2dissiteCommand, a2enmodCommand, a2dismodCommand,
} from './net/A2enmod';
import { ssCommand } from './net/Ss';
import { ncCommand } from './net/Nc';
import { tcCommand } from './net/Tc';
import { radtestCommand } from './net/Radtest';
import { tcpdumpCommand } from './net/Tcpdump';
import { arpingCommand } from './net/Arping';
import { netplanCommand } from './net/Netplan';
import { resolvectlCommand } from './net/Resolvectl';
import { getentCommand } from './nss/Getent';
import { networkctlCommand } from './net/Networkctl';
import { nmcliCommand } from './net/Nmcli';
import { ifupCommand, ifdownCommand } from './net/Ifupdown';
import { sshdCommand } from './net/Sshd';
import { xxdCommand } from './coreutils/Xxd';
import { TEXT_STREAM_COMMANDS } from './coreutils/TextStream';
import { bcCommand } from './coreutils/Bc';
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
import { chattrCommand, lsattrCommand } from './fs/Chattr';
import { truncateCommand } from './fs/Truncate';
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
import { chronycCommand } from './system/Chronyc';
import { ntpqCommand } from './net/Ntpq';
import { nsupdateCommand } from './net/Nsupdate';
import { ipsecCommand } from './net/Ipsec';
import { nprocCommand } from './system/Nproc';
import { anacronCommand } from './system/Anacron';
import { systemdAnalyzeCommand } from './system/SystemdAnalyze';
import { fuserCommand } from './system/Fuser';
import { aptCacheCommand } from './system/AptCache';
import { newgrpCommand } from './iam/Newgrp';
import { tracepathCommand } from './net/Tracepath';
import { mtrCommand } from './net/MtrReport';
import { conntrackCommand } from './net/Conntrack';
import { lldpcliCommand } from './net/Lldpcli';
import { treeCommand } from './coreutils/Tree';
import { calCommand } from './coreutils/Cal';
import { yesCommand } from './coreutils/Yes';
import { getconfCommand } from './system/Getconf';
import { lsbReleaseCommand } from './system/LsbRelease';
import { swaponCommand, swapoffCommand } from './system/Swapon';
import { lsmodCommand, modinfoCommand, modprobeCommand } from './system/Lsmod';
import { pmapCommand } from './system/Pmap';
import { sensorsCommand } from './hw/Sensors';
import { lognameCommand, usersCommand } from './iam/Logname';
import { lidCommand, membersCommand } from './iam/Lid';

export {
  sysctlCommand,
  arpCommand,
  ifconfigCommand,
  pingCommand,
  ping6Command,
  tracerouteCommand,
  ethtoolCommand,
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
  scpCommand,
  sftpCommand,
  opensslCommand,
  updateCaCertificatesCommand,
  nginxCommand,
  rsyslogdCommand,
  apachectlCommand,
  dhcpdCommand,
  dhcpLeaseListCommand,
  a2ensiteCommand,
  a2dissiteCommand,
  a2enmodCommand,
  a2dismodCommand,
  ssCommand,
  ncCommand,
  tcCommand,
  radtestCommand,
  tcpdumpCommand,
  arpingCommand,
  netplanCommand,
  networkctlCommand,
  resolvectlCommand,
  getentCommand,
  nmcliCommand,
  ifupCommand,
  ifdownCommand,
  sshdCommand,
  xxdCommand,
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
  chattrCommand,
  lsattrCommand,
  truncateCommand,
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
  chronycCommand,
  ntpqCommand,
  nsupdateCommand,
  ipsecCommand,
  nprocCommand,
  anacronCommand,
  systemdAnalyzeCommand,
  fuserCommand,
  aptCacheCommand,
  newgrpCommand,
  tracepathCommand,
  mtrCommand,
  conntrackCommand,
  lldpcliCommand,
  treeCommand,
  calCommand,
  yesCommand,
  getconfCommand,
  lsbReleaseCommand,
  swaponCommand,
  swapoffCommand,
  lsmodCommand,
  modprobeCommand,
  modinfoCommand,
  pmapCommand,
  sensorsCommand,
  lognameCommand,
  usersCommand,
  lidCommand,
  membersCommand,
  TEXT_STREAM_COMMANDS,
  bcCommand,
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
  ethtoolCommand,
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
  scpCommand,
  sftpCommand,
  opensslCommand,
  updateCaCertificatesCommand,
  nginxCommand,
  rsyslogdCommand,
  apachectlCommand,
  dhcpdCommand,
  dhcpLeaseListCommand,
  a2ensiteCommand,
  a2dissiteCommand,
  a2enmodCommand,
  a2dismodCommand,
  ssCommand,
  ncCommand,
  tcCommand,
  radtestCommand,
  tcpdumpCommand,
  arpingCommand,
  netplanCommand,
  networkctlCommand,
  resolvectlCommand,
  getentCommand,
  nmcliCommand,
  ifupCommand,
  ifdownCommand,
  sshdCommand,
  xxdCommand,
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
  chattrCommand,
  lsattrCommand,
  truncateCommand,
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
  chronycCommand,
  ntpqCommand,
  nsupdateCommand,
  ipsecCommand,
  nprocCommand,
  anacronCommand,
  systemdAnalyzeCommand,
  fuserCommand,
  aptCacheCommand,
  newgrpCommand,
  tracepathCommand,
  mtrCommand,
  conntrackCommand,
  lldpcliCommand,
  treeCommand,
  calCommand,
  yesCommand,
  getconfCommand,
  lsbReleaseCommand,
  swaponCommand,
  swapoffCommand,
  lsmodCommand,
  modprobeCommand,
  modinfoCommand,
  pmapCommand,
  sensorsCommand,
  lognameCommand,
  usersCommand,
  lidCommand,
  membersCommand,
  ...TEXT_STREAM_COMMANDS,
  bcCommand,
];
