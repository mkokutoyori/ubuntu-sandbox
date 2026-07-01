import type { Switch } from '../Switch';

export type TrackObjectKind = 'line-protocol' | 'ip-routing';

export interface TrackObject {
  id: number;
  target: string;
  kind: TrackObjectKind;
}

export class TrackObjectRegistry {
  private readonly objects = new Map<number, TrackObject>();

  set(id: number, target: string, kind: TrackObjectKind = 'line-protocol'): TrackObject {
    const obj: TrackObject = { id, target, kind };
    this.objects.set(id, obj);
    return obj;
  }

  get(id: number): TrackObject | undefined {
    return this.objects.get(id);
  }

  delete(id: number): boolean {
    return this.objects.delete(id);
  }

  list(): TrackObject[] {
    return [...this.objects.values()].sort((a, b) => a.id - b.id);
  }

  resolve(idOrIface: string): string | null {
    const n = parseInt(idOrIface, 10);
    if (!Number.isFinite(n)) return null;
    return this.objects.get(n)?.target ?? null;
  }

  stateOf(sw: Switch, id: number): 'Up' | 'Down' {
    const obj = this.objects.get(id);
    if (!obj) return 'Down';
    const port = sw.getPort(obj.target);
    if (!port) return 'Down';
    if (obj.kind === 'ip-routing') {
      return port.getIsUp() && port.isConnected() && !!port.getIPAddress() ? 'Up' : 'Down';
    }
    return port.getIsUp() && port.isConnected() ? 'Up' : 'Down';
  }
}
