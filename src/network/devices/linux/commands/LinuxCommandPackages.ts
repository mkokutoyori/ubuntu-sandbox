import { CORE_LINUX_COMMANDS } from './index';
import { STANDARD_BIN_PATHS } from '../service/CriticalFiles';

/**
 * Le paquet des commandes restees dans le `switch` de
 * `LinuxCommandExecutor`, qui n'ont pas d'objet `LinuxCommand` pour le
 * porter -- meme convention que les privileges. Une commande qui a un
 * objet le declare ELLE-MEME et ne figure donc pas ici : deux ecritures
 * d'un meme fait finiraient par se contredire.
 */
export const COMMAND_PACKAGES: Readonly<Record<string, string>> = {
  apache2: 'apache2', apachectl: 'apache2', apache2ctl: 'apache2',
  a2ensite: 'apache2', a2dissite: 'apache2', a2enmod: 'apache2', a2dismod: 'apache2',
  at: 'at', atq: 'at', atrm: 'at',
  auditctl: 'auditd', ausearch: 'auditd', aureport: 'auditd',
  bash: 'bash', sh: 'bash',
  named: 'bind9',
  chronyd: 'chrony', chronyc: 'chrony',
  echo: 'coreutils', cat: 'coreutils', ls: 'coreutils', cp: 'coreutils',
  mv: 'coreutils', rm: 'coreutils', touch: 'coreutils', mkdir: 'coreutils',
  rmdir: 'coreutils', ln: 'coreutils', chmod: 'coreutils', chown: 'coreutils',
  chgrp: 'coreutils', head: 'coreutils', tail: 'coreutils', sort: 'coreutils',
  uniq: 'coreutils', wc: 'coreutils', cut: 'coreutils', tr: 'coreutils',
  date: 'coreutils', uname: 'coreutils', hostname: 'coreutils', tee: 'coreutils',
  whoami: 'coreutils', logname: 'coreutils', users: 'coreutils', yes: 'coreutils',
  id: 'coreutils', groups: 'coreutils', pwd: 'coreutils', df: 'coreutils',
  du: 'coreutils', stat: 'coreutils', sleep: 'coreutils', seq: 'coreutils',
  nproc: 'coreutils', readlink: 'coreutils', dirname: 'coreutils',
  basename: 'coreutils', mktemp: 'coreutils', truncate: 'coreutils',
  md5sum: 'coreutils', sha256sum: 'coreutils', sha512sum: 'coreutils',
  sha1sum: 'coreutils', base64: 'coreutils', env: 'coreutils', nl: 'coreutils',
  split: 'coreutils', join: 'coreutils', paste: 'coreutils', comm: 'coreutils',
  fold: 'coreutils', expand: 'coreutils', unexpand: 'coreutils', tsort: 'coreutils',
  printf: 'coreutils', test: 'coreutils', true: 'coreutils', false: 'coreutils',
  crontab: 'cron',
  'run-parts': 'debianutils', which: 'debianutils', tempfile: 'debianutils',
  dig: 'dnsutils', nslookup: 'dnsutils', host: 'dnsutils', nsupdate: 'dnsutils',
  chattr: 'e2fsprogs', lsattr: 'e2fsprogs',
  find: 'findutils', xargs: 'findutils',
  awk: 'gawk',
  grep: 'grep', egrep: 'grep', fgrep: 'grep',
  gzip: 'gzip', gunzip: 'gzip', zcat: 'gzip',
  ip: 'iproute2', ss: 'iproute2', bridge: 'iproute2', tc: 'iproute2',
  iptables: 'iptables', ip6tables: 'iptables',
  'iptables-save': 'iptables', 'iptables-restore': 'iptables',
  ping: 'iputils-ping', ping6: 'iputils-ping', tracepath: 'iputils-ping',
  arping: 'iputils-ping',
  dhcpd: 'isc-dhcp-server', 'dhcp-lease-list': 'isc-dhcp-server',
  modinfo: 'kmod', modprobe: 'kmod', lsmod: 'kmod', rmmod: 'kmod', insmod: 'kmod',
  lldpd: 'lldpd', lldpcli: 'lldpd',
  lsof: 'lsof',
  cal: 'ncal', ncal: 'ncal',
  ifconfig: 'net-tools', netstat: 'net-tools', route: 'net-tools', arp: 'net-tools',
  ssh: 'openssh-client', scp: 'openssh-client', sftp: 'openssh-client',
  'ssh-keygen': 'openssh-client', 'ssh-keyscan': 'openssh-client',
  'ssh-copy-id': 'openssh-client',
  passwd: 'passwd', useradd: 'passwd', userdel: 'passwd', usermod: 'passwd',
  groupadd: 'passwd', groupdel: 'passwd', groupmod: 'passwd', chage: 'passwd',
  gpasswd: 'passwd', newgrp: 'passwd', chpasswd: 'passwd', vipw: 'passwd',
  ps: 'procps', kill: 'procps', free: 'procps', top: 'procps', sysctl: 'procps',
  pmap: 'procps', uptime: 'procps', pgrep: 'procps', pkill: 'procps',
  vmstat: 'procps', watch: 'procps', slabtop: 'procps', tload: 'procps',
  killall: 'psmisc', pstree: 'psmisc', fuser: 'psmisc',
  sed: 'sed',
  sudo: 'sudo', sudoedit: 'sudo', visudo: 'sudo',
  systemctl: 'systemd', journalctl: 'systemd', timedatectl: 'systemd',
  hostnamectl: 'systemd', loginctl: 'systemd', networkctl: 'systemd',
  resolvectl: 'systemd', 'systemd-analyze': 'systemd', udevadm: 'systemd',
  busctl: 'systemd',
  reboot: 'systemd-sysv', shutdown: 'systemd-sysv', service: 'systemd-sysv',
  poweroff: 'systemd-sysv', halt: 'systemd-sysv',
  sar: 'sysstat', iostat: 'sysstat', mpstat: 'sysstat', pidstat: 'sysstat',
  tar: 'tar',
  traceroute: 'traceroute', traceroute6: 'traceroute',
  su: 'util-linux', logger: 'util-linux', dmesg: 'util-linux',
  swapon: 'util-linux', swapoff: 'util-linux', getopt: 'util-linux',
  lsblk: 'util-linux', mount: 'util-linux', umount: 'util-linux',
  hexdump: 'util-linux', rev: 'util-linux', script: 'util-linux',
  lscpu: 'util-linux', dmidecode: 'util-linux', getconf: 'libc-bin',
  ldd: 'libc-bin', iconv: 'libc-bin', getent: 'libc-bin',
  vim: 'vim', vi: 'vim', vimdiff: 'vim',
  nano: 'nano',
  wget: 'wget',
  addgroup: 'adduser', adduser: 'adduser', deluser: 'adduser', delgroup: 'adduser',
  'apt-cache': 'apt', 'apt-get': 'apt', apt: 'apt', 'apt-mark': 'apt',
  arch: 'coreutils', cksum: 'coreutils', fmt: 'coreutils', pr: 'coreutils',
  tac: 'coreutils',
  blkid: 'util-linux', fdisk: 'util-linux', column: 'util-linux',
  cmp: 'diffutils', diff: 'diffutils',
  grpck: 'passwd', pwck: 'passwd', lastlog: 'passwd',
  ifdown: 'ifupdown', ifup: 'ifupdown',
  lvdisplay: 'lvm2', vgdisplay: 'lvm2', pvdisplay: 'lvm2',
  mkfs: 'util-linux', 'mkfs.ext4': 'e2fsprogs',
  'mkfs.xfs': 'xfsprogs', 'mkfs.btrfs': 'btrfs-progs',
  'named-checkconf': 'bind9', 'named-checkzone': 'bind9', rndc: 'bind9',
};
/**
 * Le paquet qui livre cette commande. La commande le déclare elle-même
 * quand elle est un `LinuxCommand`; sinon la table ci-dessus répond,
 * exactement comme les privilèges le font pour les commandes restées
 * dans le `switch` de `LinuxCommandExecutor`.
 */
export function packageOfCommand(name: string): string | undefined {
  const declared = CORE_LINUX_COMMANDS.find(
    c => c.name === name || c.aliases?.includes(name))?.package;
  return declared ?? COMMAND_PACKAGES[name];
}
/** Les commandes que ce paquet livre — lues, jamais recopiées. */
export function commandsOfPackage(pkg: string): string[] {
  const out = new Set<string>();
  for (const c of CORE_LINUX_COMMANDS) {
    if (c.package === pkg) out.add(c.name);
  }
  for (const [name, owner] of Object.entries(COMMAND_PACKAGES)) {
    if (owner === pkg) out.add(name);
  }
  return [...out].sort();
}
/** Les noms declares des DEUX cotes — la liste doit rester vide. */
export function doublyDeclaredCommands(): string[] {
  return CORE_LINUX_COMMANDS
    .filter(c => c.package !== undefined && COMMAND_PACKAGES[c.name] !== undefined)
    .map(c => c.name)
    .sort();
}

/** Les commandes que cette image livre vraiment, tous chemins confondus. */
export function shippedCommands(): string[] {
  const out = new Set<string>(Object.keys(STANDARD_BIN_PATHS));
  for (const c of CORE_LINUX_COMMANDS) out.add(c.name);
  return [...out].sort();
}
