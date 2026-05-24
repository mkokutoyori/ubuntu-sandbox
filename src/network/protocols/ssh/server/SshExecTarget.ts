/**
 * SshExecTarget — synchronous, polymorphic SSH exec contract for
 * heterogeneous targets.
 *
 * Background. The Linux SSH client (`LinuxSshClient.runSshClient`) is
 * intentionally synchronous so it fits inside the sync
 * `LinuxCommandExecutor.execute()` pipeline. Linux→Linux SSH works
 * because the client takes a shortcut: it locates the peer's
 * `LinuxMachine` instance via the EquipmentRegistry and calls
 * `machine.executor.execute(cmd)` directly — bypassing the SSH
 * protocol stack.
 *
 * For Linux→Windows, Linux→Cisco or Linux→Huawei to work through the
 * same sync pipeline the target device must offer a sync equivalent.
 * Async per-device CLIs (Windows PowerShell, Cisco IOS, Huawei VRP)
 * can't be awaited from a sync caller, so the contract defined here
 * is intentionally narrow: handle a *curated* set of common SSH-exec
 * commands by reading the device's reactive state — hostname, banner,
 * platform identification, current user, simple `echo`, etc. — and
 * return `null` when the command is beyond the sync surface. Callers
 * fall back to whatever async pathway is appropriate.
 *
 * Domain notion. In a real network an SSH server is just an inbound
 * service on tcp/22 backed by the host's identity and accounts. The
 * interface therefore carries every attribute a real `sshd` exposes:
 *
 *   - host key (fingerprint, type),
 *   - banner / pre-auth message,
 *   - MOTD,
 *   - sshd_config-style policy summary,
 *   - account directory (read-only view).
 *
 * Unused fields are kept on purpose: a later iteration (key auth,
 * banner negotiation, MaxAuthTries surfacing in audit events, …) will
 * consume them without reshaping the interface.
 */

import type { IEventBus } from '@/events/EventBus';

/** Result of a synchronous SSH exec on this target. */
export interface SshExecResult {
  output: string;
  exitCode: number;
}

/** Reason a login attempt was accepted or refused. */
export interface SshLoginDecision {
  ok: boolean;
  reason?: string;
}

/** Authentication method that was negotiated for a session. */
export type SshAuthMethod = 'password' | 'publickey' | 'keyboard-interactive';

/** Frozen view of an inbound SSH-server policy. */
export interface SshPolicySnapshot {
  /** Service running? */
  readonly active: boolean;
  /** Listening ports (`Port` directives, defaults to [22]). */
  readonly ports: readonly number[];
  /** True when root may log in over SSH at all. */
  readonly permitRootLogin: boolean;
  /** True when password authentication is enabled. */
  readonly passwordAuthentication: boolean;
  /** True when publickey authentication is enabled. */
  readonly pubkeyAuthentication: boolean;
  /** Maximum auth attempts before the connection is closed. */
  readonly maxAuthTries: number;
  /** True when empty passwords are permitted (default false). */
  readonly permitEmptyPasswords: boolean;
}

/** Host-key identity announced to clients during the handshake. */
export interface SshHostKeyInfo {
  readonly type: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
  readonly fingerprintSha256: string;
  /** OpenSSH-format public-key blob (`ssh-ed25519 AAAA…`). */
  readonly publicKey: string;
}

/**
 * Any device that can host an SSH server implements this interface so
 * the cross-platform client dispatch can talk to it uniformly. Concrete
 * implementations live close to their device class — LinuxMachine,
 * WindowsPC, CiscoRouter, HuaweiRouter.
 *
 * Methods marked `Sync` MUST never await — they are called from
 * synchronous SSH-client paths and return synchronously or return
 * `null` to mean "I cannot answer synchronously, defer to the async
 * path".
 */
export interface SshExecTarget {
  /** Device hostname as it would appear in a remote shell prompt. */
  getSshHostname(): string;

  /** Reactive bus the target publishes SSH lifecycle events on. */
  getSshEventBus?(): IEventBus;

  /** Whether sshd is currently accepting connections. */
  isSshActive(): boolean;

  /** Login policy decision for the candidate user. */
  sshdAcceptsLogin(user: string): SshLoginDecision;

  /** Audit-trail hook called once per connection (accepted or rejected). */
  recordSshLogin(
    user: string,
    fromIp: string,
    fromHost: string,
    accepted: boolean,
    method?: SshAuthMethod,
  ): void;

  /**
   * Run a curated, *synchronous* command on this target in exec mode.
   * Return `null` when the command is outside the sync surface so the
   * caller knows to fall back to the async pathway.
   */
  runSshCommandSync(user: string, command: string): SshExecResult | null;

  /** Pre-auth banner shown by sshd. */
  getSshBanner(): string;

  /** MOTD shown after a successful auth. */
  getSshMotd(): string;

  /** Read-only view of the inbound policy enforced by sshd. */
  getSshPolicy(): SshPolicySnapshot;

  /** Stable host-key identity used by `~/.ssh/known_hosts`. */
  getSshHostKey(): SshHostKeyInfo;
}

/** Type guard — true when the value behaves like an SshExecTarget. */
export function isSshExecTarget(value: unknown): value is SshExecTarget {
  return !!value
    && typeof (value as { runSshCommandSync?: unknown }).runSshCommandSync === 'function'
    && typeof (value as { isSshActive?: unknown }).isSshActive === 'function'
    && typeof (value as { sshdAcceptsLogin?: unknown }).sshdAcceptsLogin === 'function';
}
