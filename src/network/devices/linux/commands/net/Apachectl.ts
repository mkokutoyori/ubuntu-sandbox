/**
 * docs/PRD-Manquements.md §M4a — `apachectl` / `apache2ctl`.
 *
 * On Debian both names are the SAME file (`apachectl` is a link to
 * `apache2ctl`), so one command serves both: two implementations would
 * eventually contradict each other, which is what this repository keeps
 * undoing elsewhere.
 *
 * `start`/`stop`/`restart`/`graceful` go through the service manager
 * rather than around it. That is a deliberate divergence from real Ubuntu,
 * where `apachectl start` starts httpd behind systemd's back and leaves
 * `systemctl status apache2` reading `inactive` while the server listens.
 * Reproducing that inconsistency would mostly teach distrust of the
 * simulator; here both views answer the same because they read the same
 * service. The unit itself declares
 * `ExecStart=/usr/sbin/apachectl start`, which makes the loop honest — it
 * really is the same gesture on both sides.
 *
 * `configtest`, `-S`, `-M`, `-l`, `-v`, `-V` read the real configuration.
 * `-M` in particular lists `mods-enabled/`: `a2enmod` is only an `ln -s`,
 * so a link made by hand has to show up.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import {
  parseApacheConfig, apacheWarnings, selectVirtualHost,
} from '../../http/apache/ApacheConfig';
import {
  APACHE_VERSION, APACHE_CTL, APACHE_BUILD_DATE, APACHE_PORTS_PATH,
  APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH, APACHE_ERROR_LOG,
  APACHE_MODS_ENABLED, APACHE_STATIC_MODULES,
} from '../../http/apache/ApacheFiles';

const UNIT = 'apache2';

interface Outcome { output: string; exitCode: number }

function fileSource(ctx: LinuxCommandContext) {
  const vfs = ctx.executor.vfs;
  return {
    read: (path: string) => vfs.readFile(path),
    list: (dir: string) => vfs.listDirectory(dir)?.map((e) => e.name) ?? null,
  };
}

function readConfig(ctx: LinuxCommandContext) {
  return parseApacheConfig(
    fileSource(ctx), APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
  );
}

function configtest(ctx: LinuxCommandContext): Outcome {
  const { config, error } = readConfig(ctx);
  if (error) return { output: error.message, exitCode: 1 };
  return { output: [...apacheWarnings(config), 'Syntax OK'].join('\n'), exitCode: 0 };
}

/**
 * `apachectl -S`: the virtual-host map, the one you read to work out which
 * host answers. The `is a NameVirtualHost` line only appears when a port
 * carries several, as on a real machine.
 */
function dumpVhosts(ctx: LinuxCommandContext): Outcome {
  const { config, error } = readConfig(ctx);
  if (error) return { output: error.message, exitCode: 1 };

  const lines = ['VirtualHost configuration:'];
  const ports = [...new Set(config.vhosts.map((v) => v.port))].sort((a, b) => a - b);
  if (ports.length === 0) lines.push('');
  for (const port of ports) {
    const onThisPort = config.vhosts.filter((v) => v.port === port);
    const fallback = selectVirtualHost(config, port, '');
    const header = `*:${port}`.padEnd(23);
    if (onThisPort.length > 1) {
      lines.push(`${header}is a NameVirtualHost`);
      lines.push(`         default server ${fallback?.serverName ?? 'localhost'} `
        + `(${fallback?.source}:1)`);
      for (const v of onThisPort) {
        lines.push(`         port ${port} namevhost ${v.serverName ?? 'localhost'} `
          + `(${v.source}:1)`);
      }
    } else {
      lines.push(`${header}${onThisPort[0].serverName ?? 'localhost'} (${onThisPort[0].source}:1)`);
    }
  }

  const root = config.vhosts[0]?.documentRoot ?? '/var/www/html';
  lines.push(
    'ServerRoot: "/etc/apache2"',
    `Main DocumentRoot: "${root}"`,
    `Main ErrorLog: "${APACHE_ERROR_LOG}"`,
    'Mutex default: dir="/var/run/apache2/" mechanism=default',
    'PidFile: "/var/run/apache2/apache2.pid"',
    'User: name="www-data" id=33',
    'Group: name="www-data" id=33',
  );
  return { output: lines.join('\n'), exitCode: 0 };
}

function loadedModules(ctx: LinuxCommandContext): Outcome {
  const lines = ['Loaded Modules:'];
  for (const staticModule of APACHE_STATIC_MODULES) {
    lines.push(` ${staticModule.replace(/^mod_/, '').replace(/\.c$/, '')}_module (static)`);
  }
  const enabled = (ctx.executor.vfs.listDirectory(APACHE_MODS_ENABLED) ?? [])
    .map((e) => e.name)
    .filter((n) => n.endsWith('.load'))
    .sort();
  for (const file of enabled) {
    const text = ctx.executor.vfs.readFile(`${APACHE_MODS_ENABLED}/${file}`) ?? '';
    const m = /^\s*LoadModule\s+(\S+)/m.exec(text);
    // The name comes from the file itself, not from the link's name: it is
    // `LoadModule` that names the module, and renaming a link does not
    // change what Apache loads.
    lines.push(` ${m ? m[1] : file.replace(/\.load$/, '_module')} (shared)`);
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function compiledInModules(): Outcome {
  return {
    output: ['Compiled in modules:', ...APACHE_STATIC_MODULES.map((m) => `  ${m}`)].join('\n'),
    exitCode: 0,
  };
}

function shortVersion(): string {
  return [
    `Server version: Apache/${APACHE_VERSION} (Ubuntu)`,
    `Server built:   ${APACHE_BUILD_DATE}`,
  ].join('\n');
}

function longVersion(): Outcome {
  return {
    output: [
      shortVersion(),
      "Server's Module Magic Number: 20120211:121",
      'Server loaded:  APR 1.7.0, APR-UTIL 1.6.1',
      'Compiled using: APR 1.7.0, APR-UTIL 1.6.1',
      'Architecture:   64-bit',
      'Server MPM:     event',
      '  threaded:     yes (fixed thread count)',
      '    forked:     yes (variable process count)',
      'Server compiled with....',
      ' -D APR_HAS_SENDFILE',
      ' -D APR_HAS_MMAP',
      ' -D APR_HAVE_IPV6 (IPv4-mapped addresses enabled)',
      ' -D APR_USE_SYSVSEM_SERIALIZE',
      ' -D APR_USE_PTHREAD_SERIALIZE',
      ' -D SINGLE_LISTEN_UNSERIALIZED_ACCEPT',
      ' -D APR_HAS_OTHER_CHILD',
      ' -D AP_HAVE_RELIABLE_PIPED_LOGS',
      ' -D DYNAMIC_MODULE_LIMIT=256',
      ' -D HTTPD_ROOT="/etc/apache2"',
      ' -D SUEXEC_BIN="/usr/lib/apache2/suexec"',
      ' -D DEFAULT_PIDLOG="/var/run/apache2.pid"',
      ' -D DEFAULT_ERRORLOG="logs/error_log"',
      ' -D AP_TYPES_CONFIG_FILE="mime.types"',
      ' -D SERVER_CONFIG_FILE="apache2.conf"',
    ].join('\n'),
    exitCode: 0,
  };
}

function apachePid(ctx: LinuxCommandContext): number | undefined {
  return ctx.executor.serviceMgr.list().find((u) => u.name === UNIT)?.mainPid;
}

function lifecycle(ctx: LinuxCommandContext, action: string): Outcome {
  const mgr = ctx.executor.serviceMgr;
  const running = mgr.isActive(UNIT);

  if (action === 'start') {
    if (running) {
      return { output: `httpd (pid ${apachePid(ctx) ?? 1}) already running`, exitCode: 0 };
    }
    const r = mgr.start(UNIT);
    // A failed start is already written to `error.log` by the
    // configuration check; `apachectl` echoes the same text rather than a
    // second message saying something else.
    return r.ok ? { output: '', exitCode: 0 } : { output: r.error ?? 'apache2: failed', exitCode: 1 };
  }

  if (action === 'stop' || action === 'graceful-stop') {
    if (!running) return { output: 'httpd (no pid file) not running', exitCode: 1 };
    const r = mgr.stop(UNIT);
    return r.ok ? { output: '', exitCode: 0 } : { output: r.error ?? 'apache2: failed', exitCode: 1 };
  }

  // Both `restart` and `graceful` start the server when it is stopped,
  // like the real ones; the difference is that `graceful` keeps the open
  // listeners when it is already running.
  const test = configtest(ctx);
  if (test.exitCode !== 0) {
    const verb = action === 'restart' ? 'restarting' : 'reloading';
    return { output: `${test.output}\napache2: not ${verb}, configuration test failed`, exitCode: 1 };
  }
  const r = !running
    ? mgr.start(UNIT)
    : (action === 'restart' ? mgr.restart(UNIT) : mgr.reload(UNIT));
  return r.ok ? { output: '', exitCode: 0 } : { output: r.error ?? 'apache2: failed', exitCode: 1 };
}

const USAGE = [
  `Usage: ${APACHE_CTL} [-D name] [-d directory] [-f file]`,
  '                     [-C "directive"] [-c "directive"]',
  '                     [-k start|restart|graceful|graceful-stop|stop]',
  '                     [-v] [-V] [-h] [-l] [-L] [-t] [-T] [-S] [-X]',
  'Options:',
  '  -D name            : define a name for use in <IfDefine name> directives',
  '  -d directory       : specify an alternate initial ServerRoot',
  '  -f file            : specify an alternate ServerConfigFile',
  '  -k start|restart|graceful|graceful-stop|stop',
  '  -v                 : show version number',
  '  -V                 : show compile settings',
  '  -h                 : list available command line options (this page)',
  '  -l                 : list compiled in modules',
  '  -M                 : a synonym for -t -D DUMP_MODULES',
  '  -S                 : a synonym for -t -D DUMP_VHOSTS',
  '  -t                 : run syntax check for config files',
].join('\n');

const ACTIONS = ['start', 'stop', 'restart', 'graceful', 'graceful-stop'];

export const apachectlCommand: LinuxCommand = {
  name: 'apachectl',
  aliases: ['apache2ctl'],
  needsNetworkContext: true,
  binaryPath: APACHE_CTL,
  complete: makeArgCompleter({
    flags: ['-t', '-S', '-M', '-l', '-v', '-V', '-h', '-k'],
    firstWords: [...ACTIONS, 'configtest', 'status', 'fullstatus'],
    wordsAfter: { '-k': ACTIONS },
  }),
  manSection: 8,
  usage: 'apachectl [ -k start|restart|graceful|graceful-stop|stop ] [ options ]',
  help: 'Apache HTTP Server control interface.',
  options: [
    { flag: '-t', description: 'Run a configuration file syntax test.' },
    { flag: '-S', description: 'Show the parsed virtual host settings.' },
    { flag: '-M', description: 'Show the loaded modules.' },
    { flag: '-l', description: 'List modules compiled into the server.' },
    { flag: '-v', description: 'Print the version and exit.' },
    { flag: '-V', description: 'Print the version and build parameters.' },
    { flag: '-k', description: 'Send a command to the server.', takesArg: true, argName: 'action' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): Outcome {
    if (args.includes('-h') || args.includes('--help')) return { output: USAGE, exitCode: 0 };
    if (args.includes('-v')) return { output: shortVersion(), exitCode: 0 };
    if (args.includes('-V')) return longVersion();
    if (args.includes('-l')) return compiledInModules();
    if (args.includes('-M') || args.includes('DUMP_MODULES')) return loadedModules(ctx);
    if (args.includes('-S') || args.includes('DUMP_VHOSTS')) return dumpVhosts(ctx);
    if (args.includes('-t') || args.includes('configtest')) return configtest(ctx);

    const kIndex = args.indexOf('-k');
    const action = kIndex !== -1 ? args[kIndex + 1] : args.find((a) => ACTIONS.includes(a));
    if (action && ACTIONS.includes(action)) return lifecycle(ctx, action);

    if (args.includes('status') || args.includes('fullstatus')) {
      // The real apachectl hands this to a text browser, absent from this
      // image as from most server installs.
      return {
        output: '/usr/sbin/apachectl: 113: www-browser: not found\n'
          + '/usr/sbin/apachectl: 113: lynx: not found\n'
          + 'Error: The "status" option requires a text browser (lynx or www-browser).',
        exitCode: 2,
      };
    }

    if (args.length === 0) return { output: USAGE, exitCode: 1 };
    // Debian passes what it does not know to `apache2` itself, so the
    // refusal is the server's rather than the script's.
    const unknown = args[0];
    return {
      output: unknown.startsWith('-')
        ? `apache2: invalid option -- '${unknown.replace(/^-+/, '').charAt(0)}'\n${USAGE}`
        : USAGE,
      exitCode: 1,
    };
  },
};
