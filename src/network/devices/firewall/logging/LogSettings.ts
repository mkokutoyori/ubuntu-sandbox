export type LocalTrafficKind =
  | 'local-in-allow'
  | 'local-in-deny-unicast'
  | 'local-in-deny-broadcast'
  | 'local-out';

export interface LogSettingsPatch {
  readonly implicitPolicyLog?: boolean;
  readonly invalidPacket?: boolean;
  readonly localInAllow?: boolean;
  readonly localInDenyUnicast?: boolean;
  readonly localInDenyBroadcast?: boolean;
  readonly localOut?: boolean;
}

export class LogSettings {
  private implicitPolicyLog = false;
  private invalidPacket = false;
  private readonly localTraffic: Record<LocalTrafficKind, boolean> = {
    'local-in-allow': false,
    'local-in-deny-unicast': false,
    'local-in-deny-broadcast': false,
    'local-out': false,
  };

  apply(patch: LogSettingsPatch): void {
    if (patch.implicitPolicyLog !== undefined) this.implicitPolicyLog = patch.implicitPolicyLog;
    if (patch.invalidPacket !== undefined) this.invalidPacket = patch.invalidPacket;
    if (patch.localInAllow !== undefined) {
      this.localTraffic['local-in-allow'] = patch.localInAllow;
    }
    if (patch.localInDenyUnicast !== undefined) {
      this.localTraffic['local-in-deny-unicast'] = patch.localInDenyUnicast;
    }
    if (patch.localInDenyBroadcast !== undefined) {
      this.localTraffic['local-in-deny-broadcast'] = patch.localInDenyBroadcast;
    }
    if (patch.localOut !== undefined) this.localTraffic['local-out'] = patch.localOut;
  }

  logs(kind: LocalTrafficKind): boolean {
    return this.localTraffic[kind];
  }

  logsImplicitPolicy(): boolean { return this.implicitPolicyLog; }

  logsInvalidPacket(): boolean { return this.invalidPacket; }
}
