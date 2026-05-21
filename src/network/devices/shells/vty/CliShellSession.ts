/**
 * CliShellSession — One Cisco / Huawei vty session per terminal.
 *
 * Real Cisco IOS / Huawei VRP exposes one console + 5 vty lines (telnet/SSH)
 * by default. Each one is an independent shell context: its own privilege
 * level, its own current mode (`>`, `#`, `(config)#`, `(config-if)#`, …),
 * its own selected sub-mode context (interface, ACL, DHCP pool, route-map,
 * IPSec policy, etc.), its own `terminal length`, its own `terminal width`,
 * its own `show history` buffer. None of those leak across vty's.
 *
 * The simulator originally stored all of that on a single shell instance
 * (cf. terminal_gap.md §5.1). This class re-introduces the missing
 * per-session container; the shell snapshots/swaps it for the duration
 * of each command via the swap-and-restore pattern (same model as the
 * Linux fix in §2).
 *
 * Pure data class — no behaviour. The shell hosts the heavy machinery
 * (command tries, FSM transitions, repositories). The session is the
 * mutable state bag.
 */

let nextSessionSeq = 1;

/**
 * Structured snapshot of all mode-related fields. Keep this in sync with
 * the shell's snapshot/restore helpers — the fields enumerated here are
 * exactly the ones that must rotate on each command.
 *
 * Fields are typed `unknown` because Cisco and Huawei shells declare
 * incompatible enum sets for `mode` (`CiscoShellMode` vs `HuaweiShellMode`).
 * The shell decides what to store; the session is the carrier.
 */
export interface VtySnapshot {
  mode: unknown;
  // ── Selection context (sub-mode pointers) ─────────────────────────
  selectedInterface: string | null;
  selectedRoutingProto: unknown;
  selectedTrack: number | null;
  selectedIpSla: number | null;
  selectedRouteMap: unknown;
  selectedDHCPPool: string | null;
  selectedACL: string | null;
  selectedACLType: 'standard' | 'extended' | null;
  selectedISAKMPPriority: number | null;
  selectedTransformSet: string | null;
  selectedCryptoMap: string | null;
  selectedCryptoMapSeq: number | null;
  selectedCryptoMapIsDynamic: boolean;
  selectedIPSecProfile: string | null;
  selectedIKEv2Proposal: string | null;
  selectedIKEv2Policy: string | null;
  selectedIKEv2Keyring: string | null;
  selectedIKEv2KeyringPeer: string | null;
  selectedIKEv2Profile: string | null;
  // ── Per-vty exec preferences ──────────────────────────────────────
  /** `terminal length N` — 0 disables the pager for this session. */
  terminalLength: number;
  /** `terminal width N` — character width hint (default 80). */
  terminalWidth: number;
  /** Privilege level 0–15. 15 = enable. 1 = user. */
  privilegeLevel: number;
  /** `terminal history size N` — bounded ring length. */
  historySize: number;
  /** `show history` buffer. */
  cmdHistory: string[];
}

export interface CliShellSessionInit {
  /** Vendor — Cisco IOS uses 'user', Huawei VRP uses 'user-view'. */
  initialMode: unknown;
  /** Initial terminal length (24 is the IOS default). */
  initialLength?: number;
}

/**
 * Per-vty mutable state container. The shell holds a *pointer* to the
 * active session during execute() (set via begin/endVtySession) and
 * mirrors mutations back into it.
 */
export class CliShellSession {
  readonly id: string;

  // ── Identity ────────────────────────────────────────────────────
  /**
   * vty line identifier (vty 0 / vty 1 / …). Real Cisco IOS allocates
   * up to 5 lines by default; we don't enforce that cap here since
   * the simulator is meant for teaching, not capacity-planning.
   */
  readonly lineId: string;
  readonly openedAt: number = Date.now();

  // ── Mutable state — snapshot.ed by the shell on every exec ──────
  state: VtySnapshot;

  /** Whether the session has been disposed (close-on-exit / device removed). */
  disposed: boolean = false;

  constructor(init: CliShellSessionInit) {
    this.id = `vty-${nextSessionSeq++}`;
    this.lineId = `vty ${nextSessionSeq - 1}`;
    this.state = {
      mode: init.initialMode,
      selectedInterface: null,
      selectedRoutingProto: null,
      selectedTrack: null,
      selectedIpSla: null,
      selectedRouteMap: null,
      selectedDHCPPool: null,
      selectedACL: null,
      selectedACLType: null,
      selectedISAKMPPriority: null,
      selectedTransformSet: null,
      selectedCryptoMap: null,
      selectedCryptoMapSeq: null,
      selectedCryptoMapIsDynamic: false,
      selectedIPSecProfile: null,
      selectedIKEv2Proposal: null,
      selectedIKEv2Policy: null,
      selectedIKEv2Keyring: null,
      selectedIKEv2KeyringPeer: null,
      selectedIKEv2Profile: null,
      terminalLength: init.initialLength ?? 24,
      terminalWidth: 80,
      privilegeLevel: 1,
      historySize: 10,
      cmdHistory: [],
    };
  }

  dispose(): void { this.disposed = true; }
}
