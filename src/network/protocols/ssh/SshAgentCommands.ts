import type { SshAgent, SshAgentKeyReader } from './SshAgent';
import type { SshKeygenOutcome } from './SshKeygenCommand';

export interface SshAgentHost {
  readonly agent: SshAgent;
  readonly reader: SshAgentKeyReader;
  readonly separator: string;
  readonly sshDir: string;
  readonly authSocket: string;
  setEnvironment(name: string, value: string): void;
}

const AGENT_PID = 1;

export function runSshAgentCommand(
  args: readonly string[],
  host: SshAgentHost,
): SshKeygenOutcome {
  if (args.includes('-k')) {
    host.agent.removeAll();
    return { output: `echo Agent pid ${AGENT_PID} killed;`, exitCode: 0 };
  }
  const lines = args.includes('-c')
    ? [
        `setenv SSH_AUTH_SOCK ${host.authSocket};`,
        `setenv SSH_AGENT_PID ${AGENT_PID};`,
        `echo Agent pid ${AGENT_PID};`,
      ]
    : [
        `SSH_AUTH_SOCK=${host.authSocket}; export SSH_AUTH_SOCK;`,
        `SSH_AGENT_PID=${AGENT_PID}; export SSH_AGENT_PID;`,
        `echo Agent pid ${AGENT_PID};`,
      ];
  host.setEnvironment('SSH_AUTH_SOCK', host.authSocket);
  host.setEnvironment('SSH_AGENT_PID', String(AGENT_PID));
  return { output: lines.join('\n'), exitCode: 0 };
}

export function runSshAddCommand(
  args: readonly string[],
  host: SshAgentHost,
): SshKeygenOutcome {
  if (args.includes('-D')) {
    host.agent.removeAll();
    return { output: 'All identities removed.', exitCode: 0 };
  }

  const dIdx = args.indexOf('-d');
  if (dIdx >= 0) {
    const path =
      args[dIdx + 1] && !args[dIdx + 1].startsWith('-')
        ? args[dIdx + 1]
        : [host.sshDir, 'id_ed25519'].join(host.separator);
    return host.agent.remove(path)
      ? { output: `Identity removed: ${path}`, exitCode: 0 }
      : { output: 'Could not remove identity: not loaded', exitCode: 1 };
  }

  if (args.includes('-l') || args.includes('-L')) {
    const keys = host.agent.list();
    if (keys.length === 0) {
      return { output: 'The agent has no identities.', exitCode: 1 };
    }
    const lines = args.includes('-l')
      ? keys.map(k => `${k.bits} ${k.fingerprint} ${k.comment} (${k.algorithm})`)
      : keys.map(k => k.publicKey ?? `${k.algorithm.toLowerCase()} ${k.comment}`);
    return { output: lines.join('\n'), exitCode: 0 };
  }

  const announce = (path: string): string => {
    const loaded = host.agent.list().find(k => k.path === path);
    return `Identity added: ${path} (${loaded?.comment ?? path})`;
  };

  const explicit = args.filter(a => !a.startsWith('-'));
  if (explicit.length > 0) {
    const lines: string[] = [];
    let anyFailed = false;
    for (const path of explicit) {
      if (host.agent.add(path, host.reader)) {
        lines.push(announce(path));
      } else {
        lines.push(`Could not open key file ${path}: No such file or directory`);
        anyFailed = true;
      }
    }
    return { output: lines.join('\n'), exitCode: anyFailed ? 1 : 0 };
  }

  const added = host.agent.addAllFrom(host.sshDir, host.separator, host.reader);
  if (added.length === 0) {
    return {
      output: 'Could not open a connection to your authentication agent.',
      exitCode: 2,
    };
  }
  return { output: added.map(announce).join('\n'), exitCode: 0 };
}
