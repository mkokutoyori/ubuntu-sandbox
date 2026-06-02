export type CaptureType = 'LOCAL' | 'DOWNSTREAM' | 'SYNC';
export type CaptureState = 'CAPTURING CHANGES' | 'ENABLED' | 'DISABLED' | 'PAUSED' | 'ABORTED';
export type ApplyType = 'APPLY' | 'XSTREAM' | 'GG';
export type ApplyStatus = 'ENABLED' | 'DISABLED' | 'ABORTED';

export class CaptureProcess {
  readonly captureName: string;
  readonly captureType: CaptureType;
  readonly queueName: string;
  readonly queueOwner: string;
  state: CaptureState;
  capturedScn: number;
  appliedScn: number;
  enqueuedScn: number;
  ruleSetName: string | null;
  startScn: number;
  readonly createdAt: Date;
  lastEnqueueTime: Date | null = null;

  constructor(init: {
    captureName: string; captureType?: CaptureType;
    queueName?: string; queueOwner?: string;
    state?: CaptureState; startScn?: number; ruleSetName?: string | null;
  }) {
    this.captureName = init.captureName.toUpperCase();
    this.captureType = init.captureType ?? 'LOCAL';
    this.queueName = (init.queueName ?? 'STREAMS_QUEUE').toUpperCase();
    this.queueOwner = (init.queueOwner ?? 'STRMADMIN').toUpperCase();
    this.state = init.state ?? 'ENABLED';
    this.startScn = init.startScn ?? 0;
    this.capturedScn = this.startScn;
    this.appliedScn = this.startScn;
    this.enqueuedScn = this.startScn;
    this.ruleSetName = init.ruleSetName ?? null;
    this.createdAt = new Date();
  }

  recordEnqueue(scn: number): void {
    this.capturedScn = scn;
    this.enqueuedScn = scn;
    this.lastEnqueueTime = new Date();
  }
}

export class ApplyProcess {
  readonly applyName: string;
  readonly applyType: ApplyType;
  readonly queueName: string;
  readonly queueOwner: string;
  status: ApplyStatus;
  appliedMessageNumber: number;
  appliedMessageCreateTime: Date | null;
  oldestMessageNumber: number;
  ruleSetName: string | null;
  applyUser: string;
  errorMessage: string | null;
  readonly createdAt: Date;

  constructor(init: {
    applyName: string; applyType?: ApplyType;
    queueName?: string; queueOwner?: string;
    status?: ApplyStatus; applyUser?: string; ruleSetName?: string | null;
  }) {
    this.applyName = init.applyName.toUpperCase();
    this.applyType = init.applyType ?? 'APPLY';
    this.queueName = (init.queueName ?? 'STREAMS_QUEUE').toUpperCase();
    this.queueOwner = (init.queueOwner ?? 'STRMADMIN').toUpperCase();
    this.status = init.status ?? 'ENABLED';
    this.appliedMessageNumber = 0;
    this.appliedMessageCreateTime = null;
    this.oldestMessageNumber = 0;
    this.applyUser = (init.applyUser ?? 'STRMADMIN').toUpperCase();
    this.ruleSetName = init.ruleSetName ?? null;
    this.errorMessage = null;
    this.createdAt = new Date();
  }

  recordApply(scn: number, at: Date = new Date()): void {
    this.appliedMessageNumber = scn;
    this.appliedMessageCreateTime = at;
  }
}

export class PropagationProcess {
  readonly propagationName: string;
  readonly sourceQueueName: string;
  readonly sourceQueueOwner: string;
  readonly destinationDbLink: string;
  readonly destinationQueueName: string;
  status: 'ENABLED' | 'DISABLED' | 'ABORTED';
  queueToQueue: 'TRUE' | 'FALSE';
  errorMessage: string | null;

  constructor(init: {
    propagationName: string; sourceQueueName?: string; sourceQueueOwner?: string;
    destinationDbLink: string; destinationQueueName?: string;
    status?: 'ENABLED' | 'DISABLED' | 'ABORTED';
  }) {
    this.propagationName = init.propagationName.toUpperCase();
    this.sourceQueueName = (init.sourceQueueName ?? 'STREAMS_QUEUE').toUpperCase();
    this.sourceQueueOwner = (init.sourceQueueOwner ?? 'STRMADMIN').toUpperCase();
    this.destinationDbLink = init.destinationDbLink.toUpperCase();
    this.destinationQueueName = (init.destinationQueueName ?? 'STREAMS_QUEUE').toUpperCase();
    this.status = init.status ?? 'ENABLED';
    this.queueToQueue = 'TRUE';
    this.errorMessage = null;
  }
}

export class GoldenGateExtract {
  readonly extractName: string;
  readonly extractType: 'CAPTURE' | 'PUMP' | 'INTEGRATED' | 'CLASSIC';
  readonly sourceDb: string;
  status: 'RUNNING' | 'STOPPED' | 'ABENDED';
  lagSeconds: number;
  positionFile: string;
  readonly createdAt: Date;

  constructor(init: {
    extractName: string; extractType?: 'CAPTURE' | 'PUMP' | 'INTEGRATED' | 'CLASSIC';
    sourceDb: string; status?: 'RUNNING' | 'STOPPED' | 'ABENDED';
    lagSeconds?: number; positionFile?: string;
  }) {
    this.extractName = init.extractName.toUpperCase();
    this.extractType = init.extractType ?? 'INTEGRATED';
    this.sourceDb = init.sourceDb.toUpperCase();
    this.status = init.status ?? 'RUNNING';
    this.lagSeconds = init.lagSeconds ?? 0;
    this.positionFile = init.positionFile ?? `ogg_extract_${init.extractName.toLowerCase()}.dat`;
    this.createdAt = new Date();
  }
}

export class GoldenGateReplicat {
  readonly replicatName: string;
  readonly replicatType: 'INTEGRATED' | 'COORDINATED' | 'CLASSIC' | 'PARALLEL';
  readonly targetDb: string;
  status: 'RUNNING' | 'STOPPED' | 'ABENDED';
  lagSeconds: number;
  appliedRecords: number;

  constructor(init: {
    replicatName: string; replicatType?: 'INTEGRATED' | 'COORDINATED' | 'CLASSIC' | 'PARALLEL';
    targetDb: string; status?: 'RUNNING' | 'STOPPED' | 'ABENDED';
    lagSeconds?: number;
  }) {
    this.replicatName = init.replicatName.toUpperCase();
    this.replicatType = init.replicatType ?? 'INTEGRATED';
    this.targetDb = init.targetDb.toUpperCase();
    this.status = init.status ?? 'RUNNING';
    this.lagSeconds = init.lagSeconds ?? 0;
    this.appliedRecords = 0;
  }
}

export class ReplicationManager {
  private captures: CaptureProcess[] = [];
  private applies: ApplyProcess[] = [];
  private propagations: PropagationProcess[] = [];
  private extracts: GoldenGateExtract[] = [];
  private replicats: GoldenGateReplicat[] = [];

  addCapture(c: CaptureProcess): void {
    this.captures = this.captures.filter(x => x.captureName !== c.captureName);
    this.captures.push(c);
  }

  addApply(a: ApplyProcess): void {
    this.applies = this.applies.filter(x => x.applyName !== a.applyName);
    this.applies.push(a);
  }

  addPropagation(p: PropagationProcess): void {
    this.propagations = this.propagations.filter(x => x.propagationName !== p.propagationName);
    this.propagations.push(p);
  }

  addExtract(e: GoldenGateExtract): void {
    this.extracts = this.extracts.filter(x => x.extractName !== e.extractName);
    this.extracts.push(e);
  }

  addReplicat(r: GoldenGateReplicat): void {
    this.replicats = this.replicats.filter(x => x.replicatName !== r.replicatName);
    this.replicats.push(r);
  }

  dropCapture(name: string): boolean {
    const before = this.captures.length;
    this.captures = this.captures.filter(c => c.captureName !== name.toUpperCase());
    return this.captures.length < before;
  }

  dropApply(name: string): boolean {
    const before = this.applies.length;
    this.applies = this.applies.filter(a => a.applyName !== name.toUpperCase());
    return this.applies.length < before;
  }

  getCaptures(): readonly CaptureProcess[] { return this.captures; }
  getApplies(): readonly ApplyProcess[] { return this.applies; }
  getPropagations(): readonly PropagationProcess[] { return this.propagations; }
  getExtracts(): readonly GoldenGateExtract[] { return this.extracts; }
  getReplicats(): readonly GoldenGateReplicat[] { return this.replicats; }
}
