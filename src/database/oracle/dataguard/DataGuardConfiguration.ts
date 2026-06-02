export type DatabaseRole = 'PRIMARY' | 'PHYSICAL STANDBY' | 'LOGICAL STANDBY' | 'SNAPSHOT STANDBY' | 'FAR SYNC';
export type ProtectionMode = 'MAXIMUM PROTECTION' | 'MAXIMUM AVAILABILITY' | 'MAXIMUM PERFORMANCE';
export type ApplyMode = 'IDLE' | 'APPLYING' | 'WAITING FOR GAP' | 'WAITING FOR LOG' | 'NEEDS RECOVERY' | 'OFFLINE';
export type TransportMode = 'SYNC' | 'ASYNC' | 'FASTSYNC' | 'NOAFFIRM';

export class StandbyDatabase {
  readonly dbUniqueName: string;
  readonly host: string;
  role: DatabaseRole;
  protectionMode: ProtectionMode;
  transportMode: TransportMode;
  applyMode: ApplyMode;
  readonly observerHost: string | null;
  applyLagSeconds: number;
  transportLagSeconds: number;
  estimatedFailoverTimeSeconds: number;
  fastStartFailover: boolean;
  readonly destId: number;
  archiveDest: string;

  constructor(init: {
    dbUniqueName: string; host: string; role: DatabaseRole;
    protectionMode?: ProtectionMode; transportMode?: TransportMode; applyMode?: ApplyMode;
    observerHost?: string | null; applyLagSeconds?: number; transportLagSeconds?: number;
    estimatedFailoverTimeSeconds?: number; fastStartFailover?: boolean;
    destId?: number; archiveDest?: string;
  }) {
    this.dbUniqueName = init.dbUniqueName.toUpperCase();
    this.host = init.host;
    this.role = init.role;
    this.protectionMode = init.protectionMode ?? 'MAXIMUM PERFORMANCE';
    this.transportMode = init.transportMode ?? 'ASYNC';
    this.applyMode = init.applyMode ?? 'IDLE';
    this.observerHost = init.observerHost ?? null;
    this.applyLagSeconds = init.applyLagSeconds ?? 0;
    this.transportLagSeconds = init.transportLagSeconds ?? 0;
    this.estimatedFailoverTimeSeconds = init.estimatedFailoverTimeSeconds ?? 30;
    this.fastStartFailover = init.fastStartFailover ?? false;
    this.destId = init.destId ?? 2;
    this.archiveDest = init.archiveDest ?? `SERVICE=${this.dbUniqueName}`;
  }
}

export class DataGuardConfiguration {
  private readonly standbys: StandbyDatabase[] = [];
  primaryRole: DatabaseRole = 'PRIMARY';
  configurationName: string;
  protectionMode: ProtectionMode;
  fastStartFailoverEnabled: boolean;
  observerHost: string | null;
  configurationStatus: 'SUCCESS' | 'WARNING' | 'ERROR';

  constructor(init?: {
    configurationName?: string; protectionMode?: ProtectionMode;
    fastStartFailoverEnabled?: boolean; observerHost?: string | null;
  }) {
    this.configurationName = (init?.configurationName ?? 'DG_CONFIG').toUpperCase();
    this.protectionMode = init?.protectionMode ?? 'MAXIMUM PERFORMANCE';
    this.fastStartFailoverEnabled = init?.fastStartFailoverEnabled ?? false;
    this.observerHost = init?.observerHost ?? null;
    this.configurationStatus = 'SUCCESS';
  }

  addStandby(s: StandbyDatabase): void {
    if (!this.standbys.some(x => x.dbUniqueName === s.dbUniqueName)) {
      this.standbys.push(s);
    }
  }

  removeStandby(dbUniqueName: string): boolean {
    const idx = this.standbys.findIndex(s => s.dbUniqueName === dbUniqueName.toUpperCase());
    if (idx < 0) return false;
    this.standbys.splice(idx, 1);
    return true;
  }

  getStandbys(): readonly StandbyDatabase[] { return this.standbys; }

  findStandby(dbUniqueName: string): StandbyDatabase | undefined {
    return this.standbys.find(s => s.dbUniqueName === dbUniqueName.toUpperCase());
  }

  switchover(targetName: string): boolean {
    const t = this.findStandby(targetName);
    if (!t) return false;
    const oldRole = this.primaryRole;
    this.primaryRole = t.role;
    t.role = oldRole;
    return true;
  }

  setProtectionMode(mode: ProtectionMode): void {
    this.protectionMode = mode;
    for (const s of this.standbys) s.protectionMode = mode;
  }

  enableFastStartFailover(observerHost: string): void {
    this.fastStartFailoverEnabled = true;
    this.observerHost = observerHost;
  }

  disableFastStartFailover(): void {
    this.fastStartFailoverEnabled = false;
    this.observerHost = null;
  }
}
