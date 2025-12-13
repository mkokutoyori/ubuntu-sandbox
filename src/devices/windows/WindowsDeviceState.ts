/**
 * WindowsDeviceState - Isolated state for Windows devices
 * Each Windows device instance has its own file system, processes, services, etc.
 */

import {
  DeviceState,
  DeviceStateConfig,
  FileNode,
  FileType,
  FilePermissions,
  User,
  Group,
  Process,
  Service,
  ServiceState,
  Package,
  NetworkInterface,
  Route,
  ARPEntry,
  DNSConfig,
  HostEntry,
  Environment
} from '../common/DeviceState';

// ============================================================================
// WINDOWS SPECIFIC TYPES
// ============================================================================

export interface WindowsDeviceStateConfig extends DeviceStateConfig {
  windowsVersion?: string;
  build?: string;
  edition?: string;
}

export interface WindowsService extends Service {
  startName?: string; // Account under which service runs
  pathName?: string;
  serviceType?: 'kernel_driver' | 'file_system_driver' | 'adapter' | 'recognizer_driver' | 'win32_own_process' | 'win32_share_process' | 'interactive_process';
}

export interface WindowsProcess extends Process {
  sessionId?: number;
  handleCount?: number;
  windowTitle?: string;
}

export interface RegistryKey {
  name: string;
  type: 'key' | 'value';
  dataType?: 'REG_SZ' | 'REG_DWORD' | 'REG_BINARY' | 'REG_MULTI_SZ' | 'REG_EXPAND_SZ' | 'REG_QWORD';
  value?: string | number | Buffer | string[];
  children?: Map<string, RegistryKey>;
}

// ============================================================================
// WINDOWS DEVICE STATE IMPLEMENTATION
// ============================================================================

export class WindowsDeviceState extends DeviceState {
  private windowsVersion: string;
  private build: string;
  private edition: string;
  private registry: Map<string, RegistryKey> = new Map();
  private drives: Map<string, FileNode> = new Map();

  constructor(config: WindowsDeviceStateConfig) {
    super({
      deviceId: config.deviceId,
      hostname: config.hostname.toUpperCase(),
      osType: 'windows'
    });
    this.windowsVersion = config.windowsVersion || 'Windows 10 Pro';
    this.build = config.build || '19045.3693';
    this.edition = config.edition || 'Professional';
    this.hostname = config.hostname.toUpperCase();
    // Initialize after setting derived class properties
    this.initialize();
  }

  // ============================================================================
  // FILE SYSTEM CREATION
  // ============================================================================

  protected createRootFileSystem(): FileNode {
    // Create root that contains drives
    const root = this.createDirectoryNode('');

    // Create C: drive
    const cDrive = this.createDriveStructure('C:');
    this.drives.set('C:', cDrive);
    root.children!.set('C:', cDrive);

    // Create D: drive (optional data drive)
    const dDrive = this.createDirectoryNode('D:');
    dDrive.children!.set('Data', this.createDirectoryNode('Data'));
    this.drives.set('D:', dDrive);
    root.children!.set('D:', dDrive);

    return root;
  }

  private createDriveStructure(driveLetter: string): FileNode {
    const drive = this.createDirectoryNode(driveLetter);

    // Create Windows directory structure
    const windows = this.createDirectoryNode('Windows', 'SYSTEM', 'SYSTEM');
    this.createWindowsDirectories(windows);
    drive.children!.set('Windows', windows);

    // Create Program Files
    const programFiles = this.createDirectoryNode('Program Files', 'SYSTEM', 'SYSTEM');
    this.createProgramFilesDirectories(programFiles);
    drive.children!.set('Program Files', programFiles);

    // Create Program Files (x86)
    const programFiles86 = this.createDirectoryNode('Program Files (x86)', 'SYSTEM', 'SYSTEM');
    this.createProgramFilesDirectories(programFiles86);
    drive.children!.set('Program Files (x86)', programFiles86);

    // Create ProgramData
    const programData = this.createDirectoryNode('ProgramData', 'SYSTEM', 'SYSTEM');
    programData.children!.set('Microsoft', this.createDirectoryNode('Microsoft'));
    drive.children!.set('ProgramData', programData);

    // Create Users directory
    const users = this.createDirectoryNode('Users', 'SYSTEM', 'SYSTEM');
    this.createUsersDirectories(users);
    drive.children!.set('Users', users);

    // Create Temp
    const temp = this.createDirectoryNode('Temp', 'SYSTEM', 'SYSTEM');
    drive.children!.set('Temp', temp);

    // Create boot files
    drive.children!.set('bootmgr', this.createFileNode('bootmgr', '', 'SYSTEM', 'SYSTEM'));
    drive.children!.set('pagefile.sys', this.createFileNode('pagefile.sys', '', 'SYSTEM', 'SYSTEM'));
    drive.children!.set('hiberfil.sys', this.createFileNode('hiberfil.sys', '', 'SYSTEM', 'SYSTEM'));

    return drive;
  }

  private createWindowsDirectories(windows: FileNode): void {
    // System32
    const system32 = this.createDirectoryNode('System32', 'SYSTEM', 'SYSTEM');
    this.createSystem32Contents(system32);
    windows.children!.set('System32', system32);

    // SysWOW64
    const sysWow64 = this.createDirectoryNode('SysWOW64', 'SYSTEM', 'SYSTEM');
    windows.children!.set('SysWOW64', sysWow64);

    // WinSxS
    windows.children!.set('WinSxS', this.createDirectoryNode('WinSxS', 'SYSTEM', 'SYSTEM'));

    // Fonts
    windows.children!.set('Fonts', this.createDirectoryNode('Fonts', 'SYSTEM', 'SYSTEM'));

    // Logs
    const logs = this.createDirectoryNode('Logs', 'SYSTEM', 'SYSTEM');
    logs.children!.set('CBS', this.createDirectoryNode('CBS'));
    logs.children!.set('DISM', this.createDirectoryNode('DISM'));
    windows.children!.set('Logs', logs);

    // INF
    windows.children!.set('INF', this.createDirectoryNode('INF', 'SYSTEM', 'SYSTEM'));

    // Temp
    windows.children!.set('Temp', this.createDirectoryNode('Temp', 'SYSTEM', 'SYSTEM'));

    // Assembly
    windows.children!.set('assembly', this.createDirectoryNode('assembly', 'SYSTEM', 'SYSTEM'));

    // Microsoft.NET
    const dotnet = this.createDirectoryNode('Microsoft.NET', 'SYSTEM', 'SYSTEM');
    dotnet.children!.set('Framework', this.createDirectoryNode('Framework'));
    dotnet.children!.set('Framework64', this.createDirectoryNode('Framework64'));
    windows.children!.set('Microsoft.NET', dotnet);

    // Boot files
    windows.children!.set('explorer.exe', this.createFileNode('explorer.exe', '', 'SYSTEM', 'SYSTEM'));
    windows.children!.set('notepad.exe', this.createFileNode('notepad.exe', '', 'SYSTEM', 'SYSTEM'));
    windows.children!.set('regedit.exe', this.createFileNode('regedit.exe', '', 'SYSTEM', 'SYSTEM'));
    windows.children!.set('win.ini', this.createFileNode('win.ini', this.generateWinIni()));
  }

  private createSystem32Contents(system32: FileNode): void {
    // Config directory
    const config = this.createDirectoryNode('config', 'SYSTEM', 'SYSTEM');
    config.children!.set('SAM', this.createFileNode('SAM', ''));
    config.children!.set('SECURITY', this.createFileNode('SECURITY', ''));
    config.children!.set('SOFTWARE', this.createFileNode('SOFTWARE', ''));
    config.children!.set('SYSTEM', this.createFileNode('SYSTEM', ''));
    system32.children!.set('config', config);

    // Drivers
    const drivers = this.createDirectoryNode('drivers', 'SYSTEM', 'SYSTEM');
    const etc = this.createDirectoryNode('etc', 'SYSTEM', 'SYSTEM');
    etc.children!.set('hosts', this.createFileNode('hosts', this.generateHostsFile()));
    etc.children!.set('services', this.createFileNode('services', this.generateServicesFile()));
    etc.children!.set('protocol', this.createFileNode('protocol', this.generateProtocolFile()));
    etc.children!.set('networks', this.createFileNode('networks', ''));
    drivers.children!.set('etc', etc);
    system32.children!.set('drivers', drivers);

    // Important system files
    const systemFiles = [
      'cmd.exe', 'powershell.exe', 'conhost.exe', 'kernel32.dll', 'ntdll.dll',
      'user32.dll', 'gdi32.dll', 'advapi32.dll', 'shell32.dll', 'ole32.dll',
      'netapi32.dll', 'ws2_32.dll', 'ipconfig.exe', 'ping.exe', 'nslookup.exe',
      'netstat.exe', 'route.exe', 'arp.exe', 'tracert.exe', 'hostname.exe',
      'whoami.exe', 'tasklist.exe', 'taskkill.exe', 'sc.exe', 'net.exe',
      'systeminfo.exe', 'reg.exe', 'wmic.exe', 'sfc.exe', 'dism.exe',
      'shutdown.exe', 'gpupdate.exe', 'certutil.exe', 'msiexec.exe',
      'rundll32.exe', 'mmc.exe', 'devmgmt.msc', 'diskmgmt.msc', 'services.msc'
    ];

    for (const file of systemFiles) {
      system32.children!.set(file, this.createFileNode(file, '', 'SYSTEM', 'SYSTEM'));
    }

    // WindowsPowerShell
    const powershell = this.createDirectoryNode('WindowsPowerShell', 'SYSTEM', 'SYSTEM');
    const v1 = this.createDirectoryNode('v1.0', 'SYSTEM', 'SYSTEM');
    v1.children!.set('powershell.exe', this.createFileNode('powershell.exe', ''));
    powershell.children!.set('v1.0', v1);
    system32.children!.set('WindowsPowerShell', powershell);
  }

  private createProgramFilesDirectories(programFiles: FileNode): void {
    // Common Files
    const common = this.createDirectoryNode('Common Files', 'SYSTEM', 'SYSTEM');
    common.children!.set('Microsoft Shared', this.createDirectoryNode('Microsoft Shared'));
    common.children!.set('Services', this.createDirectoryNode('Services'));
    programFiles.children!.set('Common Files', common);

    // Internet Explorer
    const ie = this.createDirectoryNode('Internet Explorer', 'SYSTEM', 'SYSTEM');
    ie.children!.set('iexplore.exe', this.createFileNode('iexplore.exe', ''));
    programFiles.children!.set('Internet Explorer', ie);

    // Windows Defender
    const defender = this.createDirectoryNode('Windows Defender', 'SYSTEM', 'SYSTEM');
    defender.children!.set('MsMpEng.exe', this.createFileNode('MsMpEng.exe', ''));
    programFiles.children!.set('Windows Defender', defender);

    // Windows NT
    const nt = this.createDirectoryNode('Windows NT', 'SYSTEM', 'SYSTEM');
    const accessories = this.createDirectoryNode('Accessories', 'SYSTEM', 'SYSTEM');
    accessories.children!.set('wordpad.exe', this.createFileNode('wordpad.exe', ''));
    nt.children!.set('Accessories', accessories);
    programFiles.children!.set('Windows NT', nt);
  }

  private createUsersDirectories(users: FileNode): void {
    // Default user template
    const defaultUser = this.createDirectoryNode('Default', 'SYSTEM', 'SYSTEM');
    this.createUserProfile(defaultUser, 'Default');
    users.children!.set('Default', defaultUser);

    // Public
    const publicDir = this.createDirectoryNode('Public', 'SYSTEM', 'Users');
    publicDir.children!.set('Documents', this.createDirectoryNode('Documents'));
    publicDir.children!.set('Downloads', this.createDirectoryNode('Downloads'));
    publicDir.children!.set('Music', this.createDirectoryNode('Music'));
    publicDir.children!.set('Pictures', this.createDirectoryNode('Pictures'));
    publicDir.children!.set('Videos', this.createDirectoryNode('Videos'));
    publicDir.children!.set('Desktop', this.createDirectoryNode('Desktop'));
    users.children!.set('Public', publicDir);

    // Administrator
    const admin = this.createDirectoryNode('Administrator', 'Administrator', 'Administrators');
    this.createUserProfile(admin, 'Administrator');
    users.children!.set('Administrator', admin);

    // Default user (User)
    const user = this.createDirectoryNode('User', 'User', 'Users');
    this.createUserProfile(user, 'User');
    users.children!.set('User', user);
  }

  private createUserProfile(userDir: FileNode, username: string): void {
    const profileDirs = [
      'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos',
      'Favorites', 'Links', 'Contacts', 'Searches', 'Saved Games', '3D Objects'
    ];

    for (const dir of profileDirs) {
      userDir.children!.set(dir, this.createDirectoryNode(dir, username, 'Users'));
    }

    // AppData
    const appData = this.createDirectoryNode('AppData', username, 'Users');
    appData.children!.set('Local', this.createDirectoryNode('Local', username, 'Users'));
    appData.children!.set('LocalLow', this.createDirectoryNode('LocalLow', username, 'Users'));
    appData.children!.set('Roaming', this.createDirectoryNode('Roaming', username, 'Users'));

    const local = appData.children!.get('Local')!;
    local.children!.set('Temp', this.createDirectoryNode('Temp', username, 'Users'));
    local.children!.set('Microsoft', this.createDirectoryNode('Microsoft', username, 'Users'));

    const roaming = appData.children!.get('Roaming')!;
    roaming.children!.set('Microsoft', this.createDirectoryNode('Microsoft', username, 'Users'));

    userDir.children!.set('AppData', appData);

    // NTUSER.DAT (registry hive)
    userDir.children!.set('NTUSER.DAT', this.createFileNode('NTUSER.DAT', '', username, 'Users'));
  }

  // ============================================================================
  // CONTENT GENERATORS
  // ============================================================================

  private generateHostsFile(): string {
    return `# Copyright (c) 1993-2009 Microsoft Corp.
#
# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.
#
# This file contains the mappings of IP addresses to host names. Each
# entry should be kept on an individual line. The IP address should
# be placed in the first column followed by the corresponding host name.
# The IP address and the host name should be separated by at least one
# space.
#
# Additionally, comments (such as these) may be inserted on individual
# lines or following the machine name denoted by a '#' symbol.
#
# For example:
#
#      102.54.94.97     rhino.acme.com          # source server
#       38.25.63.10     x.acme.com              # x client host

# localhost name resolution is handled within DNS itself.
#	127.0.0.1       localhost
#	::1             localhost
`;
  }

  private generateServicesFile(): string {
    return `# Copyright (c) 1993-2004 Microsoft Corp.
#
# This file contains port numbers for well-known services defined by IANA
#
echo                7/tcp
echo                7/udp
discard             9/tcp    sink null
discard             9/udp    sink null
systat             11/tcp    users
daytime            13/tcp
daytime            13/udp
qotd               17/tcp    quote
qotd               17/udp    quote
chargen            19/tcp    ttytst source
chargen            19/udp    ttytst source
ftp-data           20/tcp
ftp                21/tcp
ssh                22/tcp
telnet             23/tcp
smtp               25/tcp    mail
time               37/tcp    timserver
time               37/udp    timserver
rlp                39/udp    resource
nameserver         42/tcp    name
nameserver         42/udp    name
nicname            43/tcp    whois
domain             53/tcp
domain             53/udp
bootps             67/udp    dhcps
bootpc             68/udp    dhcpc
tftp               69/udp
gopher             70/tcp
finger             79/tcp
http               80/tcp    www www-http
kerberos           88/tcp    krb5 kerberos-sec
kerberos           88/udp    krb5 kerberos-sec
hostname          101/tcp    hostnames
iso-tsap          102/tcp
rtelnet           107/tcp
pop2              109/tcp    postoffice
pop3              110/tcp
sunrpc            111/tcp    rpcbind portmap
sunrpc            111/udp    rpcbind portmap
auth              113/tcp    ident tap
uucp-path         117/tcp
nntp              119/tcp    usenet
ntp               123/udp
epmap             135/tcp    loc-srv
epmap             135/udp    loc-srv
netbios-ns        137/tcp    nbname
netbios-ns        137/udp    nbname
netbios-dgm       138/udp    nbdatagram
netbios-ssn       139/tcp    nbsession
imap              143/tcp    imap4
pcmail-srv        158/tcp
snmp              161/udp
snmptrap          162/udp    snmp-trap
print-srv         170/tcp
bgp               179/tcp
irc               194/tcp
ipx               213/udp
ldap              389/tcp
https             443/tcp    MCom
https             443/udp    MCom
microsoft-ds      445/tcp
microsoft-ds      445/udp
kpasswd           464/tcp
kpasswd           464/udp
isakmp            500/udp    ike
exec              512/tcp
login             513/tcp
cmd               514/tcp    shell
printer           515/tcp    spooler
talk              517/udp
ntalk             518/udp
efs               520/tcp
router            520/udp    route routed
timed             525/udp    timeserver
tempo             526/tcp    newdate
courier           530/tcp    rpc
conference        531/tcp    chat
netnews           532/tcp    readnews
netwall           533/udp
uucp              540/tcp    uucpd
klogin            543/tcp
kshell            544/tcp    krcmd
remotefs          556/tcp    rfs rfs_server
ldaps             636/tcp    sldap
doom              666/tcp
doom              666/udp
kerberos-adm      749/tcp
kerberos-adm      749/udp
kerberos-iv       750/udp
kpop             1109/tcp
phone            1167/udp
ms-sql-s         1433/tcp
ms-sql-s         1433/udp
ms-sql-m         1434/tcp
ms-sql-m         1434/udp
wins             1512/tcp
wins             1512/udp
ingreslock       1524/tcp    ingres
l2tp             1701/udp
pptp             1723/tcp
radius           1812/udp
radacct          1813/udp
nfsd             2049/udp    nfs
knetd            2053/tcp
man              9535/tcp
`;
  }

  private generateProtocolFile(): string {
    return `# Copyright (c) 1993-2004 Microsoft Corp.
#
# This file contains the Internet protocols as defined by RFC 1700
# (Assigned Numbers).
#
ip        0  IP          # Internet protocol
icmp      1  ICMP        # Internet control message protocol
ggp       3  GGP         # Gateway-gateway protocol
tcp       6  TCP         # Transmission control protocol
egp       8  EGP         # Exterior gateway protocol
pup      12  PUP         # PARC universal packet protocol
udp      17  UDP         # User datagram protocol
hmp      20  HMP         # Host monitoring protocol
xns-idp  22  XNS-IDP     # Xerox NS IDP
rdp      27  RDP         # Reliable datagram protocol
ipv6     41  IPv6        # Internet protocol IPv6
ipv6-route 43 IPv6-Route # Routing header for IPv6
ipv6-frag 44 IPv6-Frag   # Fragment header for IPv6
esp      50  ESP         # Encapsulating security payload
ah       51  AH          # Authentication header
ipv6-icmp 58 IPv6-ICMP   # ICMP for IPv6
ipv6-nonxt 59 IPv6-NoNxt # No next header for IPv6
ipv6-opts 60 IPv6-Opts   # Destination options for IPv6
rvd      66  RVD         # MIT remote virtual disk
`;
  }

  private generateWinIni(): string {
    return `; for 16-bit app support
[fonts]
[extensions]
[mci extensions]
[files]
[Mail]
MAPI=1
`;
  }

  // ============================================================================
  // ENVIRONMENT CREATION
  // ============================================================================

  protected createDefaultEnvironment(): Environment {
    return {
      variables: new Map([
        ['ALLUSERSPROFILE', 'C:\\ProgramData'],
        ['APPDATA', 'C:\\Users\\User\\AppData\\Roaming'],
        ['CommonProgramFiles', 'C:\\Program Files\\Common Files'],
        ['CommonProgramFiles(x86)', 'C:\\Program Files (x86)\\Common Files'],
        ['CommonProgramW6432', 'C:\\Program Files\\Common Files'],
        ['COMPUTERNAME', this.hostname],
        ['ComSpec', 'C:\\Windows\\system32\\cmd.exe'],
        ['HOMEDRIVE', 'C:'],
        ['HOMEPATH', '\\Users\\User'],
        ['LOCALAPPDATA', 'C:\\Users\\User\\AppData\\Local'],
        ['LOGONSERVER', `\\\\${this.hostname}`],
        ['NUMBER_OF_PROCESSORS', '1'],
        ['OS', 'Windows_NT'],
        ['Path', 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'],
        ['PATHEXT', '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'],
        ['PROCESSOR_ARCHITECTURE', 'AMD64'],
        ['PROCESSOR_IDENTIFIER', 'Intel64 Family 6 Model 158 Stepping 10, GenuineIntel'],
        ['PROCESSOR_LEVEL', '6'],
        ['PROCESSOR_REVISION', '9e0a'],
        ['ProgramData', 'C:\\ProgramData'],
        ['ProgramFiles', 'C:\\Program Files'],
        ['ProgramFiles(x86)', 'C:\\Program Files (x86)'],
        ['ProgramW6432', 'C:\\Program Files'],
        ['PSModulePath', 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
        ['PUBLIC', 'C:\\Users\\Public'],
        ['SystemDrive', 'C:'],
        ['SystemRoot', 'C:\\Windows'],
        ['TEMP', 'C:\\Users\\User\\AppData\\Local\\Temp'],
        ['TMP', 'C:\\Users\\User\\AppData\\Local\\Temp'],
        ['USERDOMAIN', this.hostname],
        ['USERDOMAIN_ROAMINGPROFILE', this.hostname],
        ['USERNAME', 'User'],
        ['USERPROFILE', 'C:\\Users\\User'],
        ['windir', 'C:\\Windows'],
        ['PROMPT', '$P$G'],
      ]),
      aliases: new Map(),
      path: [
        'C:\\Windows\\system32',
        'C:\\Windows',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
      ],
      workingDirectory: 'C:\\Users\\User',
      user: 'User',
      hostname: this.hostname,
      shell: 'cmd.exe',
      term: 'windows',
      lang: 'en-US',
      tz: 'UTC',
      history: [],
      historyIndex: -1
    };
  }

  // ============================================================================
  // SYSTEM INITIALIZATION
  // ============================================================================

  protected initializeSystem(): void {
    this.initializeUsers();
    this.initializeGroups();
    this.initializeServices();
    this.initializePackages();
    this.initializeNetworkInterfaces();
    this.initializeProcesses();
    this.initializeRegistry();
  }

  private initializeUsers(): void {
    const defaultUsers: User[] = [
      { uid: 500, gid: 544, username: 'Administrator', home: 'C:\\Users\\Administrator', shell: 'cmd.exe', groups: ['Administrators'], fullName: 'Administrator', locked: true },
      { uid: 501, gid: 513, username: 'Guest', home: 'C:\\Users\\Guest', shell: 'cmd.exe', groups: ['Guests'], fullName: 'Guest', locked: true },
      { uid: 1000, gid: 545, username: 'User', home: 'C:\\Users\\User', shell: 'cmd.exe', groups: ['Users', 'Administrators'], fullName: 'User' },
      { uid: 18, gid: 18, username: 'SYSTEM', home: 'C:\\Windows\\system32\\config\\systemprofile', shell: '', groups: [], fullName: 'NT AUTHORITY\\SYSTEM' },
      { uid: 19, gid: 19, username: 'LOCAL SERVICE', home: 'C:\\Windows\\ServiceProfiles\\LocalService', shell: '', groups: [], fullName: 'NT AUTHORITY\\LOCAL SERVICE' },
      { uid: 20, gid: 20, username: 'NETWORK SERVICE', home: 'C:\\Windows\\ServiceProfiles\\NetworkService', shell: '', groups: [], fullName: 'NT AUTHORITY\\NETWORK SERVICE' },
    ];

    for (const user of defaultUsers) {
      this.users.set(user.username, user);
    }
  }

  private initializeGroups(): void {
    const defaultGroups: Group[] = [
      { gid: 544, name: 'Administrators', members: ['Administrator', 'User'] },
      { gid: 545, name: 'Users', members: ['User'] },
      { gid: 546, name: 'Guests', members: ['Guest'] },
      { gid: 547, name: 'Power Users', members: [] },
      { gid: 551, name: 'Backup Operators', members: [] },
      { gid: 555, name: 'Remote Desktop Users', members: [] },
      { gid: 513, name: 'None', members: [] },
      { gid: 18, name: 'SYSTEM', members: ['SYSTEM'] },
    ];

    for (const group of defaultGroups) {
      this.groups.set(group.name, group);
    }
  }

  private initializeServices(): void {
    const defaultServices: WindowsService[] = [
      {
        name: 'wuauserv',
        displayName: 'Windows Update',
        description: 'Enables the detection, download, and installation of updates for Windows and other programs.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['rpcss'],
        user: 'SYSTEM',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k netsvcs',
        restartPolicy: 'on-failure',
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'Dhcp',
        displayName: 'DHCP Client',
        description: 'Registers and updates IP addresses and DNS records for this computer.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['Afd', 'NSI', 'Tdx'],
        user: 'LOCAL SERVICE',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k LocalServiceNetworkRestricted',
        restartPolicy: 'on-failure',
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'Dnscache',
        displayName: 'DNS Client',
        description: 'Caches Domain Name System (DNS) names and registers the full computer name.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['nsi'],
        user: 'NETWORK SERVICE',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k NetworkService',
        restartPolicy: 'on-failure',
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'LanmanServer',
        displayName: 'Server',
        description: 'Supports file, print, and named-pipe sharing over the network.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['SamSS', 'Srv2'],
        user: 'SYSTEM',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k netsvcs',
        restartPolicy: 'on-failure',
        ports: [445],
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'LanmanWorkstation',
        displayName: 'Workstation',
        description: 'Creates and maintains client network connections to remote servers.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['Bowser', 'MRxSmb20', 'NSI'],
        user: 'SYSTEM',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k NetworkService',
        restartPolicy: 'on-failure',
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'WinDefend',
        displayName: 'Windows Defender Antivirus Service',
        description: 'Helps protect users from malware and other potentially unwanted software.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: ['RpcSs'],
        user: 'SYSTEM',
        group: 'SYSTEM',
        execStart: '"C:\\Program Files\\Windows Defender\\MsMpEng.exe"',
        restartPolicy: 'always',
        logs: [],
        serviceType: 'win32_own_process'
      },
      {
        name: 'EventLog',
        displayName: 'Windows Event Log',
        description: 'Manages events and event logs.',
        state: 'running',
        enabled: true,
        startType: 'auto',
        dependencies: [],
        user: 'LOCAL SERVICE',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k LocalServiceNetworkRestricted',
        restartPolicy: 'always',
        logs: [],
        serviceType: 'win32_share_process'
      },
      {
        name: 'TermService',
        displayName: 'Remote Desktop Services',
        description: 'Allows users to connect interactively to a remote computer.',
        state: 'stopped',
        enabled: false,
        startType: 'manual',
        dependencies: ['RpcSs', 'TermDD'],
        user: 'NETWORK SERVICE',
        group: 'SYSTEM',
        execStart: 'svchost.exe -k NetworkService',
        restartPolicy: 'no',
        ports: [3389],
        logs: [],
        serviceType: 'win32_share_process'
      },
    ];

    for (const service of defaultServices) {
      this.services.set(service.name, service);
    }
  }

  private initializePackages(): void {
    const defaultPackages: Package[] = [
      { name: 'Microsoft-Windows-Client-Features', version: '10.0.19041.1', description: 'Windows 10 Client Features', installed: true, size: 0, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'Microsoft-Windows-NetFx-VCRedist', version: '10.0.19041.1', description: '.NET Framework', installed: true, size: 50000000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'Microsoft-Windows-PowerShell', version: '10.0.19041.1', description: 'Windows PowerShell', installed: true, size: 10000000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'Microsoft-Windows-InternetExplorer', version: '11.0.19041.1', description: 'Internet Explorer 11', installed: true, size: 20000000, dependencies: [], provides: [], architecture: 'amd64' },
      { name: 'Microsoft-Windows-Defender', version: '10.0.19041.1', description: 'Windows Defender', installed: true, size: 30000000, dependencies: [], provides: [], architecture: 'amd64' },
    ];

    for (const pkg of defaultPackages) {
      pkg.installedDate = this.bootTime;
      this.packages.set(pkg.name, pkg);
    }
  }

  private initializeNetworkInterfaces(): void {
    // Loopback
    this.interfaces.set('Loopback Pseudo-Interface 1', {
      id: `${this.deviceId}-lo`,
      name: 'Loopback Pseudo-Interface 1',
      type: 'loopback',
      macAddress: '00:00:00:00:00:00',
      ipAddress: '127.0.0.1',
      netmask: '255.0.0.0',
      isUp: true,
      isAdminUp: true,
      mtu: 1500,
      rxBytes: 0,
      txBytes: 0,
      rxPackets: 0,
      txPackets: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDropped: 0,
      txDropped: 0
    });

    // Default route
    this.routes.push({
      destination: '127.0.0.0',
      netmask: '255.0.0.0',
      gateway: 'On-link',
      interface: 'Loopback Pseudo-Interface 1',
      metric: 331,
      flags: [],
      protocol: 'kernel'
    });

    // Host entries
    this.hosts.push({ ip: '127.0.0.1', hostnames: ['localhost'] });
  }

  private initializeProcesses(): void {
    // System Idle Process
    this.processes.set(0, {
      pid: 0,
      ppid: 0,
      uid: 18,
      gid: 18,
      command: 'System Idle Process',
      args: [],
      state: 'running',
      priority: 0,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 0,
      workingDirectory: '',
      environment: new Map(),
      threads: 1
    });

    // System
    this.processes.set(4, {
      pid: 4,
      ppid: 0,
      uid: 18,
      gid: 18,
      command: 'System',
      args: [],
      state: 'running',
      priority: 8,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 140000,
      workingDirectory: '',
      environment: new Map(),
      threads: 100
    });

    // Registry
    this.processes.set(88, {
      pid: 88,
      ppid: 4,
      uid: 18,
      gid: 18,
      command: 'Registry',
      args: [],
      state: 'running',
      priority: 8,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 50000000,
      workingDirectory: '',
      environment: new Map(),
      threads: 4
    });

    // smss.exe
    this.processes.set(324, {
      pid: 324,
      ppid: 4,
      uid: 18,
      gid: 18,
      command: 'smss.exe',
      args: [],
      state: 'running',
      priority: 11,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 1000000,
      workingDirectory: 'C:\\Windows\\System32',
      environment: new Map(),
      threads: 2
    });

    // csrss.exe
    this.processes.set(420, {
      pid: 420,
      ppid: 412,
      uid: 18,
      gid: 18,
      command: 'csrss.exe',
      args: [],
      state: 'running',
      priority: 13,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 5000000,
      workingDirectory: 'C:\\Windows\\System32',
      environment: new Map(),
      threads: 12
    });

    // services.exe
    this.processes.set(576, {
      pid: 576,
      ppid: 468,
      uid: 18,
      gid: 18,
      command: 'services.exe',
      args: [],
      state: 'running',
      priority: 9,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 8000000,
      workingDirectory: 'C:\\Windows\\System32',
      environment: new Map(),
      threads: 7
    });

    // lsass.exe
    this.processes.set(592, {
      pid: 592,
      ppid: 468,
      uid: 18,
      gid: 18,
      command: 'lsass.exe',
      args: [],
      state: 'running',
      priority: 9,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 15000000,
      workingDirectory: 'C:\\Windows\\System32',
      environment: new Map(),
      threads: 10
    });

    // svchost.exe instances
    const svchostPids = [680, 760, 820, 920, 1012, 1080, 1200, 1280];
    for (const pid of svchostPids) {
      this.processes.set(pid, {
        pid,
        ppid: 576,
        uid: 18,
        gid: 18,
        command: 'svchost.exe',
        args: ['-k', 'netsvcs'],
        state: 'running',
        priority: 8,
        nice: 0,
        startTime: this.bootTime,
        cpuTime: 0,
        memory: 20000000,
        workingDirectory: 'C:\\Windows\\System32',
        environment: new Map(),
        threads: 15
      });
    }

    // Explorer.exe
    this.processes.set(2048, {
      pid: 2048,
      ppid: 2024,
      uid: 1000,
      gid: 545,
      command: 'explorer.exe',
      args: [],
      state: 'running',
      priority: 8,
      nice: 0,
      startTime: this.bootTime,
      cpuTime: 0,
      memory: 80000000,
      workingDirectory: 'C:\\Windows',
      environment: new Map(),
      threads: 50
    });

    this.pidCounter = 3000;
  }

  private initializeRegistry(): void {
    // Create registry hives
    const hklm = this.createRegistryKey('HKEY_LOCAL_MACHINE');
    const hkcu = this.createRegistryKey('HKEY_CURRENT_USER');
    const hkcr = this.createRegistryKey('HKEY_CLASSES_ROOT');
    const hku = this.createRegistryKey('HKEY_USERS');
    const hkcc = this.createRegistryKey('HKEY_CURRENT_CONFIG');

    // HKLM\SOFTWARE
    const software = this.createRegistryKey('SOFTWARE');
    const microsoft = this.createRegistryKey('Microsoft');
    const windowsNT = this.createRegistryKey('Windows NT');
    const currentVersion = this.createRegistryKey('CurrentVersion');

    currentVersion.children!.set('ProductName', {
      name: 'ProductName',
      type: 'value',
      dataType: 'REG_SZ',
      value: this.windowsVersion
    });
    currentVersion.children!.set('CurrentBuild', {
      name: 'CurrentBuild',
      type: 'value',
      dataType: 'REG_SZ',
      value: this.build
    });
    currentVersion.children!.set('RegisteredOwner', {
      name: 'RegisteredOwner',
      type: 'value',
      dataType: 'REG_SZ',
      value: 'User'
    });

    windowsNT.children!.set('CurrentVersion', currentVersion);
    microsoft.children!.set('Windows NT', windowsNT);
    software.children!.set('Microsoft', microsoft);
    hklm.children!.set('SOFTWARE', software);

    // HKLM\SYSTEM
    const system = this.createRegistryKey('SYSTEM');
    const currentControlSet = this.createRegistryKey('CurrentControlSet');
    const control = this.createRegistryKey('Control');
    const computername = this.createRegistryKey('ComputerName');
    const activeComputerName = this.createRegistryKey('ActiveComputerName');

    activeComputerName.children!.set('ComputerName', {
      name: 'ComputerName',
      type: 'value',
      dataType: 'REG_SZ',
      value: this.hostname
    });

    computername.children!.set('ActiveComputerName', activeComputerName);
    control.children!.set('ComputerName', computername);
    currentControlSet.children!.set('Control', control);
    system.children!.set('CurrentControlSet', currentControlSet);
    hklm.children!.set('SYSTEM', system);

    this.registry.set('HKEY_LOCAL_MACHINE', hklm);
    this.registry.set('HKEY_CURRENT_USER', hkcu);
    this.registry.set('HKEY_CLASSES_ROOT', hkcr);
    this.registry.set('HKEY_USERS', hku);
    this.registry.set('HKEY_CURRENT_CONFIG', hkcc);
  }

  private createRegistryKey(name: string): RegistryKey {
    return {
      name,
      type: 'key',
      children: new Map()
    };
  }

  // ============================================================================
  // FILE SYSTEM OPERATIONS (Windows-specific path handling)
  // ============================================================================

  resolvePath(path: string): string {
    if (!path || path === '') return this.environment.workingDirectory;

    // Handle environment variables
    path = path.replace(/%([^%]+)%/g, (match, varName) => {
      return this.environment.variables.get(varName) || match;
    });

    // Handle user profile
    if (path.startsWith('~')) {
      const user = this.users.get(this.environment.user);
      const home = user?.home || 'C:\\Users\\' + this.environment.user;
      path = home + path.slice(1);
    }

    // Normalize path separators
    path = path.replace(/\//g, '\\');

    // Handle relative paths
    if (!path.match(/^[A-Za-z]:\\/)) {
      if (path.startsWith('\\')) {
        // Absolute path without drive
        path = this.environment.workingDirectory.substring(0, 2) + path;
      } else {
        // Relative path
        path = this.environment.workingDirectory + '\\' + path;
      }
    }

    // Normalize path (resolve . and ..)
    const parts = path.split('\\').filter(p => p !== '' && p !== '.');
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        if (resolved.length > 1) resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return resolved.join('\\');
  }

  getNode(path: string): FileNode | null {
    const resolvedPath = this.resolvePath(path);
    const parts = resolvedPath.split('\\').filter(p => p !== '');

    if (parts.length === 0) return this.root;

    // Get drive
    const driveLetter = parts[0].toUpperCase();
    if (!driveLetter.match(/^[A-Z]:$/)) return null;

    let current = this.drives.get(driveLetter);
    if (!current) return null;

    // Navigate through path
    for (let i = 1; i < parts.length; i++) {
      if (current.type !== 'directory' || !current.children) return null;

      // Case-insensitive lookup
      let child: FileNode | undefined;
      for (const [name, node] of current.children) {
        if (name.toLowerCase() === parts[i].toLowerCase()) {
          child = node;
          break;
        }
      }
      if (!child) return null;
      current = child;
    }

    return current;
  }

  createFile(path: string, content: string = '', permissions?: Partial<FilePermissions>): boolean {
    const resolvedPath = this.resolvePath(path);
    const lastSep = resolvedPath.lastIndexOf('\\');
    const parentPath = lastSep > 2 ? resolvedPath.substring(0, lastSep) : resolvedPath.substring(0, 3);
    const fileName = resolvedPath.substring(lastSep + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    const newFile = this.createFileNode(fileName, content, this.environment.user, 'Users');
    if (permissions) {
      newFile.metadata.permissions = { ...newFile.metadata.permissions, ...permissions };
    }

    parent.children!.set(fileName, newFile);
    return true;
  }

  createDirectory(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    const parts = resolvedPath.split('\\').filter(p => p !== '');

    if (parts.length === 0) return false;

    const driveLetter = parts[0].toUpperCase();
    let current = this.drives.get(driveLetter);
    if (!current) return false;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];

      // Case-insensitive lookup
      let existing: FileNode | undefined;
      for (const [name, node] of current.children!) {
        if (name.toLowerCase() === part.toLowerCase()) {
          existing = node;
          break;
        }
      }

      if (!existing) {
        if (!recursive && i < parts.length - 1) return false;
        const newDir = this.createDirectoryNode(part, this.environment.user, 'Users');
        current.children!.set(part, newDir);
        current = newDir;
      } else {
        if (existing.type !== 'directory') return false;
        current = existing;
      }
    }

    return true;
  }

  deleteNode(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    const lastSep = resolvedPath.lastIndexOf('\\');
    if (lastSep <= 2) return false; // Can't delete drive root

    const parentPath = resolvedPath.substring(0, lastSep);
    const nodeName = resolvedPath.substring(lastSep + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    // Case-insensitive lookup
    let actualName: string | undefined;
    for (const [name, node] of parent.children!) {
      if (name.toLowerCase() === nodeName.toLowerCase()) {
        if (node.type === 'directory' && node.children!.size > 0 && !recursive) {
          return false;
        }
        actualName = name;
        break;
      }
    }

    if (!actualName) return false;
    parent.children!.delete(actualName);
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
        if (!this.copyNode(source + '\\' + name, destination + '\\' + name)) {
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

    // Create user profile directory
    const profilePath = 'C:\\Users\\' + user.username;
    if (!this.exists(profilePath)) {
      this.createDirectory(profilePath, true);
      const users = this.getNode('C:\\Users');
      if (users && users.children) {
        const userDir = users.children.get(user.username);
        if (userDir) {
          this.createUserProfile(userDir, user.username);
        }
      }
    }

    return true;
  }

  removeUser(username: string): boolean {
    return this.users.delete(username);
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
    return this.groups.delete(name);
  }

  getGroup(name: string): Group | null {
    return this.groups.get(name) || null;
  }

  addUserToGroup(username: string, groupName: string): boolean {
    const group = this.groups.get(groupName);
    if (!group || !this.users.has(username)) return false;
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
      ppid: options?.ppid ?? 0,
      uid: options?.uid ?? this.users.get(this.environment.user)?.uid ?? 1000,
      gid: options?.gid ?? this.users.get(this.environment.user)?.gid ?? 545,
      command,
      args,
      state: options?.state ?? 'running',
      priority: options?.priority ?? 8,
      nice: options?.nice ?? 0,
      startTime: new Date(),
      cpuTime: 0,
      memory: options?.memory ?? 10000000,
      workingDirectory: options?.workingDirectory ?? this.environment.workingDirectory,
      environment: options?.environment ?? new Map(this.environment.variables),
      tty: options?.tty,
      threads: options?.threads ?? 1
    };

    this.processes.set(pid, process);
    return pid;
  }

  killProcess(pid: number, signal: number = 15): boolean {
    if (!this.processes.has(pid)) return false;
    if (pid < 100) return false; // Can't kill system processes
    this.processes.delete(pid);
    return true;
  }

  getProcess(pid: number): Process | null {
    return this.processes.get(pid) || null;
  }

  getProcessByName(name: string): Process[] {
    const result: Process[] = [];
    for (const process of this.processes.values()) {
      if (process.command.toLowerCase().includes(name.toLowerCase())) {
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
    const pid = this.createProcess(service.execStart, [], {
      uid: this.users.get(service.user)?.uid ?? 18,
      workingDirectory: 'C:\\Windows\\System32'
    });

    service.pid = pid;
    service.state = 'running';
    service.logs.push(`[${new Date().toISOString()}] The ${service.displayName} service was started successfully.`);
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
    service.logs.push(`[${new Date().toISOString()}] The ${service.displayName} service was stopped successfully.`);
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
    service.startType = 'auto';
    return true;
  }

  disableService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.enabled = false;
    service.startType = 'disabled';
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
    return true;
  }

  // ============================================================================
  // NETWORK CONFIGURATION
  // ============================================================================

  configureInterface(name: string, config: Partial<NetworkInterface>): boolean {
    let iface = this.interfaces.get(name);

    if (!iface) {
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

    if (config.ipAddress && config.netmask) {
      this.addConnectedRoute(name, config.ipAddress, config.netmask);
    }

    return true;
  }

  private addConnectedRoute(interfaceName: string, ipAddress: string, netmask: string): void {
    const ipParts = ipAddress.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    const networkParts = ipParts.map((ip, i) => ip & maskParts[i]);
    const network = networkParts.join('.');

    this.routes = this.routes.filter(r =>
      !(r.interface === interfaceName && r.protocol === 'connected')
    );

    this.routes.push({
      destination: network,
      netmask,
      gateway: 'On-link',
      interface: interfaceName,
      metric: 281,
      flags: [],
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
      if (entry.hostnames.some(h => h.toLowerCase() === hostname.toLowerCase())) {
        return entry.ip;
      }
    }
    return null;
  }

  private updateHostsFile(): void {
    let content = '# Copyright (c) 1993-2009 Microsoft Corp.\n#\n';
    content += '# This file contains the mappings of IP addresses to host names.\n#\n';
    for (const entry of this.hosts) {
      content += `${entry.ip}\t${entry.hostnames.join(' ')}\n`;
    }
    this.writeFile('C:\\Windows\\System32\\drivers\\etc\\hosts', content);
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
    return true;
  }

  getCurrentUser(): string {
    return this.environment.user;
  }

  setCurrentUser(username: string): boolean {
    if (!this.users.has(username)) return false;

    const user = this.users.get(username)!;
    this.environment.user = username;
    this.environment.variables.set('USERNAME', username);
    this.environment.variables.set('USERPROFILE', user.home);
    this.environment.variables.set('HOMEPATH', user.home.substring(2));

    return true;
  }

  getHostname(): string {
    return this.hostname;
  }

  setHostname(hostname: string): void {
    this.hostname = hostname.toUpperCase();
    this.environment.hostname = this.hostname;
    this.environment.variables.set('COMPUTERNAME', this.hostname);
    this.environment.variables.set('USERDOMAIN', this.hostname);

    // Update registry
    const activeComputerName = this.registry.get('HKEY_LOCAL_MACHINE')
      ?.children?.get('SYSTEM')
      ?.children?.get('CurrentControlSet')
      ?.children?.get('Control')
      ?.children?.get('ComputerName')
      ?.children?.get('ActiveComputerName');

    if (activeComputerName?.children) {
      activeComputerName.children.set('ComputerName', {
        name: 'ComputerName',
        type: 'value',
        dataType: 'REG_SZ',
        value: this.hostname
      });
    }
  }

  // ============================================================================
  // WINDOWS-SPECIFIC GETTERS
  // ============================================================================

  getWindowsVersion(): string {
    return this.windowsVersion;
  }

  getBuild(): string {
    return this.build;
  }

  getEdition(): string {
    return this.edition;
  }

  getRegistry(): Map<string, RegistryKey> {
    return this.registry;
  }

  getDrives(): string[] {
    return Array.from(this.drives.keys());
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  getAllGroups(): Group[] {
    return Array.from(this.groups.values());
  }
}

// Factory function
export function createWindowsDeviceState(config: WindowsDeviceStateConfig): WindowsDeviceState {
  return new WindowsDeviceState(config);
}
