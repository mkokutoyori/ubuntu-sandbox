/**
 * CLIStateMachine — Generic FSM for CLI mode transitions.
 *
 * Eliminates duplicated exit/end logic across CiscoIOSShell, CiscoSwitchShell,
 * and HuaweiVRPShell. Each shell defines its mode hierarchy declaratively,
 * and the FSM handles navigation (exit → parent, end → privileged/user).
 */

// ─── Mode Hierarchy Definition ────────────────────────────────────

export interface ModeDefinition {
  /** Parent mode to return to on `exit`/`quit`. null = top-level (no parent). */
  parent: string | null;
  /** State fields to clear when exiting this mode. */
  clearOnExit?: string[];
}

export type ModeHierarchy = Record<string, ModeDefinition>;

/**
 * Generic CLI state machine. Works for Cisco IOS, Cisco Switch, and Huawei VRP.
 *
 * Usage:
 * ```ts
 * const fsm = new CLIStateMachine('user', CISCO_IOS_MODES);
 * fsm.exit();  // user → user (no-op) or config-if → config
 * fsm.end();   // any config mode → privileged
 * ```
 */
export class CLIStateMachine<TMode extends string = string> {
  private _mode: TMode;
  private readonly hierarchy: ModeHierarchy;
  private readonly topLevel: TMode;
  private readonly execLevel: TMode;

  /**
   * @param initial    Starting mode (e.g. 'user')
   * @param hierarchy  Mode definitions with parent pointers
   * @param topLevel   The top-most mode (e.g. 'user')
   * @param execLevel  The privileged/exec mode to jump to on `end` (e.g. 'privileged' or 'user')
   */
  constructor(
    initial: TMode,
    hierarchy: ModeHierarchy,
    topLevel: TMode,
    execLevel: TMode,
  ) {
    this._mode = initial;
    this.hierarchy = hierarchy;
    this.topLevel = topLevel;
    this.execLevel = execLevel;
  }

  get mode(): TMode { return this._mode; }
  set mode(m: TMode) { this._mode = m; }

  /**
   * Navigate one level up in the hierarchy (exit/quit).
   * Returns the fields that should be cleared, if any.
   */
  exit(): { newMode: TMode; fieldsToCllear: string[] } {
    const def = this.hierarchy[this._mode];
    if (!def || def.parent === null) {
      // Already at top level
      return { newMode: this._mode, fieldsToCllear: [] };
    }
    const fields = def.clearOnExit ?? [];
    this._mode = def.parent as TMode;
    return { newMode: this._mode, fieldsToCllear: fields };
  }

  /**
   * Jump directly to exec/privileged level (end/Ctrl-Z).
   * Returns the fields that should be cleared, if any.
   */
  end(): { newMode: TMode; fieldsToCllear: string[] } {
    if (this._mode === this.topLevel || this._mode === this.execLevel) {
      return { newMode: this._mode, fieldsToCllear: [] };
    }
    // Collect all fields to clear by walking up the hierarchy
    const fields: string[] = [];
    let current = this._mode as string;
    while (current !== this.execLevel && current !== this.topLevel) {
      const def = this.hierarchy[current];
      if (!def) break;
      if (def.clearOnExit) fields.push(...def.clearOnExit);
      if (def.parent === null) break;
      current = def.parent;
    }
    this._mode = this.execLevel;
    return { newMode: this._mode, fieldsToCllear: fields };
  }

  /**
   * Check if the current mode is a config mode (not top-level or exec-level).
   */
  isConfigMode(): boolean {
    return this._mode !== this.topLevel && this._mode !== this.execLevel;
  }
}

// ─── Cisco IOS Mode Hierarchy ─────────────────────────────────────

export const CISCO_IOS_MODES: ModeHierarchy = {
  'user':                      { parent: null },
  'privileged':                { parent: 'user' },  // exit → user (special: not a config mode)
  'config':                    { parent: 'privileged' },
  'config-if':                 { parent: 'config', clearOnExit: ['selectedInterface'] },
  'config-dhcp':               { parent: 'config', clearOnExit: ['selectedDHCPPool'] },
  'config-router':             { parent: 'config' },
  'config-router-ospf':        { parent: 'config' },
  'config-router-ospfv3':      { parent: 'config' },
  'config-std-nacl':           { parent: 'config', clearOnExit: ['selectedACL', 'selectedACLType'] },
  'config-ext-nacl':           { parent: 'config', clearOnExit: ['selectedACL', 'selectedACLType'] },
  'config-ipv6-nacl':          { parent: 'config', clearOnExit: ['selectedACL', 'selectedACLType'] },
  'config-isakmp':             { parent: 'config', clearOnExit: ['selectedISAKMPPriority'] },
  'config-tfset':              { parent: 'config', clearOnExit: ['selectedTransformSet'] },
  'config-crypto-map':         { parent: 'config', clearOnExit: ['selectedCryptoMap', 'selectedCryptoMapSeq'] },
  'config-ipsec-profile':      { parent: 'config', clearOnExit: ['selectedIPSecProfile'] },
  'config-ikev2-proposal':     { parent: 'config', clearOnExit: ['selectedIKEv2Proposal'] },
  'config-ikev2-policy':       { parent: 'config', clearOnExit: ['selectedIKEv2Policy'] },
  'config-ikev2-keyring':      { parent: 'config', clearOnExit: ['selectedIKEv2Keyring'] },
  'config-ikev2-keyring-peer': { parent: 'config-ikev2-keyring', clearOnExit: ['selectedIKEv2KeyringPeer'] },
  'config-ikev2-profile':      { parent: 'config', clearOnExit: ['selectedIKEv2Profile'] },
};

// ─── Cisco Switch Mode Hierarchy ──────────────────────────────────

export const CISCO_SWITCH_MODES: ModeHierarchy = {
  'user':        { parent: null },
  'privileged':  { parent: 'user' },
  'config':      { parent: 'privileged' },
  'config-if':   { parent: 'config', clearOnExit: ['selectedInterface', 'selectedInterfaceRange'] },
  'config-vlan': { parent: 'config', clearOnExit: ['selectedVlan'] },
};

// ─── Huawei VRP Mode Hierarchy ────────────────────────────────────

export const HUAWEI_VRP_MODES: ModeHierarchy = {
  'user':            { parent: null },
  'system':          { parent: 'user' },
  'interface':       { parent: 'system', clearOnExit: ['selectedInterface'] },
  'dhcp-pool':       { parent: 'system', clearOnExit: ['selectedPool'] },
  'ospf':            { parent: 'system' },
  'ospf-area':       { parent: 'ospf', clearOnExit: ['ospfArea'] },
  'ike-proposal':    { parent: 'system', clearOnExit: ['selectedIKEProposal'] },
  'ike-peer':        { parent: 'system', clearOnExit: ['selectedIKEPeer'] },
  'ipsec-proposal':  { parent: 'system', clearOnExit: ['selectedIPSecProposal'] },
  'ipsec-policy':    { parent: 'system', clearOnExit: ['selectedIPSecPolicy', 'selectedIPSecPolicySeq'] },
};
