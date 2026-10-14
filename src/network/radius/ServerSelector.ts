export const DEFAULT_LOAD_BALANCE_BATCH = 25;
export const DEFAULT_TRANSACTION_MAX_TRIES = 8;

export interface LoadBalanceSetting {
  readonly batchSize: number;
  readonly ignorePreferredServer: boolean;
}

export interface SelectionRequest {
  readonly group: string;
  readonly user: string;
  readonly candidates: readonly string[];
  readonly loadBalance?: LoadBalanceSetting;
  readonly reorder: boolean;
}

interface Batch {
  server: string;
  remaining: number;
}

export class ServerSelector {
  private readonly outstanding = new Map<string, number>();
  private readonly batches = new Map<string, Batch>();
  private readonly sessionServer = new Map<string, string>();
  private readonly stickyStart = new Map<string, string>();

  acquire(server: string): void {
    this.outstanding.set(server, (this.outstanding.get(server) ?? 0) + 1);
  }

  release(server: string): void {
    this.outstanding.set(server, Math.max(0, (this.outstanding.get(server) ?? 0) - 1));
  }

  outstandingOf(server: string): number {
    return this.outstanding.get(server) ?? 0;
  }

  order(request: SelectionRequest): string[] {
    const { candidates } = request;
    if (candidates.length <= 1) return [...candidates];
    if (request.loadBalance) return this.balanced(request, request.loadBalance);
    if (request.reorder) return this.rotatedTo(candidates, this.stickyStart.get(request.group));
    return [...candidates];
  }

  private rotatedTo(candidates: readonly string[], start: string | undefined): string[] {
    const index = start === undefined ? 0 : candidates.indexOf(start);
    return index <= 0 ? [...candidates] : [...candidates.slice(index), ...candidates.slice(0, index)];
  }

  private balanced(request: SelectionRequest, setting: LoadBalanceSetting): string[] {
    const { candidates, group, user } = request;
    const remembered = this.sessionServer.get(`${group}:${user}`);
    let head: string | undefined;
    if (!setting.ignorePreferredServer && remembered !== undefined && candidates.includes(remembered)) {
      head = remembered;
    } else {
      const batch = this.batches.get(group);
      if (batch && batch.remaining > 0 && candidates.includes(batch.server)) {
        batch.remaining -= 1;
        head = batch.server;
      } else {
        head = candidates.reduce((best, server) =>
          this.outstandingOf(server) < this.outstandingOf(best) ? server : best, candidates[0]);
        this.batches.set(group, { server: head, remaining: setting.batchSize - 1 });
      }
    }
    this.sessionServer.set(`${group}:${user}`, head);
    return [head, ...candidates.filter((server) => server !== head)];
  }

  noteAnswer(group: string, server: string): void {
    this.stickyStart.set(group, server);
  }

  noteFailure(group: string, failed: string, candidates: readonly string[]): void {
    const index = candidates.indexOf(failed);
    if (index >= 0) this.stickyStart.set(group, candidates[(index + 1) % candidates.length]);
  }
}
