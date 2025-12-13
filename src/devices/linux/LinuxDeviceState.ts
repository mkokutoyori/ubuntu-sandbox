/**
 * LinuxDeviceState - Isolated state for Linux devices
 * Each Linux device instance has its own file system, processes, services, etc.
 */

import {
  DeviceState,
  DeviceStateConfig,
  FileNode,
  FileType,
  FilePermissions,
  FileMetadata,
  User,
  Group,
  Process,
  ProcessState,
  Service,
  ServiceState,
  Package,
  NetworkInterface,
  Route,
  ARPEntry,
  DNSConfig,
  HostEntry,
  Environment,
  Job
} from '../common/DeviceState';

// ============================================================================
// LINUX SPECIFIC TYPES
// ============================================================================

export interface LinuxDeviceStateConfig extends DeviceStateConfig {
  distribution?: string;
  kernelVersion?: string;
  architecture?: string;
}

// ============================================================================
// LINUX DEVICE STATE IMPLEMENTATION
// ============================================================================

export class LinuxDeviceState extends DeviceState {
  private distribution: string;
  private kernelVersion: string;
  private architecture: string;

  constructor(config: LinuxDeviceStateConfig) {
    super({
      deviceId: config.deviceId,
      hostname: config.hostname,
      osType: 'linux'
    });
    this.distribution = config.distribution || 'Ubuntu 22.04 LTS';
    this.kernelVersion = config.kernelVersion || '5.15.0-generic';
    this.architecture = config.architecture || 'x86_64';
    // Initialize after setting derived class properties
    this.initialize();
  }

  // ============================================================================
  // FILE SYSTEM CREATION
  // ============================================================================

  protected createRootFileSystem(): FileNode {
    const root = this.createDirectoryNode('/');

    // Create standard Linux directory structure
    const dirs = [
      'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt',
      'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var'
    ];

    for (const dir of dirs) {
      root.children!.set(dir, this.createDirectoryNode(dir));
    }

    // Create subdirectories
    this.createSubdirectories(root);

    // Create configuration files
    this.createConfigFiles(root);

    // Create device files
    this.createDeviceFiles(root);

    // Create proc filesystem
    this.createProcFS(root);

    return root;
  }

  private createSubdirectories(root: FileNode): void {
    // /usr subdirectories
    const usr = root.children!.get('usr')!;
    for (const dir of ['bin', 'include', 'lib', 'lib64', 'local', 'sbin', 'share', 'src']) {
      usr.children!.set(dir, this.createDirectoryNode(dir));
    }
    const usrLocal = usr.children!.get('local')!;
    for (const dir of ['bin', 'etc', 'include', 'lib', 'sbin', 'share', 'src']) {
      usrLocal.children!.set(dir, this.createDirectoryNode(dir));
    }

    // /var subdirectories
    const varDir = root.children!.get('var')!;
    for (const dir of ['cache', 'lib', 'local', 'lock', 'log', 'mail', 'opt', 'run', 'spool', 'tmp', 'www']) {
      varDir.children!.set(dir, this.createDirectoryNode(dir));
    }
    const varLog = varDir.children!.get('log')!;
    varLog.children!.set('syslog', this.createFileNode('syslog', ''));
    varLog.children!.set('auth.log', this.createFileNode('auth.log', ''));
    varLog.children!.set('kern.log', this.createFileNode('kern.log', ''));
    varLog.children!.set('dmesg', this.createFileNode('dmesg', this.generateDmesg()));

    // /etc subdirectories
    const etc = root.children!.get('etc')!;
    for (const dir of ['apt', 'default', 'init.d', 'network', 'ssh', 'ssl', 'systemd', 'security', 'pam.d', 'cron.d']) {
      etc.children!.set(dir, this.createDirectoryNode(dir));
    }
    const sshDir = etc.children!.get('ssh')!;
    sshDir.children!.set('sshd_config', this.createFileNode('sshd_config', this.generateSSHDConfig()));

    // /home directory with default user
    const home = root.children!.get('home')!;
    const userHome = this.createDirectoryNode('user', 'user', 'user');
    home.children!.set('user', userHome);
    for (const dir of ['.ssh', '.config', 'Documents', 'Downloads', 'Desktop']) {
      userHome.children!.set(dir, this.createDirectoryNode(dir, 'user', 'user'));
    }
    userHome.children!.set('.bashrc', this.createFileNode('.bashrc', this.generateBashrc(), 'user', 'user'));
    userHome.children!.set('.profile', this.createFileNode('.profile', this.generateProfile(), 'user', 'user'));

    // /root directory
    const rootHome = root.children!.get('root')!;
    rootHome.children!.set('.bashrc', this.createFileNode('.bashrc', this.generateBashrc()));
    rootHome.children!.set('.profile', this.createFileNode('.profile', this.generateProfile()));

    // /tmp with world-writable permissions
    const tmp = root.children!.get('tmp')!;
    tmp.metadata.permissions = {
      owner: { read: true, write: true, execute: true },
      group: { read: true, write: true, execute: true },
      other: { read: true, write: true, execute: true },
      sticky: true
    };
  }

  private createConfigFiles(root: FileNode): void {
    const etc = root.children!.get('etc')!;

    // /etc/hostname
    etc.children!.set('hostname', this.createFileNode('hostname', this.hostname + '\n'));

    // /etc/hosts
    etc.children!.set('hosts', this.createFileNode('hosts', this.generateHostsFile()));

    // /etc/passwd
    etc.children!.set('passwd', this.createFileNode('passwd', this.generatePasswd()));

    // /etc/shadow (restricted)
    const shadow = this.createFileNode('shadow', this.generateShadow());
    shadow.metadata.permissions = { owner: { read: true, write: true, execute: false }, group: { read: false, write: false, execute: false }, other: { read: false, write: false, execute: false } };
    etc.children!.set('shadow', shadow);

    // /etc/group
    etc.children!.set('group', this.createFileNode('group', this.generateGroup()));

    // /etc/fstab
    etc.children!.set('fstab', this.createFileNode('fstab', this.generateFstab()));

    // /etc/resolv.conf
    etc.children!.set('resolv.conf', this.createFileNode('resolv.conf', '# Generated by NetworkManager\nnameserver 8.8.8.8\nnameserver 8.8.4.4\n'));

    // /etc/os-release
    etc.children!.set('os-release', this.createFileNode('os-release', this.generateOsRelease()));

    // /etc/lsb-release
    etc.children!.set('lsb-release', this.createFileNode('lsb-release', this.generateLsbRelease()));

    // /etc/motd
    etc.children!.set('motd', this.createFileNode('motd', this.generateMotd()));

    // /etc/issue
    etc.children!.set('issue', this.createFileNode('issue', `${this.distribution} \\n \\l\n\n`));

    // /etc/network/interfaces
    const network = etc.children!.get('network')!;
    network.children!.set('interfaces', this.createFileNode('interfaces', this.generateNetworkInterfaces()));

    // /etc/services
    etc.children!.set('services', this.createFileNode('services', this.generateServicesFile()));

    // /etc/protocols
    etc.children!.set('protocols', this.createFileNode('protocols', this.generateProtocolsFile()));

    // /etc/environment
    etc.children!.set('environment', this.createFileNode('environment', 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'));

    // /etc/shells
    etc.children!.set('shells', this.createFileNode('shells', '/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/dash\n'));

    // /etc/timezone
    etc.children!.set('timezone', this.createFileNode('timezone', 'UTC\n'));

    // /etc/localtime (symlink would be here)
    etc.children!.set('localtime', this.createFileNode('localtime', ''));

    // /etc/crontab
    etc.children!.set('crontab', this.createFileNode('crontab', this.generateCrontab()));
  }

  private createDeviceFiles(root: FileNode): void {
    const dev = root.children!.get('dev')!;

    // Standard device files
    const devices = [
      { name: 'null', major: 1, minor: 3, type: 'char' as const },
      { name: 'zero', major: 1, minor: 5, type: 'char' as const },
      { name: 'random', major: 1, minor: 8, type: 'char' as const },
      { name: 'urandom', major: 1, minor: 9, type: 'char' as const },
      { name: 'tty', major: 5, minor: 0, type: 'char' as const },
      { name: 'console', major: 5, minor: 1, type: 'char' as const },
      { name: 'sda', major: 8, minor: 0, type: 'block' as const },
      { name: 'sda1', major: 8, minor: 1, type: 'block' as const },
      { name: 'sda2', major: 8, minor: 2, type: 'block' as const },
    ];

    for (const device of devices) {
      const node: FileNode = {
        name: device.name,
        type: 'device',
        deviceType: device.type,
        major: device.major,
        minor: device.minor,
        metadata: this.createMetadata('device')
      };
      dev.children!.set(device.name, node);
    }

    // /dev/pts directory
    dev.children!.set('pts', this.createDirectoryNode('pts'));

    // /dev/shm directory
    dev.children!.set('shm', this.createDirectoryNode('shm'));
  }

  private createProcFS(root: FileNode): void {
    const proc = root.children!.get('proc')!;

    // /proc/version
    proc.children!.set('version', this.createFileNode('version',
      `Linux version ${this.kernelVersion} (gcc version 11.2.0) #1 SMP PREEMPT ${new Date().toUTCString()}\n`));

    // /proc/cpuinfo
    proc.children!.set('cpuinfo', this.createFileNode('cpuinfo', this.generateCpuinfo()));

    // /proc/meminfo
    proc.children!.set('meminfo', this.createFileNode('meminfo', this.generateMeminfo()));

    // /proc/uptime
    proc.children!.set('uptime', this.createFileNode('uptime', '0.00 0.00\n'));

    // /proc/loadavg
    proc.children!.set('loadavg', this.createFileNode('loadavg', '0.00 0.00 0.00 1/100 1\n'));

    // /proc/stat
    proc.children!.set('stat', this.createFileNode('stat', this.generateProcStat()));

    // /proc/filesystems
    proc.children!.set('filesystems', this.createFileNode('filesystems',
      'nodev\tsysfs\nnodev\ttmpfs\nnodev\tbdev\nnodev\tproc\nnodev\tcgroup\nnodev\tdevpts\n\text4\n'));

    // /proc/mounts
    proc.children!.set('mounts', this.createFileNode('mounts', this.generateMounts()));

    // /proc/net directory
    const net = this.createDirectoryNode('net');
    net.children!.set('dev', this.createFileNode('dev', this.generateNetDev()));
    net.children!.set('route', this.createFileNode('route', ''));
    net.children!.set('arp', this.createFileNode('arp', ''));
    net.children!.set('tcp', this.createFileNode('tcp', ''));
    net.children!.set('udp', this.createFileNode('udp', ''));
    proc.children!.set('net', net);

    // /proc/sys directory
    const sys = this.createDirectoryNode('sys');
    const kernel = this.createDirectoryNode('kernel');
    kernel.children!.set('hostname', this.createFileNode('hostname', this.hostname + '\n'));
    kernel.children!.set('osrelease', this.createFileNode('osrelease', this.kernelVersion + '\n'));
    kernel.children!.set('ostype', this.createFileNode('ostype', 'Linux\n'));
    sys.children!.set('kernel', kernel);

    const netSys = this.createDirectoryNode('net');
    const ipv4 = this.createDirectoryNode('ipv4');
    ipv4.children!.set('ip_forward', this.createFileNode('ip_forward', '0\n'));
    netSys.children!.set('ipv4', ipv4);
    sys.children!.set('net', netSys);

    proc.children!.set('sys', sys);
  }

  // ============================================================================
  // CONTENT GENERATORS
  // ============================================================================

  private generateHostsFile(): string {
    return `127.0.0.1\tlocalhost
127.0.1.1\t${this.hostname}

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
`;
  }

  private generatePasswd(): string {
    return `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
games:x:5:60:games:/usr/games:/usr/sbin/nologin
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin
mail:x:8:8:mail:/var/mail:/usr/sbin/nologin
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin
proxy:x:13:13:proxy:/bin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
backup:x:34:34:backup:/var/backups:/usr/sbin/nologin
list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin
irc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin
gnats:x:41:41:Gnats Bug-Reporting System (admin):/var/lib/gnats:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
systemd-network:x:100:102:systemd Network Management,,,:/run/systemd:/usr/sbin/nologin
systemd-resolve:x:101:103:systemd Resolver,,,:/run/systemd:/usr/sbin/nologin
messagebus:x:102:105::/nonexistent:/usr/sbin/nologin
sshd:x:103:65534::/run/sshd:/usr/sbin/nologin
user:x:1000:1000:User:/home/user:/bin/bash
`;
  }

  private generateShadow(): string {
    return `root:$6$rounds=4096$saltsalt$hashhash:19000:0:99999:7:::
daemon:*:19000:0:99999:7:::
bin:*:19000:0:99999:7:::
sys:*:19000:0:99999:7:::
user:$6$rounds=4096$saltsalt$hashhash:19000:0:99999:7:::
`;
  }

  private generateGroup(): string {
    return `root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:user
tty:x:5:
disk:x:6:
lp:x:7:
mail:x:8:
news:x:9:
uucp:x:10:
man:x:12:
proxy:x:13:
kmem:x:15:
dialout:x:20:
fax:x:21:
voice:x:22:
cdrom:x:24:user
floppy:x:25:
tape:x:26:
sudo:x:27:user
audio:x:29:user
dip:x:30:user
www-data:x:33:
backup:x:34:
operator:x:37:
list:x:38:
irc:x:39:
src:x:40:
gnats:x:41:
shadow:x:42:
utmp:x:43:
video:x:44:user
sasl:x:45:
plugdev:x:46:user
staff:x:50:
games:x:60:
users:x:100:
nogroup:x:65534:
netdev:x:101:
ssh:x:102:
user:x:1000:
`;
  }

  private generateFstab(): string {
    return `# /etc/fstab: static file system information.
#
# <file system> <mount point>   <type>  <options>       <dump>  <pass>
/dev/sda1       /               ext4    errors=remount-ro 0       1
/dev/sda2       none            swap    sw              0       0
proc            /proc           proc    defaults        0       0
sysfs           /sys            sysfs   defaults        0       0
tmpfs           /tmp            tmpfs   defaults        0       0
tmpfs           /run            tmpfs   defaults        0       0
`;
  }

  private generateOsRelease(): string {
    const id = this.distribution.split(' ')[0].toLowerCase();
    return `PRETTY_NAME="${this.distribution}"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=${id}
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=jammy
`;
  }

  private generateLsbRelease(): string {
    return `DISTRIB_ID=Ubuntu
DISTRIB_RELEASE=22.04
DISTRIB_CODENAME=jammy
DISTRIB_DESCRIPTION="${this.distribution}"
`;
  }

  private generateMotd(): string {
    return `Welcome to ${this.distribution} (${this.kernelVersion})

 * Documentation:  https://help.ubuntu.com
 * Management:     https://landscape.canonical.com
 * Support:        https://ubuntu.com/advantage

System information as of ${new Date().toUTCString()}

  System load:  0.0
  Usage of /:   15% of 50GB
  Memory usage: 25%
  Swap usage:   0%
  Processes:    100

`;
  }

  private generateBashrc(): string {
    return `# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# History settings
HISTCONTROL=ignoreboth
HISTSIZE=1000
HISTFILESIZE=2000
shopt -s histappend

# Check window size
shopt -s checkwinsize

# Make less more friendly
[ -x /usr/bin/lesspipe ] && eval "$(SHELL=/bin/sh lesspipe)"

# Set prompt
if [ "$color_prompt" = yes ]; then
    PS1='\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '
else
    PS1='\\u@\\h:\\w\\$ '
fi

# Aliases
alias ls='ls --color=auto'
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# Enable programmable completion
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
  fi
fi
`;
  }

  private generateProfile(): string {
    return `# ~/.profile: executed by the command interpreter for login shells.

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/.local/bin" ] ; then
    PATH="$HOME/.local/bin:$PATH"
fi
`;
  }

  private generateNetworkInterfaces(): string {
    return `# interfaces(5) file used by ifup(8) and ifdown(8)
# Include files from /etc/network/interfaces.d:
source-directory /etc/network/interfaces.d

auto lo
iface lo inet loopback
`;
  }

  private generateSSHDConfig(): string {
    return `# SSH Server Configuration
Port 22
Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key

# Logging
SyslogFacility AUTH
LogLevel INFO

# Authentication
LoginGraceTime 2m
PermitRootLogin prohibit-password
StrictModes yes
MaxAuthTries 6
MaxSessions 10
PubkeyAuthentication yes
PasswordAuthentication yes
PermitEmptyPasswords no
ChallengeResponseAuthentication no

# Other
UsePAM yes
X11Forwarding yes
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
`;
  }

  private generateServicesFile(): string {
    return `# Network services, Internet style
tcpmux          1/tcp                           # TCP port service multiplexer
echo            7/tcp
echo            7/udp
discard         9/tcp           sink null
discard         9/udp           sink null
systat          11/tcp          users
daytime         13/tcp
daytime         13/udp
netstat         15/tcp
qotd            17/tcp          quote
chargen         19/tcp          ttytst source
chargen         19/udp          ttytst source
ftp-data        20/tcp
ftp             21/tcp
fsp             21/udp          fspd
ssh             22/tcp                          # SSH Remote Login Protocol
telnet          23/tcp
smtp            25/tcp          mail
time            37/tcp          timserver
time            37/udp          timserver
whois           43/tcp          nicname
tacacs          49/tcp                          # Login Host Protocol (TACACS)
tacacs          49/udp
domain          53/tcp                          # Domain Name Server
domain          53/udp
bootps          67/udp
bootpc          68/udp
tftp            69/udp
http            80/tcp          www             # WorldWideWeb HTTP
kerberos        88/tcp          kerberos5 krb5 kerberos-sec
kerberos        88/udp          kerberos5 krb5 kerberos-sec
pop3            110/tcp         pop-3           # POP version 3
sunrpc          111/tcp         portmapper      # RPC 4.0 portmapper
sunrpc          111/udp         portmapper
auth            113/tcp         ident tap
nntp            119/tcp         readnews untp   # USENET News Transfer Protocol
ntp             123/udp                         # Network Time Protocol
imap2           143/tcp         imap            # Strstrategic Research Inst. International Message Access Protocol
snmp            161/udp                         # Simple Net Mgmt Protocol
snmp-trap       162/udp         snmptrap
bgp             179/tcp                         # Border Gateway Protocol
imap3           220/tcp                         # Interactive Mail Access Protocol v3
ldap            389/tcp                         # Lightweight Directory Access Protocol
ldap            389/udp
https           443/tcp                         # http protocol over TLS/SSL
microsoft-ds    445/tcp                         # Microsoft Naked CIFS
syslog          514/udp
printer         515/tcp         spooler         # line printer spooler
mysql           3306/tcp
postgresql      5432/tcp
`;
  }

  private generateProtocolsFile(): string {
    return `# Internet protocols
ip      0       IP              # internet protocol, pseudo protocol number
hopopt  0       HOPOPT          # hop-by-hop options for ipv6
icmp    1       ICMP            # internet control message protocol
igmp    2       IGMP            # internet group management protocol
ggp     3       GGP             # gateway-gateway protocol
ipencap 4       IP-ENCAP        # IP encapsulated in IP
st      5       ST              # ST datagram mode
tcp     6       TCP             # transmission control protocol
egp     8       EGP             # exterior gateway protocol
igp     9       IGP             # any private interior gateway
pup     12      PUP             # PARC universal packet protocol
udp     17      UDP             # user datagram protocol
hmp     20      HMP             # host monitoring protocol
xns-idp 22      XNS-IDP         # Xerox NS IDP
rdp     27      RDP             # reliable datagram protocol
iso-tp4 29      ISO-TP4         # ISO Transport Protocol Class 4
dccp    33      DCCP            # Datagram Congestion Control Protocol
xtp     36      XTP             # Xpress Transfer Protocol
ddp     37      DDP             # Datagram Delivery Protocol
idpr-cmtp 38    IDPR-CMTP       # IDPR Control Message Transport
ipv6    41      IPv6            # Internet Protocol, version 6
ipv6-route 43   IPv6-Route      # Routing Header for IPv6
ipv6-frag 44    IPv6-Frag       # Fragment Header for IPv6
idrp    45      IDRP            # Inter-Domain Routing Protocol
rsvp    46      RSVP            # Resource ReSerVation Protocol
gre     47      GRE             # General Routing Encapsulation
esp     50      ESP             # Encapsulating Security Payload
ah      51      AH              # Authentication Header
skip    57      SKIP            # SKIP
ipv6-icmp 58    IPv6-ICMP       # ICMP for IPv6
ipv6-nonxt 59   IPv6-NoNxt      # No Next Header for IPv6
ipv6-opts 60    IPv6-Opts       # Destination Options for IPv6
ospf    89      OSPFIGP         # Open Shortest Path First IGP
pim     103     PIM             # Protocol Independent Multicast
ipcomp  108     IPCOMP          # IP Payload Compression Protocol
vrrp    112     VRRP            # Virtual Router Redundancy Protocol
l2tp    115     L2TP            # Layer Two Tunneling Protocol
sctp    132     SCTP            # Stream Control Transmission Protocol
mobility-header 135 Mobility-Header # Mobility Header
udplite 136     UDPLite         # UDP-Lite
mpls-in-ip 137  MPLS-in-IP      # MPLS-in-IP
hip     139     HIP             # Host Identity Protocol
shim6   140     Shim6           # Shim6 Protocol
`;
  }

  private generateCrontab(): string {
    return `# /etc/crontab: system-wide crontab
# Unlike any other crontab you don't have to run the 'crontab'
# command to install the new version when you edit this file
# and files in /etc/cron.d. These files also have username fields,
# that none of the other crontabs do.

SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

# Example of job definition:
# .---------------- minute (0 - 59)
# |  .------------- hour (0 - 23)
# |  |  .---------- day of month (1 - 31)
# |  |  |  .------- month (1 - 12) OR jan,feb,mar,apr ...
# |  |  |  |  .---- day of week (0 - 6) (Sunday=0 or 7) OR sun,mon,tue,wed,thu,fri,sat
# |  |  |  |  |
# *  *  *  *  * user-name command to be executed
17 *    * * *   root    cd / && run-parts --report /etc/cron.hourly
25 6    * * *   root    test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )
47 6    * * 7   root    test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.weekly )
52 6    1 * *   root    test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.monthly )
`;
  }

  private generateDmesg(): string {
    const bootTime = this.bootTime.toISOString();
    return `[    0.000000] Linux version ${this.kernelVersion} (gcc version 11.2.0) #1 SMP PREEMPT
[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-${this.kernelVersion} root=/dev/sda1 ro quiet splash
[    0.000000] BIOS-provided physical RAM map:
[    0.000000] BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable
[    0.000000] Initializing cgroup subsys cpuset
[    0.000000] Initializing cgroup subsys cpu
[    0.000000] Initializing cgroup subsys cpuacct
[    0.000001] NX (Execute Disable) protection: active
[    0.000001] DMI: Virtual Machine
[    0.001000] CPU: Simulated x86_64 processor
[    0.002000] x86/fpu: Supporting XSAVE feature
[    0.010000] Booting paravirtualized kernel on KVM
[    0.100000] Memory: 4096MB available
[    0.200000] PCI: Using configuration type 1 for base access
[    0.300000] ACPI: Early table checksum verification disabled
[    0.400000] ACPI: RSDP 0x00000000000F0000 000024 (v02 VRTUAL)
[    0.500000] clocksource: refined-jiffies: mask: 0xffffffff max_cycles: 0xffffffff
[    0.600000] Console: colour VGA+ 80x25
[    0.700000] printk: console [tty0] enabled
[    1.000000] Freeing unused kernel memory: 2048K
[    1.100000] Write protecting the kernel read-only data: 18432k
[    1.200000] Freeing unused kernel memory: 2008K
[    1.300000] Freeing unused kernel memory: 1176K
[    1.400000] x86/mm: Checked W+X mappings: passed, no W+X pages found
[    1.500000] systemd[1]: Detected virtualization kvm.
[    1.600000] systemd[1]: Detected architecture x86-64.
[    1.700000] systemd[1]: Hostname set to <${this.hostname}>.
[    2.000000] Boot completed at ${bootTime}
`;
  }

  private generateCpuinfo(): string {
    return `processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
model\t\t: 158
model name\t: Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz
stepping\t: 10
microcode\t: 0xde
cpu MHz\t\t: 3200.000
cache size\t: 12288 KB
physical id\t: 0
siblings\t: 1
core id\t\t: 0
cpu cores\t: 1
apicid\t\t: 0
initial apicid\t: 0
fpu\t\t: yes
fpu_exception\t: yes
cpuid level\t: 22
wp\t\t: yes
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss syscall nx pdpe1gb rdtscp lm constant_tsc arch_perfmon nopl xtopology tsc_reliable nonstop_tsc cpuid pni pclmulqdq vmx ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch cpuid_fault invpcid_single pti ssbd ibrs ibpb stibp tpr_shadow vnmi ept vpid fsgsbase tsc_adjust bmi1 avx2 smep bmi2 invpcid rdseed adx smap clflushopt xsaveopt xsavec xsaves arat md_clear flush_l1d arch_capabilities
bugs\t\t: cpu_meltdown spectre_v1 spectre_v2 spec_store_bypass l1tf mds swapgs taa itlb_multihit
bogomips\t: 6400.00
clflush size\t: 64
cache_alignment\t: 64
address sizes\t: 45 bits physical, 48 bits virtual
power management:
`;
  }

  private generateMeminfo(): string {
    return `MemTotal:        4096000 kB
MemFree:         2048000 kB
MemAvailable:    3072000 kB
Buffers:          256000 kB
Cached:           512000 kB
SwapCached:            0 kB
Active:           768000 kB
Inactive:         256000 kB
Active(anon):     384000 kB
Inactive(anon):   128000 kB
Active(file):     384000 kB
Inactive(file):   128000 kB
Unevictable:           0 kB
Mlocked:               0 kB
SwapTotal:       2048000 kB
SwapFree:        2048000 kB
Dirty:                 0 kB
Writeback:             0 kB
AnonPages:        384000 kB
Mapped:           128000 kB
Shmem:             64000 kB
KReclaimable:     128000 kB
Slab:             192000 kB
SReclaimable:     128000 kB
SUnreclaim:        64000 kB
KernelStack:        8192 kB
PageTables:        16384 kB
NFS_Unstable:          0 kB
Bounce:                0 kB
WritebackTmp:          0 kB
CommitLimit:     4096000 kB
Committed_AS:     768000 kB
VmallocTotal:   34359738367 kB
VmallocUsed:       32768 kB
VmallocChunk:          0 kB
HugePages_Total:       0
HugePages_Free:        0
HugePages_Rsvd:        0
HugePages_Surp:        0
Hugepagesize:       2048 kB
DirectMap4k:       65536 kB
DirectMap2M:     4128768 kB
`;
  }

  private generateProcStat(): string {
    return `cpu  10000 0 5000 100000 1000 0 500 0 0 0
cpu0 10000 0 5000 100000 1000 0 500 0 0 0
intr 1000000 50 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
ctxt 500000
btime ${Math.floor(this.bootTime.getTime() / 1000)}
processes 1000
procs_running 1
procs_blocked 0
softirq 200000 0 50000 0 0 0 0 50000 0 0 100000
`;
  }

  private generateMounts(): string {
    return `/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
devtmpfs /dev devtmpfs rw,nosuid,relatime,size=2048000k,nr_inodes=512000,mode=755 0 0
tmpfs /run tmpfs rw,nosuid,nodev,mode=755 0 0
tmpfs /tmp tmpfs rw,nosuid,nodev 0 0
devpts /dev/pts devpts rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000 0 0
`;
  }

  private generateNetDev(): string {
    let output = 'Inter-|   Receive                                                |  Transmit\n';
    output += ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
    output += '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n';
    return output;
  }

  // ============================================================================
  // ENVIRONMENT CREATION
  // ============================================================================

  protected createDefaultEnvironment(): Environment {
    return {
      variables: new Map([
        ['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
        ['HOME', '/home/user'],
        ['USER', 'user'],
        ['LOGNAME', 'user'],
        ['SHELL', '/bin/bash'],
        ['TERM', 'xterm-256color'],
        ['LANG', 'en_US.UTF-8'],
        ['LC_ALL', 'en_US.UTF-8'],
        ['PWD', '/home/user'],
        ['HOSTNAME', this.hostname],
        ['PS1', '\\u@\\h:\\w\\$ '],
        ['EDITOR', 'nano'],
        ['VISUAL', 'nano'],
        ['PAGER', 'less'],
      ]),
      aliases: new Map([
        ['ls', 'ls --color=auto'],
        ['ll', 'ls -alF'],
        ['la', 'ls -A'],
        ['l', 'ls -CF'],
        ['grep', 'grep --color=auto'],
        ['fgrep', 'fgrep --color=auto'],
        ['egrep', 'egrep --color=auto'],
      ]),
      path: ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
      workingDirectory: '/home/user',
      user: 'user',
      hostname: this.hostname,
      shell: '/bin/bash',
      term: 'xterm-256color',
      lang: 'en_US.UTF-8',
      tz: 'UTC',
      history: [],
      historyIndex: -1
    };
  }

  // ============================================================================
  // SYSTEM INITIALIZATION
  // ============================================================================

  protected initializeSystem(): void {
    // Initialize users
    this.initializeUsers();

    // Initialize groups
    this.initializeGroups();

    // Initialize default services
    this.initializeServices();

    // Initialize default packages
    this.initializePackages();

    // Initialize network interfaces
    this.initializeNetworkInterfaces();

    // Initialize default processes
    this.initializeProcesses();
  }

  private initializeUsers(): void {
    const defaultUsers: User[] = [
      { uid: 0, gid: 0, username: 'root', home: '/root', shell: '/bin/bash', groups: ['root'], fullName: 'root' },
      { uid: 1, gid: 1, username: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin', groups: ['daemon'], fullName: 'daemon' },
      { uid: 65534, gid: 65534, username: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin', groups: ['nogroup'], fullName: 'nobody' },
      { uid: 33, gid: 33, username: 'www-data', home: '/var/www', shell: '/usr/sbin/nologin', groups: ['www-data'], fullName: 'www-data' },
      { uid: 103, gid: 65534, username: 'sshd', home: '/run/sshd', shell: '/usr/sbin/nologin', groups: [], fullName: 'sshd' },
      { uid: 1000, gid: 1000, username: 'user', home: '/home/user', shell: '/bin/bash', groups: ['user', 'sudo', 'adm', 'cdrom', 'dip', 'plugdev'], fullName: 'User' },
    ];

    for (const user of defaultUsers) {
      this.users.set(user.username, user);
    }
  }

  private initializeGroups(): void {
    const defaultGroups: Group[] = [
      { gid: 0, name: 'root', members: ['root'] },
      { gid: 1, name: 'daemon', members: ['daemon'] },
      { gid: 27, name: 'sudo', members: ['user'] },
      { gid: 4, name: 'adm', members: ['user'] },
      { gid: 24, name: 'cdrom', members: ['user'] },
      { gid: 30, name: 'dip', members: ['user'] },
      { gid: 46, name: 'plugdev', members: ['user'] },
      { gid: 33, name: 'www-data', members: ['www-data'] },
      { gid: 65534, name: 'nogroup', members: ['nobody'] },
      { gid: 1000, name: 'user', members: ['user'] },
    ];

    for (const group of defaultGroups) {
      this.groups.set(group.name, group);
    }
  }

  private initializeServices(): void {
    const defaultServices: Service[] = [
      {
        name: 'ssh',
        displayName: 'OpenSSH Server',
        description: 'OpenBSD Secure Shell server',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['network.target'],
        user: 'root',
        group: 'root',
        execStart: '/usr/sbin/sshd -D',
        restartPolicy: 'on-failure',
        ports: [22],
        logs: []
      },
      {
        name: 'cron',
        displayName: 'Regular background program processing daemon',
        description: 'Daemon to execute scheduled commands',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: [],
        user: 'root',
        group: 'root',
        execStart: '/usr/sbin/cron -f',
        restartPolicy: 'on-failure',
        logs: []
      },
      {
        name: 'rsyslog',
        displayName: 'System Logging Service',
        description: 'Fast system logging daemon',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: [],
        user: 'root',
        group: 'root',
        execStart: '/usr/sbin/rsyslogd -n',
        restartPolicy: 'on-failure',
        logs: []
      },
      {
        name: 'networkd',
        displayName: 'Network Service',
        description: 'Network Management Service',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: [],
        user: 'root',
        group: 'root',
        execStart: '/lib/systemd/systemd-networkd',
        restartPolicy: 'on-failure',
        logs: []
      },
    ];

    for (const service of defaultServices) {
      this.services.set(service.name, service);
    }
  }

  private initializePackages(): void {
    const defaultPackages: Package[] = [
      { name: 'bash', version: '5.1-6ubuntu1', description: 'GNU Bourne Again SHell', installed: true, size: 1800000, dependencies: [], provides: ['/bin/bash'], architecture: 'amd64' },
      { name: 'coreutils', version: '8.32-4.1ubuntu1', description: 'GNU core utilities', installed: true, size: 7000000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'grep', version: '3.7-1build1', description: 'GNU grep, egrep and fgrep', installed: true, size: 900000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'sed', version: '4.8-1ubuntu2', description: 'GNU stream editor', installed: true, size: 400000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'gawk', version: '5.1.0-1build3', description: 'GNU awk', installed: true, size: 2500000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'findutils', version: '4.8.0-1ubuntu3', description: 'utilities for finding files', installed: true, size: 800000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'tar', version: '1.34+dfsg-1build3', description: 'GNU tar archiving utility', installed: true, size: 900000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'gzip', version: '1.10-4ubuntu4', description: 'GNU compression utilities', installed: true, size: 200000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'openssh-server', version: '8.9p1-3', description: 'secure shell (SSH) server', installed: true, size: 500000, dependencies: ['openssh-client'], provides: [], architecture: 'amd64' },
      { name: 'openssh-client', version: '8.9p1-3', description: 'secure shell (SSH) client', installed: true, size: 1500000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'net-tools', version: '1.60+git20181103.0eebece-1ubuntu5', description: 'NET-3 networking toolkit', installed: true, size: 800000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'iproute2', version: '5.15.0-1ubuntu2', description: 'networking and traffic control tools', installed: true, size: 3000000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'iputils-ping', version: '3:20211215-1', description: 'Tools to test the reachability of network hosts', installed: true, size: 100000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'vim', version: '8.2.3995-1ubuntu2', description: 'Vi IMproved - enhanced vi editor', installed: true, size: 3500000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'nano', version: '6.2-1', description: 'small, friendly text editor', installed: true, size: 800000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'curl', version: '7.81.0-1ubuntu1.6', description: 'command line tool for transferring data', installed: true, size: 500000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'wget', version: '1.21.2-2ubuntu1', description: 'retrieves files from the web', installed: true, size: 400000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'python3', version: '3.10.4-0ubuntu2', description: 'interactive high-level object-oriented language', installed: true, size: 800000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'sudo', version: '1.9.9-1ubuntu2', description: 'Provide limited super user privileges', installed: true, size: 2500000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'systemd', version: '249.11-0ubuntu3', description: 'system and service manager', installed: true, size: 15000000, dependencies: [], provides: [], architecture: 'amd64' },
    ];

    for (const pkg of defaultPackages) {
      pkg.installedDate = this.bootTime;
      this.packages.set(pkg.name, pkg);
    }
  }

  private initializeNetworkInterfaces(): void {
    // Loopback interface
    this.interfaces.set('lo', {
      id: `${this.deviceId}-lo`,
      name: 'lo',
      type: 'loopback',
      macAddress: '00:00:00:00:00:00',
      ipAddress: '127.0.0.1',
      netmask: '255.0.0.0',
      isUp: true,
      isAdminUp: true,
      mtu: 65536,
      rxBytes: 0,
      txBytes: 0,
      rxPackets: 0,
      txPackets: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDropped: 0,
      txDropped: 0
    });

    // Add loopback route
    this.routes.push({
      destination: '127.0.0.0',
      netmask: '255.0.0.0',
      gateway: '0.0.0.0',
      interface: 'lo',
      metric: 0,
      flags: ['U', 'H'],
      protocol: 'kernel'
    });

    // Add localhost to hosts
    this.hosts.push({ ip: '127.0.0.1', hostnames: ['localhost', 'localhost.localdomain'] });
    this.hosts.push({ ip: '127.0.1.1', hostnames: [this.hostname] });
  }

  private initializeProcesses(): void {
    // Init process (PID 1)
    this.processes.set(1, {
      pid: 1,
      ppid: 0,
      uid: 0,
      gid: 0,
      command: '/sbin/init',
      args: [],
      state: 'sleeping',
      priority: 20,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 10240000,
      workingDirectory: '/',
      environment: new Map(),
      threads: 1
    });

    // Kernel threads
    const kernelThreads = [
      { pid: 2, name: '[kthreadd]' },
      { pid: 3, name: '[rcu_gp]' },
      { pid: 4, name: '[rcu_par_gp]' },
      { pid: 5, name: '[kworker/0:0]' },
      { pid: 6, name: '[mm_percpu_wq]' },
    ];

    for (const thread of kernelThreads) {
      this.processes.set(thread.pid, {
        pid: thread.pid,
        ppid: 2,
        uid: 0,
        gid: 0,
        command: thread.name,
        args: [],
        state: 'sleeping',
        priority: 20,
        nice: 0,
        startTime: this.bootTime,
        cpuTime: 0,
        memory: 0,
        workingDirectory: '/',
        environment: new Map(),
        threads: 1
      });
    }

    this.pidCounter = 100;
  }

  // ============================================================================
  // FILE SYSTEM OPERATIONS
  // ============================================================================

  resolvePath(path: string): string {
    if (!path || path === '') return this.environment.workingDirectory;

    // Handle home directory
    if (path.startsWith('~')) {
      const user = this.users.get(this.environment.user);
      const home = user?.home || '/home/' + this.environment.user;
      path = home + path.slice(1);
    }

    // Handle relative paths
    if (!path.startsWith('/')) {
      path = this.environment.workingDirectory + '/' + path;
    }

    // Normalize path (resolve . and ..)
    const parts = path.split('/').filter(p => p !== '' && p !== '.');
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return '/' + resolved.join('/');
  }

  getNode(path: string): FileNode | null {
    const resolvedPath = this.resolvePath(path);
    if (resolvedPath === '/') return this.root;

    const parts = resolvedPath.split('/').filter(p => p !== '');
    let current = this.root;

    for (const part of parts) {
      if (current.type !== 'directory' || !current.children) {
        return null;
      }
      const child = current.children.get(part);
      if (!child) return null;

      // Follow symlinks
      if (child.type === 'symlink' && child.target) {
        const target = this.getNode(child.target);
        if (!target) return null;
        current = target;
      } else {
        current = child;
      }
    }

    return current;
  }

  createFile(path: string, content: string = '', permissions?: Partial<FilePermissions>): boolean {
    const resolvedPath = this.resolvePath(path);
    const parentPath = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';
    const fileName = resolvedPath.substring(resolvedPath.lastIndexOf('/') + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    const newFile = this.createFileNode(fileName, content, this.environment.user, this.environment.user);
    if (permissions) {
      newFile.metadata.permissions = { ...newFile.metadata.permissions, ...permissions };
    }

    parent.children!.set(fileName, newFile);
    return true;
  }

  createDirectory(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    const parts = resolvedPath.split('/').filter(p => p !== '');
    let current = this.root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (!current.children!.has(part)) {
        if (!recursive && i < parts.length - 1) return false;

        const newDir = this.createDirectoryNode(part, this.environment.user, this.environment.user);
        current.children!.set(part, newDir);
      }

      const next = current.children!.get(part)!;
      if (next.type !== 'directory') return false;
      current = next;
    }

    return true;
  }

  deleteNode(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    if (resolvedPath === '/') return false; // Can't delete root

    const parentPath = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';
    const nodeName = resolvedPath.substring(resolvedPath.lastIndexOf('/') + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    const node = parent.children!.get(nodeName);
    if (!node) return false;

    if (node.type === 'directory' && node.children!.size > 0 && !recursive) {
      return false;
    }

    parent.children!.delete(nodeName);
    return true;
  }

  readFile(path: string): string | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'file') return null;

    node.metadata.accessed = new Date();
    return node.content || '';
  }

  writeFile(path: string, content: string, append: boolean = false): boolean {
    let node = this.getNode(path);

    if (!node) {
      // Create the file
      if (!this.createFile(path, content)) return false;
      return true;
    }

    if (node.type !== 'file') return false;

    if (append) {
      node.content = (node.content || '') + content;
    } else {
      node.content = content;
    }

    node.metadata.modified = new Date();
    node.metadata.size = node.content.length;
    return true;
  }

  listDirectory(path: string): FileNode[] | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'directory') return null;

    node.metadata.accessed = new Date();
    return Array.from(node.children!.values());
  }

  exists(path: string): boolean {
    return this.getNode(path) !== null;
  }

  isDirectory(path: string): boolean {
    const node = this.getNode(path);
    return node !== null && node.type === 'directory';
  }

  isFile(path: string): boolean {
    const node = this.getNode(path);
    return node !== null && node.type === 'file';
  }

  copyNode(source: string, destination: string): boolean {
    const srcNode = this.getNode(source);
    if (!srcNode) return false;

    if (srcNode.type === 'file') {
      return this.createFile(destination, srcNode.content || '');
    } else if (srcNode.type === 'directory') {
      if (!this.createDirectory(destination)) return false;

      for (const [name, child] of srcNode.children!) {
        if (!this.copyNode(source + '/' + name, destination + '/' + name)) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  moveNode(source: string, destination: string): boolean {
    if (!this.copyNode(source, destination)) return false;
    return this.deleteNode(source, true);
  }

  chmod(path: string, permissions: FilePermissions): boolean {
    const node = this.getNode(path);
    if (!node) return false;

    node.metadata.permissions = permissions;
    return true;
  }

  chown(path: string, owner: string, group?: string): boolean {
    const node = this.getNode(path);
    if (!node) return false;

    if (!this.users.has(owner)) return false;
    if (group && !this.groups.has(group)) return false;

    node.metadata.owner = owner;
    if (group) node.metadata.group = group;
    return true;
  }

  // ============================================================================
  // USER MANAGEMENT
  // ============================================================================

  addUser(user: User): boolean {
    if (this.users.has(user.username)) return false;
    this.users.set(user.username, user);

    // Create home directory
    if (user.home && !this.exists(user.home)) {
      this.createDirectory(user.home, true);
      const homeNode = this.getNode(user.home);
      if (homeNode) {
        homeNode.metadata.owner = user.username;
        homeNode.metadata.group = user.username;
      }
    }

    return true;
  }

  removeUser(username: string): boolean {
    if (!this.users.has(username)) return false;
    this.users.delete(username);
    return true;
  }

  getUser(username: string): User | null {
    return this.users.get(username) || null;
  }

  getUserByUid(uid: number): User | null {
    for (const user of this.users.values()) {
      if (user.uid === uid) return user;
    }
    return null;
  }

  addGroup(group: Group): boolean {
    if (this.groups.has(group.name)) return false;
    this.groups.set(group.name, group);
    return true;
  }

  removeGroup(name: string): boolean {
    if (!this.groups.has(name)) return false;
    this.groups.delete(name);
    return true;
  }

  getGroup(name: string): Group | null {
    return this.groups.get(name) || null;
  }

  addUserToGroup(username: string, groupName: string): boolean {
    const group = this.groups.get(groupName);
    if (!group) return false;
    if (!this.users.has(username)) return false;

    if (!group.members.includes(username)) {
      group.members.push(username);
    }
    return true;
  }

  removeUserFromGroup(username: string, groupName: string): boolean {
    const group = this.groups.get(groupName);
    if (!group) return false;

    const index = group.members.indexOf(username);
    if (index === -1) return false;

    group.members.splice(index, 1);
    return true;
  }

  // ============================================================================
  // PROCESS MANAGEMENT
  // ============================================================================

  createProcess(command: string, args: string[], options?: Partial<Process>): number {
    const pid = this.pidCounter++;
    const process: Process = {
      pid,
      ppid: options?.ppid ?? 1,
      uid: options?.uid ?? this.users.get(this.environment.user)?.uid ?? 1000,
      gid: options?.gid ?? this.users.get(this.environment.user)?.gid ?? 1000,
      command,
      args,
      state: options?.state ?? 'running',
      priority: options?.priority ?? 20,
      nice: options?.nice ?? 0,
      startTime: new Date(),
      cpuTime: 0,
      memory: options?.memory ?? 1024000,
      workingDirectory: options?.workingDirectory ?? this.environment.workingDirectory,
      environment: options?.environment ?? new Map(this.environment.variables),
      tty: options?.tty,
      threads: options?.threads ?? 1
    };

    this.processes.set(pid, process);
    return pid;
  }

  killProcess(pid: number, signal: number = 15): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;

    if (signal === 9) {
      // SIGKILL - immediate termination
      this.processes.delete(pid);
    } else {
      // Other signals - set to zombie state first
      process.state = 'zombie';
      setTimeout(() => this.processes.delete(pid), 100);
    }

    return true;
  }

  getProcess(pid: number): Process | null {
    return this.processes.get(pid) || null;
  }

  getProcessByName(name: string): Process[] {
    const result: Process[] = [];
    for (const process of this.processes.values()) {
      if (process.command.includes(name)) {
        result.push(process);
      }
    }
    return result;
  }

  listProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  updateProcess(pid: number, updates: Partial<Process>): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;

    Object.assign(process, updates);
    return true;
  }

  // ============================================================================
  // SERVICE MANAGEMENT
  // ============================================================================

  registerService(service: Service): boolean {
    if (this.services.has(service.name)) return false;
    this.services.set(service.name, service);
    return true;
  }

  unregisterService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    if (service.state === 'running') this.stopService(name);
    this.services.delete(name);
    return true;
  }

  startService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    if (service.state === 'running') return true;

    service.state = 'starting';

    // Check dependencies
    for (const dep of service.dependencies) {
      const depService = this.services.get(dep.replace('.target', ''));
      if (depService && depService.state !== 'running') {
        this.startService(dep.replace('.target', ''));
      }
    }

    // Create process for service
    const pid = this.createProcess(service.execStart, [], {
      uid: this.users.get(service.user)?.uid ?? 0,
      gid: this.groups.get(service.group)?.gid ?? 0,
      workingDirectory: '/'
    });

    service.pid = pid;
    service.state = 'running';
    service.logs.push(`[${new Date().toISOString()}] Started ${service.displayName}`);

    return true;
  }

  stopService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    if (service.state === 'stopped') return true;

    service.state = 'stopping';

    if (service.pid) {
      this.killProcess(service.pid);
      service.pid = undefined;
    }

    service.state = 'stopped';
    service.logs.push(`[${new Date().toISOString()}] Stopped ${service.displayName}`);

    return true;
  }

  restartService(name: string): boolean {
    this.stopService(name);
    return this.startService(name);
  }

  enableService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.enabled = true;
    return true;
  }

  disableService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.enabled = false;
    return true;
  }

  getService(name: string): Service | null {
    return this.services.get(name) || null;
  }

  listServices(): Service[] {
    return Array.from(this.services.values());
  }

  // ============================================================================
  // PACKAGE MANAGEMENT
  // ============================================================================

  installPackage(pkg: Package): boolean {
    if (this.packages.has(pkg.name) && this.packages.get(pkg.name)!.installed) {
      return false;
    }

    pkg.installed = true;
    pkg.installedDate = new Date();
    this.packages.set(pkg.name, pkg);
    return true;
  }

  removePackage(name: string): boolean {
    const pkg = this.packages.get(name);
    if (!pkg || !pkg.installed) return false;

    pkg.installed = false;
    pkg.installedDate = undefined;
    return true;
  }

  getPackage(name: string): Package | null {
    return this.packages.get(name) || null;
  }

  listPackages(installed?: boolean): Package[] {
    const result: Package[] = [];
    for (const pkg of this.packages.values()) {
      if (installed === undefined || pkg.installed === installed) {
        result.push(pkg);
      }
    }
    return result;
  }

  updatePackage(name: string): boolean {
    const pkg = this.packages.get(name);
    if (!pkg || !pkg.installed) return false;
    // In a real implementation, this would fetch and install a newer version
    return true;
  }

  // ============================================================================
  // NETWORK CONFIGURATION
  // ============================================================================

  configureInterface(name: string, config: Partial<NetworkInterface>): boolean {
    let iface = this.interfaces.get(name);

    if (!iface) {
      // Create new interface
      iface = {
        id: `${this.deviceId}-${name}`,
        name,
        type: config.type || 'ethernet',
        macAddress: config.macAddress || this.generateMAC(),
        isUp: false,
        isAdminUp: false,
        mtu: 1500,
        rxBytes: 0,
        txBytes: 0,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        rxDropped: 0,
        txDropped: 0
      };
      this.interfaces.set(name, iface);
    }

    Object.assign(iface, config);

    // Add connected route if IP is configured
    if (config.ipAddress && config.netmask) {
      this.addConnectedRoute(name, config.ipAddress, config.netmask);
    }

    return true;
  }

  private addConnectedRoute(interfaceName: string, ipAddress: string, netmask: string): void {
    // Calculate network address
    const ipParts = ipAddress.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    const networkParts = ipParts.map((ip, i) => ip & maskParts[i]);
    const network = networkParts.join('.');

    // Remove existing connected route for this interface
    this.routes = this.routes.filter(r =>
      !(r.interface === interfaceName && r.protocol === 'connected')
    );

    // Add new connected route
    this.routes.push({
      destination: network,
      netmask,
      gateway: '0.0.0.0',
      interface: interfaceName,
      metric: 0,
      flags: ['U'],
      protocol: 'connected'
    });
  }

  getInterface(name: string): NetworkInterface | null {
    return this.interfaces.get(name) || null;
  }

  listInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaces.values());
  }

  addRoute(route: Route): boolean {
    // Check if route already exists
    const exists = this.routes.some(r =>
      r.destination === route.destination && r.netmask === route.netmask
    );
    if (exists) return false;

    this.routes.push(route);
    return true;
  }

  removeRoute(destination: string, netmask: string): boolean {
    const index = this.routes.findIndex(r =>
      r.destination === destination && r.netmask === netmask
    );
    if (index === -1) return false;

    this.routes.splice(index, 1);
    return true;
  }

  getRoutes(): Route[] {
    return [...this.routes];
  }

  addARPEntry(entry: ARPEntry): void {
    this.arpTable.set(entry.ipAddress, entry);
  }

  removeARPEntry(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  getARPTable(): ARPEntry[] {
    return Array.from(this.arpTable.values());
  }

  setDNS(config: Partial<DNSConfig>): void {
    Object.assign(this.dnsConfig, config);

    // Update resolv.conf
    let content = '# Generated by NetworkManager\n';
    for (const ns of this.dnsConfig.nameservers) {
      content += `nameserver ${ns}\n`;
    }
    if (this.dnsConfig.searchDomains.length > 0) {
      content += `search ${this.dnsConfig.searchDomains.join(' ')}\n`;
    }
    this.writeFile('/etc/resolv.conf', content);
  }

  getDNS(): DNSConfig {
    return { ...this.dnsConfig };
  }

  addHost(entry: HostEntry): void {
    this.hosts.push(entry);
    this.updateHostsFile();
  }

  removeHost(ip: string): boolean {
    const index = this.hosts.findIndex(h => h.ip === ip);
    if (index === -1) return false;
    this.hosts.splice(index, 1);
    this.updateHostsFile();
    return true;
  }

  getHosts(): HostEntry[] {
    return [...this.hosts];
  }

  resolveHostname(hostname: string): string | null {
    for (const entry of this.hosts) {
      if (entry.hostnames.includes(hostname)) {
        return entry.ip;
      }
    }
    return null;
  }

  private updateHostsFile(): void {
    let content = '# /etc/hosts\n';
    for (const entry of this.hosts) {
      content += `${entry.ip}\t${entry.hostnames.join(' ')}\n`;
    }
    this.writeFile('/etc/hosts', content);
  }

  // ============================================================================
  // ENVIRONMENT
  // ============================================================================

  getEnv(name: string): string | undefined {
    return this.environment.variables.get(name);
  }

  setEnv(name: string, value: string): void {
    this.environment.variables.set(name, value);
  }

  unsetEnv(name: string): void {
    this.environment.variables.delete(name);
  }

  getWorkingDirectory(): string {
    return this.environment.workingDirectory;
  }

  setWorkingDirectory(path: string): boolean {
    const resolved = this.resolvePath(path);
    const node = this.getNode(resolved);
    if (!node || node.type !== 'directory') return false;

    this.environment.workingDirectory = resolved;
    this.environment.variables.set('PWD', resolved);
    return true;
  }

  getCurrentUser(): string {
    return this.environment.user;
  }

  setCurrentUser(username: string): boolean {
    if (!this.users.has(username)) return false;

    const user = this.users.get(username)!;
    this.environment.user = username;
    this.environment.variables.set('USER', username);
    this.environment.variables.set('LOGNAME', username);
    this.environment.variables.set('HOME', user.home);

    return true;
  }

  getHostname(): string {
    return this.hostname;
  }

  setHostname(hostname: string): void {
    this.hostname = hostname;
    this.environment.hostname = hostname;
    this.environment.variables.set('HOSTNAME', hostname);
    this.writeFile('/etc/hostname', hostname + '\n');

    // Update /proc/sys/kernel/hostname
    const kernelHostname = this.getNode('/proc/sys/kernel/hostname');
    if (kernelHostname) {
      kernelHostname.content = hostname + '\n';
    }
  }

  // ============================================================================
  // LINUX-SPECIFIC GETTERS
  // ============================================================================

  getDistribution(): string {
    return this.distribution;
  }

  getKernelVersion(): string {
    return this.kernelVersion;
  }

  getArchitecture(): string {
    return this.architecture;
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  getAllGroups(): Group[] {
    return Array.from(this.groups.values());
  }
}

// Factory function
export function createLinuxDeviceState(config: LinuxDeviceStateConfig): LinuxDeviceState {
  return new LinuxDeviceState(config);
}
