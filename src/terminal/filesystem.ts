import { FileNode, User, Group } from './types';

export class FileSystem {
  root: FileNode;
  users: Map<string, User>;
  groups: Map<string, Group>;

  constructor() {
    this.users = new Map();
    this.groups = new Map();
    this.root = this.createInitialFileSystem();
    this.initializeUsers();
  }

  private createDir(name: string, owner = 'root', group = 'root', permissions = 'drwxr-xr-x'): FileNode {
    return {
      name,
      type: 'directory',
      children: new Map(),
      permissions,
      owner,
      group,
      size: 4096,
      modified: new Date(),
      created: new Date(),
    };
  }

  private createFile(name: string, content = '', owner = 'root', group = 'root', permissions = '-rw-r--r--'): FileNode {
    return {
      name,
      type: 'file',
      content,
      permissions,
      owner,
      group,
      size: content.length,
      modified: new Date(),
      created: new Date(),
    };
  }

  private createSymlink(name: string, target: string, owner = 'root', group = 'root'): FileNode {
    return {
      name,
      type: 'symlink',
      target,
      permissions: 'lrwxrwxrwx',
      owner,
      group,
      size: target.length,
      modified: new Date(),
      created: new Date(),
    };
  }

  private initializeUsers(): void {
    // System users
    const systemUsers: User[] = [
      { username: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash', password: 'root', groups: ['root', 'sudo'] },
      { username: 'user', uid: 1000, gid: 1000, home: '/home/user', shell: '/bin/bash', password: 'user', groups: ['user', 'sudo', 'adm'] },
      { username: 'daemon', uid: 1, gid: 1, home: '/usr/sbin', shell: '/usr/sbin/nologin', password: '*', groups: ['daemon'] },
      { username: 'bin', uid: 2, gid: 2, home: '/bin', shell: '/usr/sbin/nologin', password: '*', groups: ['bin'] },
      { username: 'sys', uid: 3, gid: 3, home: '/dev', shell: '/usr/sbin/nologin', password: '*', groups: ['sys'] },
      { username: 'nobody', uid: 65534, gid: 65534, home: '/nonexistent', shell: '/usr/sbin/nologin', password: '*', groups: ['nogroup'] },
      { username: 'www-data', uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin', password: '*', groups: ['www-data'] },
      { username: 'mysql', uid: 27, gid: 27, home: '/var/lib/mysql', shell: '/bin/false', password: '*', groups: ['mysql'] },
    ];

    systemUsers.forEach(user => this.users.set(user.username, user));

    // System groups
    const systemGroups: Group[] = [
      { name: 'root', gid: 0, members: ['root'] },
      { name: 'sudo', gid: 27, members: ['root', 'user'] },
      { name: 'adm', gid: 4, members: ['user'] },
      { name: 'user', gid: 1000, members: ['user'] },
      { name: 'daemon', gid: 1, members: ['daemon'] },
      { name: 'bin', gid: 2, members: ['bin'] },
      { name: 'sys', gid: 3, members: ['sys'] },
      { name: 'nogroup', gid: 65534, members: ['nobody'] },
      { name: 'www-data', gid: 33, members: ['www-data'] },
      { name: 'mysql', gid: 27, members: ['mysql'] },
    ];

    systemGroups.forEach(group => this.groups.set(group.name, group));
  }

  private createInitialFileSystem(): FileNode {
    const root = this.createDir('/', 'root', 'root', 'drwxr-xr-x');

    // /bin - Essential command binaries
    const bin = this.createDir('bin');
    const binaries = ['bash', 'cat', 'chmod', 'chown', 'cp', 'date', 'dd', 'df', 'echo', 'false', 'grep', 'gzip', 'hostname', 'kill', 'ln', 'ls', 'mkdir', 'more', 'mount', 'mv', 'nano', 'ping', 'ps', 'pwd', 'rm', 'rmdir', 'sed', 'sh', 'sleep', 'su', 'tar', 'touch', 'true', 'umount', 'uname', 'vi', 'vim', 'wc', 'which'];
    binaries.forEach(b => bin.children!.set(b, this.createFile(b, `#!/bin/bash\n# ${b} binary`, 'root', 'root', '-rwxr-xr-x')));
    root.children!.set('bin', bin);

    // /boot - Boot loader files
    const boot = this.createDir('boot');
    boot.children!.set('grub', this.createDir('grub'));
    boot.children!.set('vmlinuz-5.15.0-generic', this.createFile('vmlinuz-5.15.0-generic', '[KERNEL IMAGE]', 'root', 'root', '-rw-r--r--'));
    boot.children!.set('initrd.img-5.15.0-generic', this.createFile('initrd.img-5.15.0-generic', '[INITRD IMAGE]', 'root', 'root', '-rw-r--r--'));
    root.children!.set('boot', boot);

    // /dev - Device files
    const dev = this.createDir('dev');
    dev.children!.set('null', this.createFile('null', '', 'root', 'root', 'crw-rw-rw-'));
    dev.children!.set('zero', this.createFile('zero', '', 'root', 'root', 'crw-rw-rw-'));
    dev.children!.set('random', this.createFile('random', '', 'root', 'root', 'crw-rw-rw-'));
    dev.children!.set('urandom', this.createFile('urandom', '', 'root', 'root', 'crw-rw-rw-'));
    dev.children!.set('tty', this.createFile('tty', '', 'root', 'tty', 'crw-rw-rw-'));
    dev.children!.set('sda', this.createFile('sda', '', 'root', 'disk', 'brw-rw----'));
    dev.children!.set('sda1', this.createFile('sda1', '', 'root', 'disk', 'brw-rw----'));
    root.children!.set('dev', dev);

    // /etc - Configuration files
    const etc = this.createDir('etc');
    etc.children!.set('passwd', this.createFile('passwd', this.generatePasswd()));
    etc.children!.set('shadow', this.createFile('shadow', this.generateShadow(), 'root', 'shadow', '-rw-r-----'));
    etc.children!.set('group', this.createFile('group', this.generateGroup()));
    etc.children!.set('hostname', this.createFile('hostname', 'ubuntu-terminal\n'));
    etc.children!.set('hosts', this.createFile('hosts', '127.0.0.1\tlocalhost\n127.0.1.1\tubuntu-terminal\n\n# IPv6\n::1\t\tlocalhost ip6-localhost ip6-loopback\nff02::1\t\tip6-allnodes\nff02::2\t\tip6-allrouters\n'));
    etc.children!.set('resolv.conf', this.createFile('resolv.conf', 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n'));
    etc.children!.set('fstab', this.createFile('fstab', '# /etc/fstab: static file system information.\n#\n# <file system> <mount point>   <type>  <options>       <dump>  <pass>\n/dev/sda1       /               ext4    errors=remount-ro 0       1\n'));
    etc.children!.set('os-release', this.createFile('os-release', 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nVERSION="22.04.3 LTS (Jammy Jellyfish)"\nVERSION_CODENAME=jammy\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\nSUPPORT_URL="https://help.ubuntu.com/"\nBUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"\n'));
    etc.children!.set('sudoers', this.createFile('sudoers', '# sudoers file.\n#\nroot    ALL=(ALL:ALL) ALL\n%sudo   ALL=(ALL:ALL) ALL\n', 'root', 'root', '-r--r-----'));
    etc.children!.set('bash.bashrc', this.createFile('bash.bashrc', '# System-wide .bashrc file for interactive bash shells.\n\n# If not running interactively, don\'t do anything\n[ -z "$PS1" ] && return\n\n# History settings\nHISTCONTROL=ignoreboth\nHISTSIZE=1000\nHISTFILESIZE=2000\n'));
    etc.children!.set('profile', this.createFile('profile', '# /etc/profile: system-wide .profile file\n\nif [ "$BASH" ]; then\n  if [ -f /etc/bash.bashrc ]; then\n    . /etc/bash.bashrc\n  fi\nfi\n'));
    etc.children!.set('motd', this.createFile('motd', '\n  _    _  _                _          _____                   _             _ \n | |  | || |              | |        |_   _|                 (_)           | |\n | |  | || |__  _   _ _ __| |_ _   _   | | ___ _ __ _ __ ___  _ _ __   __ _| |\n | |  | || \'_ \\| | | | \'_ \\ __| | | |  | |/ _ \\ \'__| \'_ ` _ \\| | \'_ \\ / _` | |\n | |__| || |_) | |_| | | | | |_| |_| |  | |  __/ |  | | | | | | | | | | (_| | |\n  \\____/ |_.__/ \\__,_|_| |_|\\__|\\__,_|  \\_/\\___|_|  |_| |_| |_|_|_| |_|\\__,_|_|\n\n'));
    
    const etcApt = this.createDir('apt');
    etcApt.children!.set('sources.list', this.createFile('sources.list', '# Ubuntu sources.list\ndeb http://archive.ubuntu.com/ubuntu/ jammy main restricted\ndeb http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted\ndeb http://archive.ubuntu.com/ubuntu/ jammy universe\ndeb http://archive.ubuntu.com/ubuntu/ jammy-security main restricted\n'));
    etc.children!.set('apt', etcApt);

    const etcSsh = this.createDir('ssh');
    etcSsh.children!.set('sshd_config', this.createFile('sshd_config', '# SSH Server Configuration\nPort 22\nPermitRootLogin prohibit-password\nPasswordAuthentication yes\n'));
    etc.children!.set('ssh', etcSsh);

    const etcCron = this.createDir('cron.d');
    etc.children!.set('cron.d', etcCron);
    etc.children!.set('crontab', this.createFile('crontab', '# /etc/crontab: system-wide crontab\nSHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n# m h dom mon dow user command\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n'));

    root.children!.set('etc', etc);

    // /home - User home directories
    const home = this.createDir('home');
    const userHome = this.createDir('user', 'user', 'user', 'drwxr-xr-x');
    userHome.children!.set('.bashrc', this.createFile('.bashrc', '# ~/.bashrc: executed by bash for non-login shells.\n\n# If not running interactively, don\'t do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n# History settings\nHISTCONTROL=ignoreboth\nHISTSIZE=1000\nHISTFILESIZE=2000\n\n# Alias definitions\nalias ll=\'ls -alF\'\nalias la=\'ls -A\'\nalias l=\'ls -CF\'\nalias grep=\'grep --color=auto\'\n', 'user', 'user'));
    userHome.children!.set('.profile', this.createFile('.profile', '# ~/.profile: executed by the login shell.\n\nif [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n        . "$HOME/.bashrc"\n    fi\nfi\n\nPATH="$HOME/bin:$HOME/.local/bin:$PATH"\n', 'user', 'user'));
    userHome.children!.set('.bash_history', this.createFile('.bash_history', 'ls\ncd /var/log\ncat syslog\nexit\n', 'user', 'user', '-rw-------'));
    userHome.children!.set('Documents', this.createDir('Documents', 'user', 'user'));
    userHome.children!.set('Downloads', this.createDir('Downloads', 'user', 'user'));
    userHome.children!.set('Pictures', this.createDir('Pictures', 'user', 'user'));
    userHome.children!.set('Music', this.createDir('Music', 'user', 'user'));
    userHome.children!.set('Videos', this.createDir('Videos', 'user', 'user'));
    userHome.children!.set('Desktop', this.createDir('Desktop', 'user', 'user'));
    
    const welcomeTxt = this.createFile('welcome.txt', 'Welcome to Ubuntu Terminal Simulator!\n\nThis is a virtual Linux environment.\nTry some commands:\n  - ls, cd, pwd\n  - cat, nano, vim\n  - mkdir, touch, rm\n  - sudo, su\n  - apt update, apt install\n\nHave fun exploring!\n', 'user', 'user');
    userHome.children!.get('Documents')!.children!.set('welcome.txt', welcomeTxt);
    
    home.children!.set('user', userHome);
    root.children!.set('home', home);

    // /lib - Shared libraries
    const lib = this.createDir('lib');
    lib.children!.set('x86_64-linux-gnu', this.createDir('x86_64-linux-gnu'));
    lib.children!.set('modules', this.createDir('modules'));
    lib.children!.set('systemd', this.createDir('systemd'));
    root.children!.set('lib', lib);
    root.children!.set('lib64', this.createSymlink('lib64', 'lib'));

    // /media - Mount points for removable media
    root.children!.set('media', this.createDir('media'));

    // /mnt - Mount points for temporary mounts
    root.children!.set('mnt', this.createDir('mnt'));

    // /opt - Optional application software packages
    root.children!.set('opt', this.createDir('opt'));

    // /proc - Virtual filesystem for process information
    const proc = this.createDir('proc');
    proc.children!.set('cpuinfo', this.createFile('cpuinfo', 'processor\t: 0\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 142\nmodel name\t: Intel(R) Core(TM) i7-8565U CPU @ 1.80GHz\nstepping\t: 11\nmicrocode\t: 0xde\ncpu MHz\t\t: 1992.000\ncache size\t: 8192 KB\n'));
    proc.children!.set('meminfo', this.createFile('meminfo', 'MemTotal:       16384000 kB\nMemFree:         8192000 kB\nMemAvailable:   12288000 kB\nBuffers:          512000 kB\nCached:          2048000 kB\nSwapTotal:       2097152 kB\nSwapFree:        2097152 kB\n'));
    proc.children!.set('version', this.createFile('version', 'Linux version 5.15.0-generic (buildd@lcy02-amd64-015) (gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) #1 SMP PREEMPT_DYNAMIC\n'));
    proc.children!.set('uptime', this.createFile('uptime', '86400.00 172800.00\n'));
    proc.children!.set('loadavg', this.createFile('loadavg', '0.15 0.10 0.05 1/234 5678\n'));
    root.children!.set('proc', proc);

    // /root - Root user home directory
    const rootHome = this.createDir('root', 'root', 'root', 'drwx------');
    rootHome.children!.set('.bashrc', this.createFile('.bashrc', '# ~/.bashrc: executed by bash for non-login shells.\nexport PS1=\'\\[\\033[01;31m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ \'\nalias ll=\'ls -alF\'\nalias la=\'ls -A\'\n', 'root', 'root'));
    rootHome.children!.set('.profile', this.createFile('.profile', '# ~/.profile: executed by the login shell.\nif [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\nmesg n 2>/dev/null || true\n', 'root', 'root'));
    root.children!.set('root', rootHome);

    // /run - Runtime data
    root.children!.set('run', this.createDir('run'));

    // /sbin - System binaries
    const sbin = this.createDir('sbin');
    const sbinaries = ['fdisk', 'fsck', 'halt', 'ifconfig', 'init', 'iptables', 'mkfs', 'mount', 'reboot', 'route', 'shutdown', 'swapon', 'swapoff'];
    sbinaries.forEach(b => sbin.children!.set(b, this.createFile(b, `#!/bin/bash\n# ${b} system binary`, 'root', 'root', '-rwxr-xr-x')));
    root.children!.set('sbin', sbin);

    // /srv - Data for services
    root.children!.set('srv', this.createDir('srv'));

    // /sys - Virtual filesystem for system information
    const sys = this.createDir('sys');
    sys.children!.set('class', this.createDir('class'));
    sys.children!.set('devices', this.createDir('devices'));
    sys.children!.set('kernel', this.createDir('kernel'));
    root.children!.set('sys', sys);

    // /tmp - Temporary files
    const tmp = this.createDir('tmp', 'root', 'root', 'drwxrwxrwt');
    root.children!.set('tmp', tmp);

    // /usr - User utilities and applications
    const usr = this.createDir('usr');
    usr.children!.set('bin', this.createDir('bin'));
    usr.children!.set('include', this.createDir('include'));
    usr.children!.set('lib', this.createDir('lib'));
    usr.children!.set('local', this.createDir('local'));
    usr.children!.set('sbin', this.createDir('sbin'));
    usr.children!.set('share', this.createDir('share'));
    usr.children!.set('src', this.createDir('src'));
    
    const usrShare = usr.children!.get('share')!;
    usrShare.children!.set('man', this.createDir('man'));
    usrShare.children!.set('doc', this.createDir('doc'));
    
    root.children!.set('usr', usr);

    // /var - Variable data
    const varDir = this.createDir('var');
    
    const varLog = this.createDir('log');
    varLog.children!.set('syslog', this.createFile('syslog', this.generateSyslog()));
    varLog.children!.set('auth.log', this.createFile('auth.log', this.generateAuthLog()));
    varLog.children!.set('kern.log', this.createFile('kern.log', this.generateKernLog()));
    varLog.children!.set('dpkg.log', this.createFile('dpkg.log', this.generateDpkgLog()));
    varLog.children!.set('apt', this.createDir('apt'));
    varLog.children!.get('apt')!.children!.set('history.log', this.createFile('history.log', 'Start-Date: 2024-01-15 10:30:00\nCommandline: apt install vim\nInstall: vim:amd64 (2:8.2.3995-1ubuntu2.13)\nEnd-Date: 2024-01-15 10:30:45\n'));
    varDir.children!.set('log', varLog);

    varDir.children!.set('cache', this.createDir('cache'));
    varDir.children!.set('lib', this.createDir('lib'));
    varDir.children!.set('tmp', this.createDir('tmp', 'root', 'root', 'drwxrwxrwt'));
    varDir.children!.set('www', this.createDir('www', 'www-data', 'www-data'));
    varDir.children!.get('www')!.children!.set('html', this.createDir('html', 'www-data', 'www-data'));
    varDir.children!.get('www')!.children!.get('html')!.children!.set('index.html', this.createFile('index.html', '<!DOCTYPE html>\n<html>\n<head><title>Welcome to Ubuntu</title></head>\n<body><h1>It works!</h1></body>\n</html>\n', 'www-data', 'www-data'));

    root.children!.set('var', varDir);

    return root;
  }

  private generatePasswd(): string {
    const lines: string[] = [];
    this.users.forEach(user => {
      lines.push(`${user.username}:x:${user.uid}:${user.gid}:${user.username}:${user.home}:${user.shell}`);
    });
    return lines.join('\n') + '\n';
  }

  private generateShadow(): string {
    const lines: string[] = [];
    this.users.forEach(user => {
      lines.push(`${user.username}:${user.password === '*' ? '*' : '$6$rounds=656000$salt$hash'}:19000:0:99999:7:::`);
    });
    return lines.join('\n') + '\n';
  }

  private generateGroup(): string {
    const lines: string[] = [];
    this.groups.forEach(group => {
      lines.push(`${group.name}:x:${group.gid}:${group.members.join(',')}`);
    });
    return lines.join('\n') + '\n';
  }

  private generateSyslog(): string {
    const date = new Date();
    const logs: string[] = [];
    for (let i = 20; i >= 0; i--) {
      const d = new Date(date.getTime() - i * 60000);
      const timestamp = d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const messages = [
        'systemd[1]: Started Daily apt download activities.',
        'kernel: [    0.000000] Linux version 5.15.0-generic',
        'systemd[1]: Reached target Basic System.',
        'cron[1234]: (root) CMD (test -x /usr/sbin/anacron)',
        'systemd[1]: Started Session 1 of user user.',
        'kernel: [   12.345678] EXT4-fs (sda1): mounted filesystem',
      ];
      logs.push(`${timestamp} ubuntu-terminal ${messages[i % messages.length]}`);
    }
    return logs.join('\n') + '\n';
  }

  private generateAuthLog(): string {
    const date = new Date();
    const logs: string[] = [];
    for (let i = 10; i >= 0; i--) {
      const d = new Date(date.getTime() - i * 300000);
      const timestamp = d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const messages = [
        'sshd[1234]: Accepted password for user from 192.168.1.100 port 54321 ssh2',
        'sudo: user : TTY=pts/0 ; PWD=/home/user ; USER=root ; COMMAND=/bin/ls',
        'systemd-logind[567]: New session 1 of user user.',
        'sshd[1234]: pam_unix(sshd:session): session opened for user user',
      ];
      logs.push(`${timestamp} ubuntu-terminal ${messages[i % messages.length]}`);
    }
    return logs.join('\n') + '\n';
  }

  private generateKernLog(): string {
    const logs = [
      '[    0.000000] Linux version 5.15.0-generic',
      '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-generic root=/dev/sda1',
      '[    0.000000] KERNEL supported cpus:',
      '[    0.000000]   Intel GenuineIntel',
      '[    0.000000]   AMD AuthenticAMD',
      '[    0.001234] x86/fpu: Supporting XSAVE feature',
      '[    0.002345] BIOS-provided physical RAM map:',
      '[    1.234567] EXT4-fs (sda1): mounted filesystem with ordered data mode',
    ];
    return logs.join('\n') + '\n';
  }

  private generateDpkgLog(): string {
    return `2024-01-15 10:30:00 startup packages configure
2024-01-15 10:30:01 configure vim:amd64 2:8.2.3995-1ubuntu2.13 <none>
2024-01-15 10:30:45 status installed vim:amd64 2:8.2.3995-1ubuntu2.13
`;
  }

  // Path resolution
  resolvePath(path: string, currentPath: string): string {
    if (path.startsWith('/')) {
      return this.normalizePath(path);
    }
    return this.normalizePath(currentPath + '/' + path);
  }

  normalizePath(path: string): string {
    const parts = path.split('/').filter(p => p !== '' && p !== '.');
    const result: string[] = [];
    
    for (const part of parts) {
      if (part === '..') {
        result.pop();
      } else {
        result.push(part);
      }
    }
    
    return '/' + result.join('/');
  }

  // Get node at path
  getNode(path: string): FileNode | null {
    if (path === '/') return this.root;
    
    const parts = path.split('/').filter(p => p !== '');
    let current: FileNode = this.root;
    
    for (const part of parts) {
      if (current.type !== 'directory' || !current.children) {
        return null;
      }
      const next = current.children.get(part);
      if (!next) return null;
      
      // Handle symlinks
      if (next.type === 'symlink' && next.target) {
        const resolved = this.getNode(this.resolvePath(next.target, path));
        if (!resolved) return null;
        current = resolved;
      } else {
        current = next;
      }
    }
    
    return current;
  }

  // Create file or directory
  createNode(path: string, type: 'file' | 'directory', owner: string, content = ''): boolean {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.substring(path.lastIndexOf('/') + 1);
    
    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;
    
    if (parent.children!.has(name)) return false;
    
    const group = this.users.get(owner)?.groups[0] || owner;
    
    if (type === 'directory') {
      parent.children!.set(name, this.createDir(name, owner, group));
    } else {
      parent.children!.set(name, this.createFile(name, content, owner, group));
    }
    
    return true;
  }

  // Delete node
  deleteNode(path: string, recursive = false): boolean {
    if (path === '/') return false;
    
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.substring(path.lastIndexOf('/') + 1);
    
    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;
    
    const node = parent.children!.get(name);
    if (!node) return false;
    
    if (node.type === 'directory' && node.children!.size > 0 && !recursive) {
      return false;
    }
    
    parent.children!.delete(name);
    return true;
  }

  // Update file content
  updateFile(path: string, content: string): boolean {
    const node = this.getNode(path);
    if (!node || node.type !== 'file') return false;
    
    node.content = content;
    node.size = content.length;
    node.modified = new Date();
    return true;
  }

  // Copy node
  copyNode(src: string, dest: string, owner: string): boolean {
    const srcNode = this.getNode(src);
    if (!srcNode) return false;
    
    const destParentPath = dest.substring(0, dest.lastIndexOf('/')) || '/';
    const destName = dest.substring(dest.lastIndexOf('/') + 1);
    
    const destParent = this.getNode(destParentPath);
    if (!destParent || destParent.type !== 'directory') return false;
    
    const copy = this.deepCopyNode(srcNode, destName, owner);
    destParent.children!.set(destName, copy);
    return true;
  }

  private deepCopyNode(node: FileNode, newName: string, owner: string): FileNode {
    const group = this.users.get(owner)?.groups[0] || owner;
    
    if (node.type === 'file') {
      return this.createFile(newName, node.content || '', owner, group, node.permissions);
    }
    
    const copy = this.createDir(newName, owner, group, node.permissions);
    if (node.children) {
      node.children.forEach((child, name) => {
        copy.children!.set(name, this.deepCopyNode(child, name, owner));
      });
    }
    return copy;
  }

  // Move/rename node
  moveNode(src: string, dest: string): boolean {
    const srcParentPath = src.substring(0, src.lastIndexOf('/')) || '/';
    const srcName = src.substring(src.lastIndexOf('/') + 1);
    
    const srcParent = this.getNode(srcParentPath);
    if (!srcParent || srcParent.type !== 'directory') return false;
    
    const node = srcParent.children!.get(srcName);
    if (!node) return false;
    
    const destParentPath = dest.substring(0, dest.lastIndexOf('/')) || '/';
    const destName = dest.substring(dest.lastIndexOf('/') + 1);
    
    const destParent = this.getNode(destParentPath);
    if (!destParent || destParent.type !== 'directory') return false;
    
    srcParent.children!.delete(srcName);
    node.name = destName;
    destParent.children!.set(destName, node);
    return true;
  }

  // List directory contents
  listDirectory(path: string): FileNode[] | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'directory') return null;
    
    return Array.from(node.children!.values());
  }

  // Check permissions
  canRead(path: string, user: string): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    if (user === 'root') return true;
    
    const perms = node.permissions;
    if (node.owner === user) return perms[1] === 'r';
    
    const userObj = this.users.get(user);
    if (userObj && userObj.groups.includes(node.group)) return perms[4] === 'r';
    
    return perms[7] === 'r';
  }

  canWrite(path: string, user: string): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    if (user === 'root') return true;
    
    const perms = node.permissions;
    if (node.owner === user) return perms[2] === 'w';
    
    const userObj = this.users.get(user);
    if (userObj && userObj.groups.includes(node.group)) return perms[5] === 'w';
    
    return perms[8] === 'w';
  }

  canExecute(path: string, user: string): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    if (user === 'root') return true;
    
    const perms = node.permissions;
    if (node.owner === user) return perms[3] === 'x';
    
    const userObj = this.users.get(user);
    if (userObj && userObj.groups.includes(node.group)) return perms[6] === 'x';
    
    return perms[9] === 'x';
  }

  // User management
  addUser(username: string, password: string, uid?: number): boolean {
    if (this.users.has(username)) return false;
    
    const newUid = uid || Math.max(...Array.from(this.users.values()).map(u => u.uid)) + 1;
    const user: User = {
      username,
      uid: newUid,
      gid: newUid,
      home: `/home/${username}`,
      shell: '/bin/bash',
      password,
      groups: [username],
    };
    
    this.users.set(username, user);
    this.groups.set(username, { name: username, gid: newUid, members: [username] });
    
    // Create home directory
    const home = this.getNode('/home');
    if (home && home.type === 'directory') {
      const userDir = this.createDir(username, username, username, 'drwxr-xr-x');
      userDir.children!.set('.bashrc', this.createFile('.bashrc', '# ~/.bashrc\nalias ll=\'ls -alF\'\nalias la=\'ls -A\'\n', username, username));
      userDir.children!.set('.profile', this.createFile('.profile', '# ~/.profile\n', username, username));
      home.children!.set(username, userDir);
    }
    
    // Update /etc/passwd and /etc/group
    const etcPasswd = this.getNode('/etc/passwd');
    if (etcPasswd) etcPasswd.content = this.generatePasswd();
    
    const etcGroup = this.getNode('/etc/group');
    if (etcGroup) etcGroup.content = this.generateGroup();
    
    return true;
  }

  deleteUser(username: string): boolean {
    if (!this.users.has(username) || username === 'root') return false;
    
    this.users.delete(username);
    this.groups.delete(username);
    
    // Remove from other groups
    this.groups.forEach(group => {
      group.members = group.members.filter(m => m !== username);
    });
    
    // Update files
    const etcPasswd = this.getNode('/etc/passwd');
    if (etcPasswd) etcPasswd.content = this.generatePasswd();
    
    const etcGroup = this.getNode('/etc/group');
    if (etcGroup) etcGroup.content = this.generateGroup();
    
    return true;
  }

  changePassword(username: string, newPassword: string): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    user.password = newPassword;
    return true;
  }

  authenticateUser(username: string, password: string): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    return user.password === password;
  }

  getUser(username: string): User | undefined {
    return this.users.get(username);
  }

  getUserGroups(username: string): string[] {
    const user = this.users.get(username);
    return user?.groups || [];
  }

  isUserInGroup(username: string, group: string): boolean {
    return this.getUserGroups(username).includes(group);
  }

  addUserToGroup(username: string, groupName: string): boolean {
    const user = this.users.get(username);
    const group = this.groups.get(groupName);
    
    if (!user || !group) return false;
    if (!user.groups.includes(groupName)) {
      user.groups.push(groupName);
    }
    if (!group.members.includes(username)) {
      group.members.push(username);
    }
    
    const etcGroup = this.getNode('/etc/group');
    if (etcGroup) etcGroup.content = this.generateGroup();
    
    return true;
  }
}

export const fileSystem = new FileSystem();
