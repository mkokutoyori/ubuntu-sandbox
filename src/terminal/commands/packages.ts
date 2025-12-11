import { CommandRegistry } from './index';

export const packageCommands: CommandRegistry = {
  apt: (args, state, fs, pm) => {
    if (args.length === 0) {
      return {
        output: `apt 2.4.10 (amd64)
Usage: apt [options] command

Most used commands:
  list - list packages based on package names
  search - search in package descriptions
  show - show package details
  install - install packages
  reinstall - reinstall packages
  remove - remove packages
  autoremove - Remove automatically all unused packages
  update - update list of available packages
  upgrade - upgrade the system by installing/upgrading packages
  full-upgrade - upgrade the system by removing/installing/upgrading packages
  edit-sources - edit the source information file
  satisfy - satisfy dependency strings`,
        exitCode: 0,
      };
    }

    const subcommand = args[0];
    const subargs = args.slice(1);

    // Check for sudo for commands that need it
    const needsSudo = ['install', 'remove', 'update', 'upgrade', 'autoremove', 'purge'];
    if (needsSudo.includes(subcommand) && state.currentUser !== 'root') {
      return {
        output: '',
        error: `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?`,
        exitCode: 100,
      };
    }

    switch (subcommand) {
      case 'update':
        return { output: pm.update(), exitCode: 0 };

      case 'upgrade':
        return { output: pm.upgrade(), exitCode: 0 };

      case 'install':
        if (subargs.length === 0) {
          return { output: '', error: 'E: Invalid operation install', exitCode: 100 };
        }
        return { output: pm.install(subargs.filter(a => !a.startsWith('-'))), exitCode: 0 };

      case 'remove':
      case 'purge':
        if (subargs.length === 0) {
          return { output: '', error: `E: Invalid operation ${subcommand}`, exitCode: 100 };
        }
        return { output: pm.remove(subargs.filter(a => !a.startsWith('-'))), exitCode: 0 };

      case 'autoremove':
        return {
          output: 'Reading package lists... Done\nBuilding dependency tree... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
          exitCode: 0,
        };

      case 'search':
        if (subargs.length === 0) {
          return { output: '', error: 'E: You must give at least one search pattern', exitCode: 1 };
        }
        return { output: pm.search(subargs[0]) || 'No packages found', exitCode: 0 };

      case 'show':
        if (subargs.length === 0) {
          return { output: '', error: 'E: You must give at least one package name', exitCode: 1 };
        }
        return { output: pm.show(subargs[0]), exitCode: 0 };

      case 'list':
        const installed = subargs.includes('--installed');
        const upgradable = subargs.includes('--upgradable');
        return { output: pm.list({ installed, upgradable }), exitCode: 0 };

      case 'clean':
        return { output: '', exitCode: 0 };

      case 'autoclean':
        return {
          output: 'Reading package lists... Done\nBuilding dependency tree... Done',
          exitCode: 0,
        };

      default:
        return { output: '', error: `E: Invalid operation ${subcommand}`, exitCode: 100 };
    }
  },

  'apt-get': (args, state, fs, pm) => {
    // apt-get is similar to apt, redirect to apt
    return packageCommands.apt(args, state, fs, pm);
  },

  'apt-cache': (args, state, fs, pm) => {
    if (args.length === 0) {
      return { output: '', error: 'apt-cache: missing arguments', exitCode: 1 };
    }

    const subcommand = args[0];
    const subargs = args.slice(1);

    switch (subcommand) {
      case 'search':
        if (subargs.length === 0) {
          return { output: '', error: 'E: You must give at least one search pattern', exitCode: 1 };
        }
        return { output: pm.search(subargs[0]) || '', exitCode: 0 };

      case 'show':
        if (subargs.length === 0) {
          return { output: '', error: 'E: You must give at least one package name', exitCode: 1 };
        }
        return { output: pm.show(subargs[0]), exitCode: 0 };

      case 'policy':
        if (subargs.length === 0) {
          return {
            output: 'Package files:\n 100 /var/lib/dpkg/status\n     release a=now',
            exitCode: 0,
          };
        }
        return { output: pm.show(subargs[0]), exitCode: 0 };

      default:
        return { output: '', error: `E: Invalid operation ${subcommand}`, exitCode: 100 };
    }
  },

  dpkg: (args, state, fs, pm) => {
    if (args.length === 0) {
      return {
        output: 'Usage: dpkg [option...] <command>',
        exitCode: 0,
      };
    }

    if (args[0] === '-l' || args[0] === '--list') {
      const output = [
        'Desired=Unknown/Install/Remove/Purge/Hold',
        '| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend',
        '|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)',
        '||/ Name           Version          Architecture Description',
        '+++-==============-================-============-=================================',
      ];

      const packages = pm.list({ installed: true }).split('\n').slice(1);
      packages.forEach(line => {
        if (line.trim()) {
          const [name] = line.split('/');
          output.push(`ii  ${name.padEnd(15)} 1.0.0            amd64        Package description`);
        }
      });

      return { output: output.join('\n'), exitCode: 0 };
    }

    if (args[0] === '-s' || args[0] === '--status') {
      if (args.length < 2) {
        return { output: '', error: 'dpkg-query: error: --status needs a valid package name', exitCode: 1 };
      }
      return { output: pm.show(args[1]), exitCode: 0 };
    }

    if (args[0] === '-L' || args[0] === '--listfiles') {
      if (args.length < 2) {
        return { output: '', error: 'dpkg-query: error: --listfiles needs a valid package name', exitCode: 1 };
      }
      return {
        output: `/usr/bin/${args[1]}\n/usr/share/doc/${args[1]}/README\n/usr/share/man/man1/${args[1]}.1.gz`,
        exitCode: 0,
      };
    }

    return { output: '', exitCode: 0 };
  },

  snap: (args) => {
    if (args.length === 0) {
      return {
        output: `Usage:
  snap [command]

Available Commands:
  find        Find packages
  info        Show detailed information about snaps
  install     Install snaps
  list        List installed snaps
  remove      Remove snaps`,
        exitCode: 0,
      };
    }

    switch (args[0]) {
      case 'list':
        return {
          output: 'Name     Version    Rev    Tracking       Publisher   Notes\ncore20   20231123   2105   latest/stable  canonical   base',
          exitCode: 0,
        };

      case 'info':
        if (args.length < 2) {
          return { output: '', error: 'error: the required argument `<snap>` was not provided', exitCode: 1 };
        }
        return {
          output: `name:      ${args[1]}\nsummary:   Package ${args[1]}\npublisher: example\nstore-url: https://snapcraft.io/${args[1]}\ncontact:   https://example.com\nlicense:   GPL-3.0`,
          exitCode: 0,
        };

      default:
        return { output: `error: unknown command "${args[0]}"`, exitCode: 1 };
    }
  },
};
