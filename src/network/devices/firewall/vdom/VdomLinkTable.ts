import { Cable } from '../../../hardware/Cable';
import { Port } from '../../../hardware/Port';

export interface VdomLinkDeps {
  readonly deviceId: string;
  readonly port: (name: string) => Port | undefined;
  readonly addPort: (port: Port) => void;
  readonly declareInterface: (name: string) => void;
  readonly forgetInterface: (name: string) => void;
}

export class VdomLinkTable {
  private readonly links = new Map<string, readonly string[]>();

  constructor(private readonly deps: VdomLinkDeps) {}

  create(name: string): readonly string[] {
    const ends = [`${name}0`, `${name}1`];
    if (this.deps.port(ends[0])) return Object.freeze(ends);

    const left = new Port(ends[0], 'ethernet');
    const right = new Port(ends[1], 'ethernet');
    this.deps.addPort(left);
    this.deps.addPort(right);
    for (const end of ends) this.deps.declareInterface(end);

    new Cable(`vdom-link:${this.deps.deviceId}:${name}`).connect(left, right);
    this.links.set(name, Object.freeze(ends));
    return Object.freeze(ends);
  }

  remove(name: string): boolean {
    const ends = this.links.get(name);
    if (!ends) return false;

    for (const end of ends) this.deps.forgetInterface(end);
    return this.links.delete(name);
  }

  ends(name: string): readonly string[] {
    return this.links.get(name) ?? [];
  }

  peer(iface: string): string | undefined {
    for (const ends of this.links.values()) {
      if (ends[0] === iface) return ends[1];
      if (ends[1] === iface) return ends[0];
    }
    return undefined;
  }
}
