export type ArpDirection = 'rx' | 'tx';
export type ArpOp = 'request' | 'reply';

export class ArpStats {
  rxRequests = 0;
  rxReplies = 0;
  txRequests = 0;
  txReplies = 0;

  record(dir: ArpDirection, op: ArpOp): void {
    if (dir === 'rx') {
      if (op === 'request') this.rxRequests++;
      else this.rxReplies++;
    } else {
      if (op === 'request') this.txRequests++;
      else this.txReplies++;
    }
  }

  get rxTotal(): number {
    return this.rxRequests + this.rxReplies;
  }

  get txTotal(): number {
    return this.txRequests + this.txReplies;
  }

  reset(): void {
    this.rxRequests = 0;
    this.rxReplies = 0;
    this.txRequests = 0;
    this.txReplies = 0;
  }
}
