/**
 * ServicePortProjection — reactive bridge keeping the kernel socket table
 * coherent with the service layer.
 *
 * A real daemon opens its listening socket when it starts and closes it
 * when it stops; `netstat` / `ss` show exactly the ports of the daemons
 * that are running. This projection reproduces that: it subscribes to the
 * service-lifecycle event stream and binds / unbinds the owning service's
 * listening sockets on the {@link SocketTable} — so `systemctl start nginx`
 * genuinely makes `:80` appear and `systemctl stop nginx` makes it vanish.
 *
 * Coherence delivered: service ⇄ process (the socket carries the unit's
 * `mainPid` and process name) ⇄ port (the SocketTable entry).
 *
 * `ssh` is intentionally excluded: its listener is config-driven (the
 * `Port` directive in `sshd_config`) and is owned by the SSH module in
 * `LinuxMachine`. Binding it here too would double-bind a custom port.
 *
 * ── Ce que ce module n'affiche plus (docs/PRD-Nginx.md §P0) ────────────
 *
 * Il inscrivait les sockets déclarées par `SERVICE_LISTENERS` sans jamais
 * ouvrir d'écoute réelle sur `TcpStack` — la seule table qui décide
 * d'accepter une connexion. `systemctl start nginx` faisait donc
 * apparaître `0.0.0.0:80` dans `ss` pendant que `curl http://localhost/`
 * répondait `Connection refused` : deux vues de la même machine qui se
 * contredisent, ce qui enseigne une règle fausse (« `ss` montre le port,
 * donc le service écoute ») au lieu de ne rien enseigner.
 *
 * Désormais un service n'est inscrit que s'il a fourni un
 * {@link ServiceSocketServer} et que celui-ci a réellement ouvert son
 * écoute. Conséquence assumée : `mysql`, `postgresql` et `apache2`
 * quittent `ss` tant que personne ne leur écrit de serveur. C'est une
 * régression apparente et une correction réelle — ces ports n'ont jamais
 * accepté la moindre connexion.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SocketTable } from '../../../core/SocketTable';
import type { ServicePortBinding } from '../LinuxServiceManager';
import type { ServiceLifecyclePayload } from '../events';
import type { PortSpec } from '../../../core/ports/PortNumber';
import type { ServiceSocketServer } from './ServiceSocketServer';

/** The slice of `LinuxServiceManager` this projection depends on. */
export interface ServicePortSource {
  getPortBinding(name: string): ServicePortBinding | undefined;
  activePortBindings(): ServicePortBinding[];
}

/** Units whose listener is managed elsewhere and must not be touched here. */
const EXCLUDED_UNITS = new Set(['ssh', 'sshd']);

/** Default bind address when a socket spec does not pin one. */
const ALL_INTERFACES = '0.0.0.0';

export class ServicePortProjection {
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly servers = new Map<string, ServiceSocketServer>();
  /**
   * Ce que cette projection a réellement inscrit, par unité.
   *
   * Indispensable dès qu'un service décide lui-même de ses ports : nginx
   * dont la configuration passe de 80 à 8888 doit voir `ss` bouger avec
   * lui. Fermer d'après la liste déclarée au démarrage laisserait `:80`
   * affiché pour une écoute qui n'existe plus — le défaut même que §P0
   * corrige, réintroduit un cran plus bas.
   */
  private readonly bound = new Map<string, PortSpec[]>();

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly socketTable: SocketTable,
    private readonly source: ServicePortSource,
  ) {
    const onUp = (e: { payload: ServiceLifecyclePayload }) => this.bindService(e.payload.name);
    this.subscriptions.push(
      bus.subscribe('linux.service.started', onUp),
      bus.subscribe('linux.service.restarted', onUp),
      bus.subscribe('linux.service.reloaded', onUp),
      bus.subscribe('linux.service.stopped', (e) => this.releaseService(e.payload.name)),
    );
    // Bind whatever is already running — the projection may attach after boot.
    this.reconcile();
  }

  /**
   * Déclare le serveur réel d'une unité. Sans lui, l'unité peut démarrer,
   * avoir un PID et être `active` — mais elle n'ouvre aucun port et n'en
   * affiche aucun.
   */
  registerServer(unit: string, server: ServiceSocketServer): void {
    this.servers.set(unit.replace(/\.service$/, ''), server);
  }

  /**
   * Réaligne les ports d'une unité sur ce qu'elle écoute maintenant —
   * après un `reload` qui a changé la configuration, par exemple.
   */
  resync(unit: string): void {
    if (EXCLUDED_UNITS.has(unit)) return;
    const binding = this.source.getPortBinding(unit);
    if (!binding) return;
    this.releaseBound(unit, binding);
    this.openSockets(binding);
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  /** Bind the listening sockets of every currently-active service. */
  reconcile(): void {
    for (const binding of this.source.activePortBindings()) {
      if (EXCLUDED_UNITS.has(binding.name)) continue;
      this.openSockets(binding);
    }
  }

  // ─── Lifecycle reactions ───────────────────────────────────────────────

  private bindService(name: string): void {
    if (EXCLUDED_UNITS.has(name)) return;
    const binding = this.source.getPortBinding(name);
    if (binding) this.openSockets(binding);
  }

  private releaseService(name: string): void {
    if (EXCLUDED_UNITS.has(name)) return;
    const binding = this.source.getPortBinding(name);
    if (binding) this.closeSockets(binding);
  }

  // ─── SocketTable mutation ──────────────────────────────────────────────

  private openSockets(binding: ServicePortBinding): void {
    const server = this.servers.get(binding.name);
    if (!server) return;
    for (const spec of binding.sockets) {
      const address = spec.address ?? ALL_INTERFACES;
      // Un port déjà lié : soit il appartient à quelqu'un d'autre et il
      // n'y a rien à faire — `bind()` lèverait EADDRINUSE et ferait échouer
      // toute la réconciliation —, soit c'est CE service qui l'a ouvert
      // lui-même avant la projection (systemd-resolved lie son stub
      // directement). Dans ce second cas le port est bien à lui : il entre
      // au registre et mérite sa ligne de journal, sinon `ss` le montre
      // sans que rien ne l'ait jamais annoncé.
      if (this.socketTable.isPortBound(spec.port, spec.protocol)) {
        const existing = this.socketTable.findByLocalPort(spec.port, spec.protocol);
        if (existing?.processName !== binding.processName) continue;
        if (!server.open(spec)) continue;
        const own = this.bound.get(binding.name) ?? [];
        own.push(spec);
        this.bound.set(binding.name, own);
        this.publishPortEvent('linux.port.bound', binding, spec, address);
        continue;
      }
      if (!server.open(spec)) continue;
      try {
        this.socketTable.bind(spec.protocol, address, spec.port, binding.mainPid, binding.processName);
      } catch {
        server.close(spec);
        continue;
      }
      const held = this.bound.get(binding.name) ?? [];
      held.push(spec);
      this.bound.set(binding.name, held);
      this.publishPortEvent('linux.port.bound', binding, spec, address);
    }
  }

  private closeSockets(binding: ServicePortBinding): void {
    this.releaseBound(binding.name, binding);
  }

  /** Libère ce qui a été inscrit pour cette unité, quoi qu'elle déclare aujourd'hui. */
  private releaseBound(unit: string, binding: ServicePortBinding): void {
    const server = this.servers.get(unit);
    if (!server) return;
    // L'union de ce que la projection a inscrit ET de ce que l'unité
    // déclare aujourd'hui. Le registre seul suffirait si la projection
    // était la seule à lier, mais un port posé directement au démarrage
    // (le 1521 du listener TNS) n'y figure pas et survivrait au `stop` ;
    // la liste déclarée seule, elle, raterait un port que la configuration
    // a changé depuis. Il faut les deux.
    const seen = new Set<string>();
    const toRelease = [...(this.bound.get(unit) ?? []), ...binding.sockets]
      .filter((spec) => {
        const key = `${spec.protocol}:${spec.address ?? ALL_INTERFACES}:${spec.port}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    for (const spec of toRelease) {
      const address = spec.address ?? ALL_INTERFACES;
      server.close(spec);
      const removed = this.socketTable.unbind(spec.protocol, address, spec.port);
      if (removed > 0) {
        this.publishPortEvent('linux.port.released', binding, spec, address);
      }
    }
    this.bound.delete(unit);
  }

  private publishPortEvent(
    topic: 'linux.port.bound' | 'linux.port.released',
    binding: ServicePortBinding,
    spec: PortSpec,
    address: string,
  ): void {
    this.bus.publish({
      topic,
      payload: {
        deviceId: this.deviceId,
        port: spec.port,
        protocol: spec.protocol,
        address,
        pid: binding.mainPid,
        processName: binding.processName,
        serviceName: binding.name,
      },
    });
  }
}
