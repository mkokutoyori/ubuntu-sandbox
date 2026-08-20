/**
 * NameServiceSwitch — the resolver.
 *
 * Faithful re-implementation of the glibc NSS dispatch logic on top of
 * a pluggable {@link INssSource} list. The class:
 *
 *   1. Reads `/etc/nsswitch.conf` (or falls back) on each query so
 *      `echo "passwd: files" > /etc/nsswitch.conf` immediately changes
 *      behaviour — matches `getent` semantics.
 *   2. Walks the source list per the declaration, asking each source
 *      for the requested lookup.
 *   3. Honours the `[STATUS=action]` rules to decide whether to stop
 *      ("return"), keep searching ("continue"), or aggregate
 *      ("merge", used for hosts where multiple sources can contribute
 *      different A/AAAA answers).
 *   4. Subscribes to IAM / host events on the device's bus so caches —
 *      when introduced layer-side — can invalidate without polling.
 *
 * The resolver does *not* cache anything itself: the file source reads
 * the VFS each call (cheap), the DNS source walks the registry each
 * call. A future LRU layer can sit on top of this class and listen to
 * the {@link cacheInvalidated} signal exposed below.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { INssSource } from './INssSource';
import {
  DEFAULT_NSSWITCH_CONF, FALLBACK_CONFIG, effectiveAction,
  parseNsswitchConf, sourcesFor,
} from './NssConfig';
import type {
  NssDatabaseConfig, NssEnumResult, NssResult, NssSourceSpec, NssStatus,
} from './types';
import { NssCache } from './NssCache';
import { startNssWalk, type NssWalk } from './chainWalk';

/**
 * Cache-invalidation signal — every IAM / host event that could change
 * a NSS answer pushes onto this signal. Future caching layers subscribe.
 *
 * Kept on the class so consumers can `nss.cacheInvalidated(...)` without
 * needing access to the bus types.
 */
export type CacheInvalidationListener = (database: string) => void;

/**
 * Files a database can be produced from. A cached answer stamps the
 * mtime of each of these, so an edit invalidates it by construction —
 * no TTL, no staleness window.
 */
const BACKING_FILES: Record<string, string[]> = {
  passwd: ['/etc/passwd'],
  group: ['/etc/group'],
  shadow: ['/etc/shadow'],
  gshadow: ['/etc/gshadow'],
  hosts: ['/etc/hosts'],
  services: ['/etc/services'],
  protocols: ['/etc/protocols'],
  networks: ['/etc/networks'],
  ethers: ['/etc/ethers'],
  rpc: ['/etc/rpc'],
  netgroup: ['/etc/netgroup'],
  aliases: ['/etc/aliases'],
};

export class NameServiceSwitch {
  /** Cache-invalidation listeners (downstream caches subscribe). */
  private readonly invalidationListeners = new Set<CacheInvalidationListener>();
  /** Disposable event-bus subscriptions, cleared on dispose(). */
  private readonly busSubscriptions: Unsubscribe[] = [];
  /** The layered cache the invalidation signal finally feeds. */
  private readonly cache = new NssCache();

  /**
   * @param vfs       VFS owning `/etc/nsswitch.conf`.
   * @param sources   Registered sources keyed by name. Provide the
   *                  `files` source at minimum; add `dns`, `systemd`,
   *                  `compat`, … as needed.
   * @param bus       Optional bus for reactive invalidation.
   * @param deviceId  When `bus` is provided, used to scope invalidation
   *                  to this device's IAM events.
   */
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly sources: Map<string, INssSource>,
    private readonly bus: IEventBus | null = null,
    private readonly deviceId: string | null = null,
  ) {
    if (this.bus) this.wireBusInvalidation(this.bus);
    // The signal finally has a consumer: every wired IAM/host event now
    // drops that database's cached answers instead of reaching nobody.
    this.onCacheInvalidated((db) => this.cache.invalidate(db));
  }

  /** The layered cache, for observability and tests. */
  getCache(): NssCache { return this.cache; }

  /**
   * Composite cache key. Embeds the mtime of `/etc/nsswitch.conf` and of
   * every file the database can come from, so any edit yields a
   * different key — a cached answer can never be served stale.
   * Returns null when the answer is not safely cacheable.
   */
  private cacheKeyFor(database: string, specs: NssSourceSpec[], key: string): string | null {
    const files = BACKING_FILES[database];
    if (!files) return null;

    const sourceStamps: string[] = [];
    for (const spec of specs) {
      if (spec.name === 'files') { sourceStamps.push('files'); continue; }
      // Any other source must be able to stamp its own state, or the
      // answer is not safely cacheable (`dns`, for one, never is).
      const src = this.sources.get(spec.name) as { getRevision?: () => number } | undefined;
      const rev = src?.getRevision?.();
      if (rev === undefined) return null;
      sourceStamps.push(`${spec.name}@${rev}`);
    }

    const fileStamps = ['/etc/nsswitch.conf', ...files]
      .map((p) => `${p}@${this.vfs.resolveInode(p)?.mtime ?? 0}`)
      .join(',');
    return `${database}|${sourceStamps.join('+')}|${fileStamps}|${key}`;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Register a cache-invalidation listener. Returns an unsubscribe. */
  onCacheInvalidated(listener: CacheInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  /** Add or replace a source. Idempotent — last writer wins. */
  registerSource(source: INssSource): void {
    this.sources.set(source.name, source);
  }

  /** Remove a source. */
  unregisterSource(name: string): void {
    this.sources.delete(name);
  }

  /** Dispose bus subscriptions — call on device power-off / tear-down. */
  dispose(): void {
    for (const u of this.busSubscriptions) u();
    this.busSubscriptions.length = 0;
    this.invalidationListeners.clear();
  }

  // ─── Single-key dispatch ────────────────────────────────────────────

  /**
   * Run a single-key lookup against every source for `database`,
   * following the `[STATUS=action]` rules. Returns the first SUCCESS
   * stopped on by a `return` action (the default), or NOTFOUND if no
   * source ever succeeds.
   */
  lookup<T>(
    database: string,
    invoke: (source: INssSource) => NssResult<T> | undefined,
    cacheKey?: string,
  ): NssResult<T> {
    const config = this.parsedConfig();
    const specs = sourcesFor(config, database);

    const ck = cacheKey === undefined ? null : this.cacheKeyFor(database, specs, `k:${cacheKey}`);
    if (ck) {
      const hit = this.cache.get<NssResult<T>>(ck);
      if (hit) return hit.value;
    }
    const result = this.lookupUncached(database, specs, invoke);
    if (ck) this.cache.set(database, ck, result);
    return result;
  }

  /**
   * La marche `[STATUS=action]` de glibc. La règle elle-même vit dans
   * `chainWalk.ts` : le modèle de comptes (`LinuxUserManager`) la suit
   * aussi, et deux copies seraient deux occasions de diverger — une
   * machine où `getent passwd alice` et `id alice` ne répondent pas
   * pareil est pire qu'une machine où les deux se trompent.
   */
  private startWalk<T>(): NssWalk<T> {
    return startNssWalk<T>();
  }

  private lookupUncached<T>(
    database: string,
    specs: NssSourceSpec[],
    invoke: (source: INssSource) => NssResult<T> | undefined,
  ): NssResult<T> {
    void database;
    const walk = this.startWalk<T>();

    for (const spec of specs) {
      const src = this.sources.get(spec.name);
      const r: NssResult<T> = src ? (invoke(src) ?? { status: 'UNAVAIL' }) : { status: 'UNAVAIL' };
      const stop = walk.step(spec, r);
      if (stop) return stop;
    }
    return walk.finish();
  }

  /**
   * Variante asynchrone de {@link lookup}, pour la base `hosts`. Une
   * source sans jumeau asynchrone est interrogée par sa méthode
   * synchrone : `files` lit le VFS et n'a rien à attendre.
   *
   * Rien n'est mis en cache ici — `cacheKeyFor` refuse déjà toute
   * déclaration contenant `dns`, faute de révision pour l'estampiller.
   */
  async lookupAsync<T>(
    database: string,
    invoke: (source: INssSource) => NssResult<T> | Promise<NssResult<T>> | undefined,
  ): Promise<NssResult<T>> {
    const specs = sourcesFor(this.parsedConfig(), database);
    const walk = this.startWalk<T>();

    for (const spec of specs) {
      const src = this.sources.get(spec.name);
      const r: NssResult<T> = src ? (await invoke(src) ?? { status: 'UNAVAIL' }) : { status: 'UNAVAIL' };
      const stop = walk.step(spec, r);
      if (stop) return stop;
    }
    return walk.finish();
  }

  /** Contrepartie asynchrone de {@link lookupVia} (`getent -s <source>`). */
  async lookupViaAsync<T>(
    sourceName: string,
    invoke: (source: INssSource) => NssResult<T> | Promise<NssResult<T>> | undefined,
  ): Promise<NssResult<T>> {
    const src = this.sources.get(sourceName);
    if (!src) return { status: 'UNAVAIL' };
    return await invoke(src) ?? { status: 'UNAVAIL' };
  }

  lookupVia<T>(
    sourceName: string,
    invoke: (source: INssSource) => NssResult<T> | undefined,
  ): NssResult<T> {
    const src = this.sources.get(sourceName);
    if (!src) return { status: 'UNAVAIL' };
    return invoke(src) ?? { status: 'UNAVAIL' };
  }

  enumerateVia<T>(
    sourceName: string,
    invoke: (source: INssSource) => NssEnumResult<T> | undefined,
  ): NssEnumResult<T> {
    const src = this.sources.get(sourceName);
    if (!src) return { status: 'UNAVAIL', entries: [] };
    return invoke(src) ?? { status: 'UNAVAIL', entries: [] };
  }

  /**
   * Run an enumeration against every source. Concatenates results in
   * declaration order. SUCCESS once at least one source returned
   * entries; NOTFOUND if all sources were silent.
   */
  enumerate<T>(
    database: string,
    invoke: (source: INssSource) => NssEnumResult<T> | undefined,
    cacheKey?: string,
  ): NssEnumResult<T> {
    const config = this.parsedConfig();
    const specs = sourcesFor(config, database);

    const ck = cacheKey === undefined ? null : this.cacheKeyFor(database, specs, `e:${cacheKey}`);
    if (ck) {
      const hit = this.cache.get<NssEnumResult<T>>(ck);
      if (hit) return hit.value;
    }
    const result = this.enumerateUncached(specs, invoke);
    if (ck) this.cache.set(database, ck, result);
    return result;
  }

  private enumerateUncached<T>(
    specs: NssSourceSpec[],
    invoke: (source: INssSource) => NssEnumResult<T> | undefined,
  ): NssEnumResult<T> {
    const aggregate: T[] = [];
    let lastStatus: NssStatus = 'NOTFOUND';

    for (const spec of specs) {
      const src = this.sources.get(spec.name);
      if (!src) {
        lastStatus = 'UNAVAIL';
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return' && aggregate.length === 0) {
          return { status: 'UNAVAIL', entries: [] };
        }
        continue;
      }

      const r = invoke(src);
      if (!r) {
        lastStatus = 'UNAVAIL';
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return' && aggregate.length === 0) {
          return { status: 'UNAVAIL', entries: [] };
        }
        continue;
      }

      lastStatus = r.status;
      if (r.status === 'SUCCESS') {
        aggregate.push(...r.entries);
        const action = effectiveAction(spec, 'SUCCESS');
        if (action === 'return') return { status: 'SUCCESS', entries: aggregate };
        // 'continue' / 'merge' → keep accumulating.
      } else {
        const action = effectiveAction(spec, r.status);
        if (action === 'return' && aggregate.length === 0) return r;
      }
    }

    if (aggregate.length) return { status: 'SUCCESS', entries: aggregate };
    return { status: lastStatus, entries: [] };
  }

  // ─── Config materialisation ─────────────────────────────────────────

  /**
   * Parse the live `/etc/nsswitch.conf`. On a missing file, we still
   * return a parsed copy of `DEFAULT_NSSWITCH_CONF` — a fresh Ubuntu
   * always has the file, so this is the realistic happy path.
   */
  parsedConfig(): ReadonlyArray<NssDatabaseConfig> {
    const content = this.vfs.readFile('/etc/nsswitch.conf');
    if (!content) return [...FALLBACK_CONFIG];
    const parsed = parseNsswitchConf(content);
    return parsed.length ? parsed : [...FALLBACK_CONFIG];
  }

  /** Seed `/etc/nsswitch.conf` if it's missing — called from device boot. */
  seedConfigIfMissing(): void {
    if (this.vfs.readFile('/etc/nsswitch.conf') == null) {
      this.vfs.writeFile('/etc/nsswitch.conf', DEFAULT_NSSWITCH_CONF, 0, 0, 0o022);
    }
  }

  // ─── Reactive invalidation ──────────────────────────────────────────

  /**
   * Subscribe to IAM and host events so layered caches know when to
   * drop entries. We only forward to listeners — `NameServiceSwitch`
   * itself is stateless.
   *
   * The deviceId filter (when set) ensures a multi-host bus does not
   * cross-pollute invalidations.
   */
  private wireBusInvalidation(bus: IEventBus): void {
    const matches = (deviceId: string): boolean =>
      !this.deviceId || this.deviceId === deviceId;

    const fwd = (db: string) => {
      for (const l of this.invalidationListeners) l(db);
    };

    // ── IAM events ──────────────────────────────────────────────────
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.created', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.deleted', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.modified', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.password-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('shadow');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.lock-state-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('shadow');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.gecos-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.created', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.deleted', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.modified', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.membership-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));

    // ── Host / topology events ─────────────────────────────────────
    // Power-cycles and IP changes invalidate the `dns` source's view.
    this.busSubscriptions.push(bus.subscribe('device.power-on', () => fwd('hosts')));
    this.busSubscriptions.push(bus.subscribe('device.power-off', () => fwd('hosts')));
    this.busSubscriptions.push(bus.subscribe('port.config.ip-changed', () => fwd('hosts')));
  }
}
