import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { validateSshdConfig } from '@/network/protocols/ssh/server/SshSshdConfig';

/**
 * `sshd -t [-f FILE]` / `sshd -T` — configuration self-test and effective-
 * config dump, as run by `systemctl reload ssh` before applying a change,
 * or interactively (including from an editor's `:!sshd -t -f %`).
 *
 * `-t` always re-reads the target file fresh from disk (real sshd tests
 * the file, not its running state). `-T` reports the daemon's live cached
 * config (`ctx.sshServerConfig()`) — it only changes after SIGHUP /
 * `systemctl reload ssh`, exactly like real sshd.
 */
export const sshdCommand: LinuxCommand = {
  name: 'sshd',
  package: 'openssh-server',
  needsNetworkContext: true,
  usage: 'sshd -t [-f config_file] | sshd -T',
  help: 'Test the sshd configuration file syntax (-t) or print the effective configuration (-T).',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return sshdRun(ctx, args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return Promise.resolve(sshdRun(ctx, args));
  },
};

function sshdRun(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  let configPath = '/etc/ssh/sshd_config';
  let testOnly = false;
  let dumpEffective = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f') { configPath = args[++i] ?? configPath; continue; }
    if (a === '-t') { testOnly = true; continue; }
    if (a === '-T') { dumpEffective = true; continue; }
  }

  if (testOnly) {
    const absPath = ctx.executor.vfs.normalizePath(configPath, ctx.executor.getCwd());
    const raw = ctx.executor.vfs.readFile(absPath);
    if (raw === null) {
      return { output: `sshd: no such file or directory: ${configPath}`, exitCode: 1 };
    }
    const verdict = validateSshdConfig(raw, absPath);
    return verdict.ok
      ? { output: '', exitCode: 0 }
      : { output: verdict.errors.join('\n'), exitCode: 1 };
  }

  if (dumpEffective) {
    const cfg = ctx.sshServerConfig();
    const lines = [
      `port ${cfg.ports[0] ?? 22}`,
      `permitrootlogin ${cfg.permitRootLogin}`,
      `passwordauthentication ${cfg.passwordAuthentication ? 'yes' : 'no'}`,
      `pubkeyauthentication ${cfg.pubkeyAuthentication ? 'yes' : 'no'}`,
      `kbdinteractiveauthentication ${cfg.kbdInteractiveAuthentication ? 'yes' : 'no'}`,
      `maxauthtries ${cfg.maxAuthTries}`,
      `maxsessions ${cfg.maxSessions}`,
      `x11forwarding ${cfg.x11Forwarding ? 'yes' : 'no'}`,
      `permitemptypasswords ${cfg.permitEmptyPasswords ? 'yes' : 'no'}`,
      `allowtcpforwarding ${cfg.allowTcpForwarding}`,
      `clientaliveinterval ${cfg.clientAliveIntervalSeconds}`,
      `clientalivecountmax ${cfg.clientAliveCountMax}`,
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  return { output: 'usage: sshd [-t | -T] [-f config_file]', exitCode: 1 };
}
