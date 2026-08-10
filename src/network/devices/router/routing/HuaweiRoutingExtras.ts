export interface HuaweiBgpPeerCfg {
  ip: string;
  asNumber?: number;
  description?: string;
  groupName?: string;
  connectInterface?: string;
  passwordHash?: string;
  rawLines: string[];
}

export interface HuaweiBgpGroupCfg {
  name: string;
  kind?: 'internal' | 'external';
  asNumber?: number;
  rawLines: string[];
}

/**
 * Les champs ci-dessous étaient ÉCRITS sans être déclarés, par un
 * `(b as any).champ = …` dans `HuaweiVRPShell`. Les déclarer ne les
 * rend pas vivants — aucun n'est lu, ici ni ailleurs, ce que le
 * commentaire dit plutôt que de le laisser découvrir — mais cela rend
 * la chose GREPPABLE : une configuration morte cachée derrière un `any`
 * est invisible, la même déclarée se voit et se compte.
 *
 * C'est la catégorie que `CLAUDE.md` suit déjà pour
 * `HuaweiRoutingExtras.importedRoutes` et `BGPEngine.redistribute`.
 * `maximum load-balancing` n'était ni lu NI RENDU — donc sans effet et
 * perdu au rechargement d'une topologie ; il est désormais les deux (le
 * plafond vit sur le `Router`, seule chose que le plan de données
 * consulte, et la ligne est rendue ci-dessous). `ipv4-family` /
 * `ipv6-family` restent stockés sans effet : ce simulateur n'a pas de
 * table de routage par famille d'adresses, donc entrer dans une vue de
 * famille ne peut rien changer — le dire vaut mieux que de rendre une
 * ligne qui promettrait une séparation qui n'existe pas.
 */
export interface HuaweiBgpProcess {
  asn: number;
  routerId?: string;
  networks: Array<{ ip: string; mask: string }>;
  aggregates: Array<{ ip: string; mask: string; flags: string[] }>;
  peers: Map<string, HuaweiBgpPeerCfg>;
  groups: Map<string, HuaweiBgpGroupCfg>;
  rawLines: string[];
  /** `timer keepalive <s> hold <s>` — stocké, lu par personne. */
  keepaliveSec?: number;
  holdSec?: number;
  /** `maximum load-balancing <n>` — le plafond d'ECMP, rendu et agissant. */
  maximumPaths?: number;
  /** `ipv4-family` / `ipv6-family` — stockés, lus par personne. */
  ipv4Family?: boolean;
  ipv6Family?: boolean;
}

export interface HuaweiIsisProcess {
  processId: number;
  netAddress?: string;
  isLevel?: 'level-1' | 'level-2' | 'level-1-2';
  costStyle?: 'narrow' | 'wide' | 'compatible';
  checkzero?: boolean;
  defaultRouteAdvertise?: boolean;
  importedRoutes: string[];
  gracefulRestart?: boolean;
  rawLines: string[];
  /** `is-name` — le nom dynamique IS-IS. Stocké, lu par personne. */
  hostname?: string;
  /** `timer lsp-refresh <s>` — stocké, lu par personne. */
  lspRefreshSec?: number;
  /** `set-overload` / `undo set-overload` — stocké, lu par personne. */
  overload?: boolean;
  /** `maximum load-balancing <n>` — le plafond d'ECMP, rendu et agissant. */
  maximumPaths?: number;
  /** `preference <n>` — stocké, lu par personne. */
  preference?: number;
}

export class HuaweiRoutingExtras {
  private bgpProcess: HuaweiBgpProcess | null = null;
  private isisProcesses: Map<number, HuaweiIsisProcess> = new Map();

  ensureBgp(asn: number): HuaweiBgpProcess {
    if (!this.bgpProcess) this.bgpProcess = {
      asn, networks: [], aggregates: [], peers: new Map(), groups: new Map(), rawLines: [],
    };
    this.bgpProcess.asn = asn;
    return this.bgpProcess;
  }
  getBgp(): HuaweiBgpProcess | null { return this.bgpProcess; }
  removeBgp(): void { this.bgpProcess = null; }

  ensureIsis(processId: number): HuaweiIsisProcess {
    let p = this.isisProcesses.get(processId);
    if (!p) {
      p = { processId, importedRoutes: [], rawLines: [] };
      this.isisProcesses.set(processId, p);
    }
    return p;
  }
  getIsis(processId: number): HuaweiIsisProcess | undefined { return this.isisProcesses.get(processId); }
  listIsis(): readonly HuaweiIsisProcess[] { return [...this.isisProcesses.values()]; }
  removeIsis(processId: number): void { this.isisProcesses.delete(processId); }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.bgpProcess) {
      lines.push(`bgp ${this.bgpProcess.asn}`);
      if (this.bgpProcess.routerId) lines.push(` router-id ${this.bgpProcess.routerId}`);
      for (const n of this.bgpProcess.networks) lines.push(` network ${n.ip} ${n.mask}`);
      for (const ag of this.bgpProcess.aggregates) lines.push(` aggregate ${ag.ip} ${ag.mask}${ag.flags.length ? ' ' + ag.flags.join(' ') : ''}`);
      for (const [, g] of this.bgpProcess.groups) {
        lines.push(` group ${g.name}${g.kind ? ' ' + g.kind : ''}`);
        for (const line of g.rawLines) lines.push(` ${line}`);
      }
      for (const [, p] of this.bgpProcess.peers) {
        lines.push(` peer ${p.ip}${p.groupName ? ' group ' + p.groupName : ''}${p.asNumber !== undefined ? ' as-number ' + p.asNumber : ''}`);
        for (const line of p.rawLines) lines.push(` ${line}`);
      }
      // Rendue APRÈS les pairs et avant les lignes brutes : c'est une
      // ligne de la vue BGP elle-même, et une configuration relue est ce
      // qui REFAIT le réglage à l'import d'une topologie.
      if (this.bgpProcess.maximumPaths !== undefined) {
        lines.push(` maximum load-balancing ${this.bgpProcess.maximumPaths}`);
      }
      for (const r of this.bgpProcess.rawLines) lines.push(` ${r}`);
    }
    for (const [, p] of this.isisProcesses) {
      lines.push(`isis ${p.processId}`);
      if (p.netAddress) lines.push(` network-entity ${p.netAddress}`);
      if (p.isLevel) lines.push(` is-level ${p.isLevel}`);
      if (p.costStyle) lines.push(` cost-style ${p.costStyle}`);
      if (p.checkzero === false) lines.push(' undo checkzero');
      else if (p.checkzero) lines.push(' checkzero');
      if (p.defaultRouteAdvertise) lines.push(' default-route-advertise');
      if (p.gracefulRestart) lines.push(' graceful-restart');
      if (p.maximumPaths !== undefined) {
        lines.push(` maximum load-balancing ${p.maximumPaths}`);
      }
      for (const ir of p.importedRoutes) lines.push(` import-route ${ir}`);
      for (const r of p.rawLines) lines.push(` ${r}`);
    }
    return lines;
  }
}
