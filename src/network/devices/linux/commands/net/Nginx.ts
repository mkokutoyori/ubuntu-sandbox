import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { parseNginxConfig, validateNginxConfig, type NginxFileSource } from '../../http/nginx/NginxConfig';
import { NGINX_CONF_PATH, NGINX_VERSION, NGINX_BINARY } from '../../http/nginx/NginxFiles';

function fileSource(ctx: LinuxCommandContext): NginxFileSource {
  const vfs = ctx.executor.vfs;
  return {
    read: (path) => vfs.readFile(path),
    list: (dir) => vfs.listDirectory(dir)?.map((e) => e.name) ?? null,
  };
}

function testConfig(ctx: LinuxCommandContext): { output: string; exitCode: number } {
  const parsed = parseNginxConfig(fileSource(ctx));
  // `nginx -t` et le démon doivent juger le même fichier de la même façon :
  // une commande qui dit « syntax is ok » sur une configuration que
  // `systemctl start` refuse serait pire que pas de commande du tout.
  const syntax = parsed.ok === false ? parsed.error : validateNginxConfig(parsed.tree);
  // The real `nginx -t` reads `ssl_certificate` as well: a configuration
  // pointing at an unreadable certificate FAILS the test rather than
  // passing and failing at start-up.
  const tls = syntax ? null : ctx.executor.nginxService?.tlsProblem() ?? null;
  const failure = syntax ?? (tls ? { message: tls } : null);
  if (failure) {
    return {
      output: `${failure.message}\nnginx: configuration file ${NGINX_CONF_PATH} test failed`,
      exitCode: 1,
    };
  }
  return {
    output: [
      `nginx: the configuration file ${NGINX_CONF_PATH} syntax is ok`,
      `nginx: configuration file ${NGINX_CONF_PATH} test is successful`,
    ].join('\n'),
    exitCode: 0,
  };
}

function dumpConfig(ctx: LinuxCommandContext): { output: string; exitCode: number } {
  const test = testConfig(ctx);
  if (test.exitCode !== 0) return test;
  const vfs = ctx.executor.vfs;
  const seen = new Set<string>();
  const chunks: string[] = [test.output];

  const emit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = vfs.readFile(path);
    if (text === null) return;
    chunks.push(`# configuration file ${path}:\n${text}`);
    for (const m of text.matchAll(/^\s*include\s+(\S+?);/gm)) {
      const pattern = m[1];
      if (!pattern.includes('*')) { emit(pattern); continue; }
      const slash = pattern.lastIndexOf('/');
      const dir = pattern.slice(0, slash) || '/';
      const glob = pattern.slice(slash + 1);
      const rx = new RegExp('^' + glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      for (const entry of (vfs.listDirectory(dir) ?? []).map((e) => e.name).sort()) {
        if (rx.test(entry)) emit(`${dir}/${entry}`);
      }
    }
  };

  emit(NGINX_CONF_PATH);
  return { output: chunks.join('\n'), exitCode: 0 };
}

function signal(ctx: LinuxCommandContext, name: string): { output: string; exitCode: number } {
  const service = ctx.executor.nginxService;
  if (!service) {
    return { output: `nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)`, exitCode: 1 };
  }
  if (name === 'reload') {
    const error = service.reload();
    return error ? { output: error, exitCode: 1 } : { output: '', exitCode: 0 };
  }
  if (name === 'stop' || name === 'quit') {
    service.stopAll();
    return { output: '', exitCode: 0 };
  }
  if (name === 'reopen') return { output: '', exitCode: 0 };
  return { output: `nginx: invalid option: "-s ${name}"`, exitCode: 1 };
}

export const nginxCommand: LinuxCommand = {
  name: 'nginx',
  package: 'nginx',
  needsNetworkContext: true,
  binaryPath: NGINX_BINARY,
  complete: makeArgCompleter({ flags: ['-t', '-T', '-v', '-V', '-s', '-c', '-h'] }),
  manSection: 8,
  usage: 'nginx [-?hvVtTq] [-s signal] [-c filename]',
  help: 'High performance web server and reverse proxy.',
  options: [
    { flag: '-t', description: 'Test the configuration and exit.' },
    { flag: '-T', description: 'Test the configuration, then dump it and exit.' },
    { flag: '-v', description: 'Print the version and exit.' },
    { flag: '-V', description: 'Print the version and configure options.' },
    { flag: '-s', description: 'Send a signal to the master process.', takesArg: true, argName: 'signal' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    if (args.includes('-t')) return testConfig(ctx);
    if (args.includes('-T')) return dumpConfig(ctx);
    if (args.includes('-v')) return { output: `nginx version: nginx/${NGINX_VERSION}`, exitCode: 0 };
    if (args.includes('-V')) {
      return {
        output: [
          `nginx version: nginx/${NGINX_VERSION}`,
          'built with OpenSSL 3.0.13',
          "configure arguments: --prefix=/usr/share/nginx --conf-path=/etc/nginx/nginx.conf",
        ].join('\n'),
        exitCode: 0,
      };
    }
    const sIndex = args.indexOf('-s');
    if (sIndex !== -1) {
      const which = args[sIndex + 1];
      if (!which) return { output: 'nginx: option "-s" requires parameter', exitCode: 1 };
      return signal(ctx, which);
    }
    if (args.includes('-h') || args.includes('-?')) {
      return {
        output: [
          `nginx version: nginx/${NGINX_VERSION}`,
          'Usage: nginx [-?hvVtTq] [-s signal] [-c filename]',
          '',
          'Options:',
          '  -?,-h         : this help',
          '  -v            : show version and exit',
          '  -V            : show version and configure options then exit',
          '  -t            : test configuration and exit',
          '  -T            : test configuration, dump it and exit',
          '  -s signal     : send signal to a master process: stop, quit, reopen, reload',
        ].join('\n'),
        exitCode: 0,
      };
    }
    // Sans option, nginx démarre le démon. C'est `systemctl` qui pilote le
    // cycle de vie ici, et le refus le dit plutôt que de faire semblant.
    return {
      output: 'nginx: [emerg] still could not bind() — use `systemctl start nginx` to run the daemon',
      exitCode: 1,
    };
  },
};
