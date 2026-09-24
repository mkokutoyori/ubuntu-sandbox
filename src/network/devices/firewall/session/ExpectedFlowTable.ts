export interface ExpectedFlow {
  readonly protocol: number;
  readonly sourceIP: string;
  readonly destIP: string;
  readonly destPort: number;
  readonly parentSessionId: number;
  readonly policyId: string | undefined;
  readonly helper: string;
}

function keyOf(protocol: number, sourceIP: string, destIP: string, destPort: number): string {
  return `${protocol}|${sourceIP}|${destIP}|${destPort}`;
}

export class ExpectedFlowTable {
  private readonly pending = new Map<string, ExpectedFlow>();

  expect(flow: ExpectedFlow): void {
    this.pending.set(keyOf(flow.protocol, flow.sourceIP, flow.destIP, flow.destPort), flow);
  }

  take(protocol: number, sourceIP: string, destIP: string, destPort: number): ExpectedFlow | undefined {
    const key = keyOf(protocol, sourceIP, destIP, destPort);
    const flow = this.pending.get(key);
    if (flow) this.pending.delete(key);
    return flow;
  }

  forgetChildrenOf(parentSessionId: number): void {
    for (const [key, flow] of this.pending) {
      if (flow.parentSessionId === parentSessionId) this.pending.delete(key);
    }
  }

  all(): readonly ExpectedFlow[] {
    return [...this.pending.values()];
  }
}
