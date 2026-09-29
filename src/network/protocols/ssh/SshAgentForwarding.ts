/**
 * SshAgentForwarding — OpenSSH `ssh -A` plumbing.
 *
 * Connects the local device's `SshAgent` to the remote device's
 * `SshAgent` so commands run on the remote (e.g. `ssh-add -l`,
 * subsequent `ssh` from the remote) see the client's keys.
 *
 * Real OpenSSH multiplexes the agent protocol over a dedicated channel;
 * here we just shadow-copy the AgentKey records and remember which ones
 * were injected so `detach()` removes only what it added.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 advanced features.
 */

import type { SshAgent } from './SshAgent';

export class SshAgentForwarding {
  private attached = false;
  private installed: string[] = [];

  constructor(
    private readonly local: SshAgent,
    private readonly remote: SshAgent,
  ) {}

  /**
   * Copy every key currently in the local agent into the remote agent.
   * Idempotent — calling it twice is a no-op. Pre-existing keys on the
   * remote agent are preserved.
   */
  attach(): void {
    if (this.attached) return;
    for (const key of this.local.list()) {
      if (this.remote.holds(key.blob)) continue;
      this.remote.install(key);
      this.installed.push(key.blob);
    }
    this.attached = true;
  }

  /**
   * Remove only the keys this forwarding installed — keys the remote
   * already had survive (parity with OpenSSH closing an agent channel).
   */
  detach(): void {
    if (!this.attached) return;
    for (const blob of this.installed) this.remote.removeKey(blob);
    this.installed = [];
    this.attached = false;
  }
}
