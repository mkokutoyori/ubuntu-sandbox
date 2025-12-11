import { Package } from './types';

export const availablePackages: Package[] = [
  { name: 'vim', version: '2:8.2.3995-1ubuntu2', description: 'Vi IMproved - enhanced vi editor', installed: true, size: '3,564 kB' },
  { name: 'nano', version: '6.2-1', description: 'small, friendly text editor', installed: true, size: '280 kB' },
  { name: 'git', version: '1:2.34.1-1ubuntu1', description: 'fast, scalable, distributed revision control system', installed: false, size: '4,892 kB' },
  { name: 'curl', version: '7.81.0-1ubuntu1', description: 'command line tool for transferring data with URL syntax', installed: true, size: '452 kB' },
  { name: 'wget', version: '1.21.2-2ubuntu1', description: 'retrieves files from the web', installed: true, size: '384 kB' },
  { name: 'htop', version: '3.0.5-7build2', description: 'interactive processes viewer', installed: false, size: '128 kB' },
  { name: 'tree', version: '2.0.2-1', description: 'displays an indented directory tree', installed: false, size: '56 kB' },
  { name: 'net-tools', version: '1.60+git20181103-0.1', description: 'NET-3 networking toolkit', installed: true, size: '456 kB' },
  { name: 'python3', version: '3.10.6-1~22.04', description: 'interactive high-level object-oriented language', installed: false, size: '5,234 kB' },
  { name: 'nodejs', version: '18.16.0-1nodesource1', description: 'JavaScript runtime built on V8', installed: false, size: '12,456 kB' },
  { name: 'nginx', version: '1.18.0-6ubuntu14', description: 'high performance web server', installed: false, size: '892 kB' },
  { name: 'apache2', version: '2.4.52-1ubuntu4', description: 'Apache HTTP Server', installed: false, size: '1,234 kB' },
  { name: 'mysql-server', version: '8.0.32-0ubuntu0.22.04.2', description: 'MySQL database server', installed: false, size: '8,234 kB' },
  { name: 'postgresql', version: '14+238', description: 'object-relational SQL database', installed: false, size: '7,892 kB' },
  { name: 'docker.io', version: '20.10.21-0ubuntu1~22.04', description: 'Linux container runtime', installed: false, size: '45,678 kB' },
  { name: 'build-essential', version: '12.9ubuntu3', description: 'Informational list of build-essential packages', installed: false, size: '12 kB' },
  { name: 'gcc', version: '4:11.2.0-1ubuntu1', description: 'GNU C compiler', installed: false, size: '5,234 kB' },
  { name: 'g++', version: '4:11.2.0-1ubuntu1', description: 'GNU C++ compiler', installed: false, size: '5,678 kB' },
  { name: 'make', version: '4.3-4.1build1', description: 'utility for directing compilation', installed: false, size: '456 kB' },
  { name: 'openssh-server', version: '1:8.9p1-3ubuntu0.1', description: 'secure shell (SSH) server', installed: true, size: '1,234 kB' },
  { name: 'fail2ban', version: '0.11.2-6', description: 'ban hosts that cause multiple authentication errors', installed: false, size: '456 kB' },
  { name: 'ufw', version: '0.36.1-4build1', description: 'program for managing a Netfilter firewall', installed: true, size: '178 kB' },
  { name: 'tmux', version: '3.2a-4build1', description: 'terminal multiplexer', installed: false, size: '456 kB' },
  { name: 'screen', version: '4.9.0-1', description: 'terminal multiplexer with VT100/ANSI terminal emulation', installed: false, size: '892 kB' },
  { name: 'zip', version: '3.0-12build2', description: 'Archiver for .zip files', installed: true, size: '234 kB' },
  { name: 'unzip', version: '6.0-26ubuntu3', description: 'De-archiver for .zip files', installed: true, size: '178 kB' },
  { name: 'rsync', version: '3.2.3-8ubuntu3.1', description: 'fast, versatile, remote (and local) file-copying tool', installed: true, size: '456 kB' },
  { name: 'neofetch', version: '7.1.0-4', description: 'Shows Linux System Information with Distribution Logo', installed: false, size: '128 kB' },
  { name: 'cmatrix', version: '2.0-3', description: 'simulates the display from "The Matrix"', installed: false, size: '32 kB' },
  { name: 'cowsay', version: '3.03+dfsg2-8', description: 'configurable talking cow', installed: false, size: '24 kB' },
  { name: 'fortune', version: '1:1.99.1-7build1', description: 'provides fortune cookies on demand', installed: false, size: '2,345 kB' },
  { name: 'sl', version: '5.02-1build1', description: 'Correct you if you type sl by mistake', installed: false, size: '24 kB' },
];

export class PackageManager {
  private packages: Map<string, Package>;
  private lastUpdate: Date | null = null;

  constructor() {
    this.packages = new Map();
    availablePackages.forEach(pkg => this.packages.set(pkg.name, { ...pkg }));
  }

  update(): string {
    this.lastUpdate = new Date();
    const lines = [
      'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease',
      'Hit:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease',
      'Hit:3 http://archive.ubuntu.com/ubuntu jammy-backports InRelease',
      'Hit:4 http://security.ubuntu.com/ubuntu jammy-security InRelease',
      'Reading package lists... Done',
      'Building dependency tree... Done',
      'Reading state information... Done',
      `${this.packages.size} packages can be upgraded. Run 'apt list --upgradable' to see them.`,
    ];
    return lines.join('\n');
  }

  upgrade(): string {
    const upgradable = Array.from(this.packages.values()).filter(p => p.installed).slice(0, 5);
    const lines = [
      'Reading package lists... Done',
      'Building dependency tree... Done',
      'Calculating upgrade... Done',
      `The following packages will be upgraded:`,
      `  ${upgradable.map(p => p.name).join(' ')}`,
      `${upgradable.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`,
      'Need to get 0 B/0 B of archives.',
      'After this operation, 0 B of additional disk space will be used.',
    ];
    upgradable.forEach(pkg => {
      lines.push(`Setting up ${pkg.name} (${pkg.version}) ...`);
    });
    return lines.join('\n');
  }

  install(packageNames: string[]): string {
    const lines: string[] = ['Reading package lists... Done', 'Building dependency tree... Done'];
    const toInstall: Package[] = [];
    const notFound: string[] = [];
    const alreadyInstalled: string[] = [];

    packageNames.forEach(name => {
      const pkg = this.packages.get(name);
      if (!pkg) {
        notFound.push(name);
      } else if (pkg.installed) {
        alreadyInstalled.push(name);
      } else {
        toInstall.push(pkg);
      }
    });

    if (notFound.length > 0) {
      lines.push(`E: Unable to locate package ${notFound.join(', ')}`);
      return lines.join('\n');
    }

    if (alreadyInstalled.length > 0) {
      lines.push(`${alreadyInstalled.join(', ')} is already the newest version.`);
    }

    if (toInstall.length > 0) {
      lines.push('The following NEW packages will be installed:');
      lines.push(`  ${toInstall.map(p => p.name).join(' ')}`);
      const totalSize = toInstall.reduce((acc, p) => acc + parseInt(p.size.replace(/[^0-9]/g, '')), 0);
      lines.push(`0 upgraded, ${toInstall.length} newly installed, 0 to remove and 0 not upgraded.`);
      lines.push(`Need to get ${totalSize} kB of archives.`);
      lines.push(`After this operation, ${totalSize * 3} kB of additional disk space will be used.`);

      toInstall.forEach(pkg => {
        pkg.installed = true;
        lines.push(`Get:1 http://archive.ubuntu.com/ubuntu jammy/main amd64 ${pkg.name} amd64 ${pkg.version} [${pkg.size}]`);
      });

      lines.push('Fetched ' + totalSize + ' kB in 2s (500 kB/s)');
      lines.push('Selecting previously unselected packages.');

      toInstall.forEach(pkg => {
        lines.push(`Preparing to unpack .../${pkg.name}_${pkg.version}_amd64.deb ...`);
        lines.push(`Unpacking ${pkg.name} (${pkg.version}) ...`);
        lines.push(`Setting up ${pkg.name} (${pkg.version}) ...`);
      });

      lines.push('Processing triggers for man-db ...');
    }

    return lines.join('\n');
  }

  remove(packageNames: string[]): string {
    const lines: string[] = ['Reading package lists... Done', 'Building dependency tree... Done'];
    const toRemove: Package[] = [];
    const notInstalled: string[] = [];

    packageNames.forEach(name => {
      const pkg = this.packages.get(name);
      if (!pkg || !pkg.installed) {
        notInstalled.push(name);
      } else {
        toRemove.push(pkg);
      }
    });

    if (notInstalled.length > 0 && toRemove.length === 0) {
      lines.push(`Package '${notInstalled.join(', ')}' is not installed, so not removed`);
      return lines.join('\n');
    }

    if (toRemove.length > 0) {
      lines.push('The following packages will be REMOVED:');
      lines.push(`  ${toRemove.map(p => p.name).join(' ')}`);
      lines.push(`0 upgraded, 0 newly installed, ${toRemove.length} to remove and 0 not upgraded.`);

      toRemove.forEach(pkg => {
        pkg.installed = false;
        lines.push(`Removing ${pkg.name} (${pkg.version}) ...`);
      });

      lines.push('Processing triggers for man-db ...');
    }

    return lines.join('\n');
  }

  search(query: string): string {
    const results = Array.from(this.packages.values()).filter(
      pkg => pkg.name.includes(query) || pkg.description.toLowerCase().includes(query.toLowerCase())
    );

    if (results.length === 0) {
      return '';
    }

    return results.map(pkg => {
      const status = pkg.installed ? '[installed]' : '';
      return `${pkg.name}/${pkg.version} ${status}\n  ${pkg.description}`;
    }).join('\n\n');
  }

  list(options: { installed?: boolean; upgradable?: boolean } = {}): string {
    let packages = Array.from(this.packages.values());

    if (options.installed) {
      packages = packages.filter(p => p.installed);
    }

    if (packages.length === 0) {
      return 'Listing... Done';
    }

    const lines = ['Listing... Done'];
    packages.forEach(pkg => {
      const status = pkg.installed ? '[installed]' : '';
      lines.push(`${pkg.name}/${pkg.version} amd64 ${status}`);
    });

    return lines.join('\n');
  }

  show(packageName: string): string {
    const pkg = this.packages.get(packageName);
    if (!pkg) {
      return `E: No packages found`;
    }

    return [
      `Package: ${pkg.name}`,
      `Version: ${pkg.version}`,
      `Priority: optional`,
      `Section: utils`,
      `Maintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>`,
      `Installed-Size: ${pkg.size}`,
      `Download-Size: ${pkg.size}`,
      `APT-Manual-Installed: yes`,
      `Description: ${pkg.description}`,
    ].join('\n');
  }

  isInstalled(packageName: string): boolean {
    const pkg = this.packages.get(packageName);
    return pkg?.installed || false;
  }
}

export const packageManager = new PackageManager();
