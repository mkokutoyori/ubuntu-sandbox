import { IPv6Address, type MACAddress, type ICMPv6Packet, type NDPOption } from '@/network/core/types';
import { createICMPv6RouterAdvertisement } from './RadvdAdvertisement';
import {
  parseRadvdConfig, type RadvdConfigResult, type RadvdInterface, type RadvdLogLevel,
} from './RadvdConfig';

export const RADVD_VERSION = '2.19';
export const RADVD_CONFIG_PATH = '/etc/radvd.conf';
export const RADVD_PID_PATH = '/run/radvd.pid';

const MAX_INITIAL_RTR_ADVERT_INTERVAL = 16;
const MAX_INITIAL_RTR_ADVERTISEMENTS = 3;
const MIN_DELAY_BETWEEN_RAS_MIPV6 = 30 / 1000;
const MIN_MIN_RTR_ADV_INTERVAL = 3;
const MIN_MAX_RTR_ADV_INTERVAL = 4;
const MAX_MAX_RTR_ADV_INTERVAL = 1800;
const MAX_ADV_DEFAULT_LIFETIME = 9000;
const MAX_ADV_REACHABLE_TIME = 3600000;
const MIN_ADV_LINK_MTU = 1280;
const MIN_ADV_VALID_LIFETIME = 7200;
const MAX_RA_DELAY_SECONDS = 0.5;
const IFACE_SETUP_DELAY = 1;
const ALL_NODES = new IPv6Address('ff02::1');

export interface RadvdPortView {
  readonly name: string;
  readonly isUp: boolean;
  readonly isRunning: boolean;
  readonly mtu: number;
  readonly mac: MACAddress;
  readonly linkLocal: IPv6Address | null;
  readonly addresses: readonly IPv6Address[];
  readonly globalPrefixes: ReadonlyArray<{ prefix: IPv6Address; length: number }>;
}

export interface RadvdPlatform {
  readConfig(path: string): string | null;
  ports(): readonly RadvdPortView[];
  forwardingAll(): boolean;
  forwardingOn(name: string): boolean;
  joinAllRouters(name: string): void;
  leaveAllRouters(name: string): void;
  send(name: string, source: IPv6Address, destination: IPv6Address, message: ICMPv6Packet): boolean;
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  random(): number;
  log(level: RadvdLogLevel | 'debug', message: string): void;
}

interface PrefixState {
  validLifetime: number;
  preferredLifetime: number;
}

interface InterfaceRuntime {
  config: RadvdInterface;
  changed: boolean;
  ready: boolean;
  raCount: number;
  ceaseAdv: boolean;
  unicastOnly: boolean;
  source: IPv6Address | null;
  mac: MACAddress | null;
  maxMtu: number;
  lastRaAt: number;
  lastMulticastAt: number;
  cancelTimer: (() => void) | null;
  prefixState: PrefixState[];
}

export interface RadvdRunResult {
  ok: boolean;
  stderr: string[];
}

function numberText(value: number): string {
  return value.toFixed(2);
}

export class LinuxRadvdService {
  private runtimes: InterfaceRuntime[] = [];
  private running = false;
  private configPath: string = RADVD_CONFIG_PATH;

  constructor(private readonly platform: RadvdPlatform) {}

  isRunning(): boolean { return this.running; }

  setConfigPath(path: string): void { this.configPath = path; }

  interfaceNames(): string[] { return this.runtimes.map((runtime) => runtime.config.name); }

  checkConfig(path: string = RADVD_CONFIG_PATH): RadvdConfigResult & { missing: boolean } {
    const text = this.platform.readConfig(path);
    if (text === null) {
      return { interfaces: null, stderr: [], log: [{ level: 'err', message: `can't open ${path}: No such file or directory` }], missing: true };
    }
    return { ...parseRadvdConfig(text, path), missing: false };
  }

  start(path: string = this.configPath): RadvdRunResult {
    this.platform.log('info', `version ${RADVD_VERSION} started`);
    const parsed = this.checkConfig(path);
    this.flush(parsed);
    if (parsed.interfaces === null) {
      this.platform.log('err', 'exiting, failed to read config file');
      return { ok: false, stderr: parsed.stderr };
    }
    if (!this.platform.forwardingAll()) {
      this.platform.log('warning', 'IPv6 forwarding seems to be disabled, but continuing anyway');
    }
    const outcome = this.setupAll(parsed.interfaces);
    if (!outcome.ok) return outcome;
    this.running = true;
    return { ok: true, stderr: [] };
  }

  stop(): void {
    if (!this.running) return;
    this.platform.log('info', 'sending stop adverts');
    for (const runtime of this.runtimes) {
      if (!runtime.unicastOnly) {
        runtime.ceaseAdv = true;
        this.sendForAll(runtime, null);
      }
    }
    this.halt();
  }

  reload(path: string = this.configPath): RadvdRunResult {
    this.cancelTimers();
    for (const runtime of this.runtimes) {
      if (runtime.ready) this.platform.leaveAllRouters(runtime.config.name);
    }
    this.platform.log('info', 'attempting to reread config file');
    const parsed = this.checkConfig(path);
    this.flush(parsed);
    if (parsed.interfaces === null) {
      this.platform.log('err', 'exiting, failed to read config file');
      this.halt();
      return { ok: false, stderr: parsed.stderr };
    }
    const outcome = this.setupAll(parsed.interfaces);
    if (!outcome.ok) { this.halt(); return outcome; }
    this.platform.log('info', 'resuming normal operation');
    return { ok: true, stderr: [] };
  }

  resetPrefixLifetimes(): void {
    for (const runtime of this.runtimes) {
      this.platform.log('info', `Resetting prefix lifetimes on ${runtime.config.name}`);
      runtime.config.prefixes.forEach((prefix, index) => {
        runtime.prefixState[index] = { validLifetime: prefix.validLifetime, preferredLifetime: prefix.preferredLifetime };
      });
    }
  }

  linkChanged(name: string): void {
    const runtime = this.runtimes.find((candidate) => candidate.config.name === name);
    if (runtime === undefined || !this.running) return;
    runtime.changed = true;
    runtime.ready = false;
    runtime.raCount = 0;
    this.reschedule(runtime, 0);
  }

  private flush(parsed: RadvdConfigResult): void {
    for (const entry of parsed.log) this.platform.log(entry.level, entry.message);
  }

  private halt(): void {
    this.cancelTimers();
    for (const runtime of this.runtimes) {
      if (runtime.ready) this.platform.leaveAllRouters(runtime.config.name);
    }
    this.running = false;
    this.runtimes = [];
  }

  private cancelTimers(): void {
    for (const runtime of this.runtimes) {
      runtime.cancelTimer?.();
      runtime.cancelTimer = null;
    }
  }

  private setupAll(interfaces: RadvdInterface[]): RadvdRunResult {
    this.runtimes = interfaces.map((config) => ({
      config, changed: true, ready: false, raCount: 0, ceaseAdv: false, unicastOnly: config.unicastOnly,
      source: null, mac: null, maxMtu: -1, lastRaAt: 0, lastMulticastAt: 0, cancelTimer: null,
      prefixState: config.prefixes.map((prefix) => ({
        validLifetime: prefix.validLifetime, preferredLifetime: prefix.preferredLifetime,
      })),
    }));
    for (const runtime of this.runtimes) {
      if (this.setupInterface(runtime) < 0) {
        if (runtime.config.ignoreIfMissing) {
          this.platform.log('debug', `interface ${runtime.config.name} does not exist or is not set up properly, ignoring the interface`);
          continue;
        }
        this.platform.log('err', `interface ${runtime.config.name} does not exist or is not set up properly`);
        this.halt();
        return { ok: false, stderr: [] };
      }
      this.kickoff(runtime);
    }
    return { ok: true, stderr: [] };
  }

  private setupInterface(runtime: InterfaceRuntime): number {
    const config = runtime.config;
    runtime.changed = false;
    runtime.ready = false;
    const port = this.platform.ports().find((candidate) => candidate.name === config.name);
    if (port === undefined) {
      this.platform.log('err', `${config.name} not found: No such device`);
      return -1;
    }
    if (!port.isUp || !port.isRunning) return -1;
    runtime.maxMtu = port.mtu;
    runtime.mac = port.mac;
    if (this.checkInterface(runtime) < 0) return -1;
    const linkLocal = port.linkLocal;
    if (linkLocal === null) {
      if (!config.ignoreIfMissing) this.platform.log('err', `no linklocal address configured on ${config.name}`);
      return -1;
    }
    runtime.source = config.raSourceAddresses.length === 0
      ? linkLocal
      : config.raSourceAddresses.find((wanted) => port.addresses.some((own) => own.equals(wanted))) ?? null;
    if (runtime.source === null) return -1;
    this.platform.joinAllRouters(config.name);
    runtime.ready = true;
    return 0;
  }

  private checkInterface(runtime: InterfaceRuntime): number {
    const config = runtime.config;
    let failed = false;
    const mobile = config.advHomeAgentFlag || config.advHomeAgentInfo || config.advIntervalOpt
      || config.prefixes.some((prefix) => prefix.routerAddr);
    if (mobile) this.platform.log('info', 'using Mobile IPv6 extensions');
    if (!this.platform.forwardingOn(config.name)) {
      this.platform.log('warning', 'IPv6 forwarding on interface seems to be disabled, but continuing anyway');
    }
    if (config.minRtrAdvInterval < 0) config.minRtrAdvInterval = 0.33 * config.maxRtrAdvInterval;
    const minimum = mobile ? 3 / 100 : MIN_MIN_RTR_ADV_INTERVAL;
    if (config.minRtrAdvInterval < minimum || config.minRtrAdvInterval > 0.75 * config.maxRtrAdvInterval) {
      this.platform.log('err', `MinRtrAdvInterval for ${config.name} (${numberText(config.minRtrAdvInterval)}) must be at least ${mobile ? numberText(minimum) : String(minimum)} but no more than 3/4 of MaxRtrAdvInterval (${numberText(0.75 * config.maxRtrAdvInterval)})`);
      failed = true;
    }
    const maxMinimum = mobile ? 7 / 100 : MIN_MAX_RTR_ADV_INTERVAL;
    if (config.maxRtrAdvInterval < maxMinimum || config.maxRtrAdvInterval > MAX_MAX_RTR_ADV_INTERVAL) {
      this.platform.log('err', `MaxRtrAdvInterval for ${config.name} (${numberText(config.maxRtrAdvInterval)}) must be between ${mobile ? numberText(maxMinimum) : String(maxMinimum)} and ${MAX_MAX_RTR_ADV_INTERVAL}`);
      failed = true;
    }
    const minDelay = mobile ? MIN_DELAY_BETWEEN_RAS_MIPV6 : 3.0;
    if (config.minDelayBetweenRAs < minDelay) {
      this.platform.log('err', `MinDelayBetweenRAs for ${config.name} (${numberText(config.minDelayBetweenRAs)}) must be at least ${numberText(minDelay)}`);
      failed = true;
    }
    if (config.advLinkMTU !== 0 && (config.advLinkMTU < MIN_ADV_LINK_MTU || (runtime.maxMtu !== -1 && config.advLinkMTU > runtime.maxMtu))) {
      this.platform.log('err', `AdvLinkMTU for ${config.name} (${config.advLinkMTU}) must be zero or between ${MIN_ADV_LINK_MTU} and ${runtime.maxMtu}`);
      failed = true;
    }
    if (config.advReachableTime > MAX_ADV_REACHABLE_TIME) {
      this.platform.log('err', `AdvReachableTime for ${config.name} (${config.advReachableTime}) must not be greater than ${MAX_ADV_REACHABLE_TIME}`);
      failed = true;
    }
    if (config.advDefaultLifetime < 0) config.advDefaultLifetime = Math.max(1, Math.trunc(3.0 * config.maxRtrAdvInterval));
    const lifetimeMinimum = Math.max(1, config.maxRtrAdvInterval);
    if (config.advDefaultLifetime !== 0 && (config.advDefaultLifetime > MAX_ADV_DEFAULT_LIFETIME || config.advDefaultLifetime < lifetimeMinimum)) {
      this.platform.log('err', `AdvDefaultLifetime for ${config.name} (${config.advDefaultLifetime}) must be zero or between ${Math.trunc(lifetimeMinimum)} and ${MAX_ADV_DEFAULT_LIFETIME}`);
      failed = true;
    }
    if (config.homeAgentLifetime < 0) config.homeAgentLifetime = config.advDefaultLifetime;
    if (config.advHomeAgentInfo && (config.homeAgentLifetime > 65520 || config.homeAgentLifetime < 1)) {
      this.platform.log('err', `HomeAgentLifetime for ${config.name} (${config.homeAgentLifetime}) must be between 1 and 65520`);
      failed = true;
    }
    if (config.advHomeAgentInfo && !config.advHomeAgentFlag) {
      this.platform.log('err', `AdvHomeAgentFlag for ${config.name} must be set with HomeAgentInfo`);
      failed = true;
    }
    if (config.advMobRtrSupportFlag && !config.advHomeAgentInfo) {
      this.platform.log('err', `AdvHomeAgentInfo for ${config.name} must be set with AdvMobRtrSupportFlag`);
      failed = true;
    }
    for (const prefix of config.prefixes) {
      if (prefix.preferredLifetime > prefix.validLifetime) {
        this.platform.log('err', `AdvValidLifetime for ${config.name} (${prefix.validLifetime}) must be greater than AdvPreferredLifetime for`);
        failed = true;
      }
    }
    for (const route of config.routes) {
      if (route.address.isUnspecified()) {
        if ((route.lifetime === 0) !== (config.advDefaultLifetime === 0)) {
          this.platform.log('err', `route 0::/0 lifetime (${route.lifetime}) conflicts with AdvDefaultLifetime (${config.advDefaultLifetime}), default routes will flap!`);
        }
      }
    }
    return failed ? -1 : 0;
  }

  private kickoff(runtime: InterfaceRuntime): void {
    runtime.lastRaAt = this.platform.nowMs();
    if (runtime.unicastOnly) return;
    runtime.lastMulticastAt = this.platform.nowMs();
    this.sendForAll(runtime, null);
    this.reschedule(runtime, Math.min(MAX_INITIAL_RTR_ADVERT_INTERVAL, runtime.config.maxRtrAdvInterval));
  }

  private reschedule(runtime: InterfaceRuntime, next: number): void {
    let seconds = next;
    if (!runtime.changed && !runtime.ready) seconds = 10 * runtime.config.maxRtrAdvInterval;
    else if (next === 0) seconds = IFACE_SETUP_DELAY;
    else if (runtime.raCount < MAX_INITIAL_RTR_ADVERTISEMENTS) seconds = Math.min(MAX_INITIAL_RTR_ADVERT_INTERVAL, runtime.config.maxRtrAdvInterval);
    runtime.cancelTimer?.();
    runtime.cancelTimer = this.platform.schedule(() => this.onTimer(runtime), seconds * 1000);
  }

  private onTimer(runtime: InterfaceRuntime): void {
    runtime.cancelTimer = null;
    this.sendForAll(runtime, null);
    const config = runtime.config;
    this.reschedule(runtime, config.minRtrAdvInterval + this.platform.random() * (config.maxRtrAdvInterval - config.minRtrAdvInterval));
  }

  private ensureSetup(runtime: InterfaceRuntime): boolean {
    if (runtime.changed) this.setupInterface(runtime);
    return runtime.ready;
  }

  private sendForAll(runtime: InterfaceRuntime, destination: IPv6Address | null): number {
    if (!this.ensureSetup(runtime)) return -1;
    if (runtime.raCount < MAX_INITIAL_RTR_ADVERTISEMENTS) runtime.raCount++;
    const config = runtime.config;
    if (config.clients.length === 0) {
      if (destination === null && runtime.unicastOnly) return 0;
      return this.sendOne(runtime, destination);
    }
    for (const client of config.clients) {
      if (destination !== null && !destination.equals(client)) continue;
      this.sendOne(runtime, client);
      if (destination !== null) return 0;
    }
    return 0;
  }

  private sendOne(runtime: InterfaceRuntime, destination: IPv6Address | null): number {
    const config = runtime.config;
    if (!config.advSendAdvert) return 0;
    const target = destination ?? ALL_NODES;
    if (destination === null) runtime.lastMulticastAt = this.platform.nowMs();
    this.updateTimes(runtime);
    const message = createICMPv6RouterAdvertisement(this.advertisementFor(runtime));
    if (runtime.source !== null) this.platform.send(config.name, runtime.source, target, message);
    return 0;
  }

  private updateTimes(runtime: InterfaceRuntime): void {
    const now = this.platform.nowMs();
    const elapsed = Math.max(0, Math.trunc((now - runtime.lastRaAt) / 1000));
    runtime.lastRaAt = now;
    runtime.config.prefixes.forEach((prefix, index) => {
      const state = runtime.prefixState[index];
      if (!prefix.decrementLifetimes || state.preferredLifetime > 0) {
        if (!(runtime.ceaseAdv && prefix.deprecatePrefix) && prefix.decrementLifetimes) {
          state.validLifetime = state.validLifetime > elapsed ? state.validLifetime - elapsed : 0;
          state.preferredLifetime = state.preferredLifetime > elapsed ? state.preferredLifetime - elapsed : 0;
        }
      }
    });
  }

  private advertisementFor(runtime: InterfaceRuntime) {
    const config = runtime.config;
    const options: NDPOption[] = [];
    config.prefixes.forEach((prefix, index) => {
      const state = runtime.prefixState[index];
      if (prefix.decrementLifetimes && state.preferredLifetime === 0) return;
      const advertised = prefix.address.isUnspecified() ? this.autoPrefixes(runtime) : [{ address: prefix.address, length: prefix.prefixLength }];
      for (const entry of advertised) {
        let valid = state.validLifetime;
        let preferred = state.preferredLifetime;
        if (runtime.ceaseAdv && prefix.deprecatePrefix) {
          valid = Math.min(valid, MIN_ADV_VALID_LIFETIME);
          preferred = 0;
        }
        options.push({
          optionType: 'prefix-info', prefixLength: entry.length, onLink: prefix.onLink, autonomous: prefix.autonomous,
          validLifetime: valid, preferredLifetime: preferred, prefix: entry.address.getNetworkPrefix(entry.length),
        });
      }
    });
    for (const route of config.routes) {
      options.push({
        optionType: 'route-info', prefix: route.address, prefixLength: route.prefixLength, preference: route.preference,
        lifetime: runtime.ceaseAdv && route.removeRoute ? 0 : route.lifetime,
      });
    }
    for (const rdnss of config.rdnss) {
      options.push({
        optionType: 'rdnss', lifetime: runtime.ceaseAdv && rdnss.flush ? 0 : rdnss.lifetime, addresses: [...rdnss.addresses],
      });
    }
    for (const dnssl of config.dnssl) {
      options.push({
        optionType: 'dnssl', lifetime: runtime.ceaseAdv && dnssl.flush ? 0 : dnssl.lifetime, domains: [...dnssl.suffixes],
      });
    }
    if (config.advLinkMTU !== 0) options.push({ optionType: 'mtu', mtu: config.advLinkMTU });
    if (config.advSourceLLAddress && runtime.mac !== null) options.push({ optionType: 'source-link-layer', address: runtime.mac });
    return {
      curHopLimit: config.advCurHopLimit,
      managed: config.advManagedFlag,
      other: config.advOtherConfigFlag,
      routerLifetime: runtime.ceaseAdv || !this.platform.forwardingAll() ? 0 : config.advDefaultLifetime,
      preference: config.advDefaultPreference,
      reachableTime: config.advReachableTime,
      retransTimer: config.advRetransTimer,
      options,
    };
  }

  private autoPrefixes(runtime: InterfaceRuntime): Array<{ address: IPv6Address; length: number }> {
    const port = this.platform.ports().find((candidate) => candidate.name === runtime.config.name);
    return port === undefined ? [] : port.globalPrefixes.map((entry) => ({ address: entry.prefix, length: entry.length }));
  }

  receiveSolicitation(portName: string, source: IPv6Address, hasSourceLinkLayer: boolean, hopLimit: number): void {
    if (!this.running) return;
    const runtime = this.runtimes.find((candidate) => candidate.config.name === portName);
    if (runtime === undefined) return;
    if (!runtime.ready && this.setupInterface(runtime) !== 0) return;
    if (hopLimit !== 255) return;
    this.platform.log('debug', `${portName} received RS from: ${source}`);
    const unicastResponse = runtime.config.advRASolicitedUnicast && !source.isUnspecified();
    if (hasSourceLinkLayer && source.isUnspecified()) {
      this.platform.log('warning', 'received icmpv6 RS packet with unspecified source address and there is a lladdr option');
      return;
    }
    const delay = MAX_RA_DELAY_SECONDS * this.platform.random();
    if (runtime.unicastOnly || unicastResponse) {
      this.sendForAll(runtime, source);
    } else if ((this.platform.nowMs() - runtime.lastMulticastAt) / 1000 < runtime.config.minDelayBetweenRAs) {
      const next = runtime.config.minDelayBetweenRAs - (this.platform.nowMs() - runtime.lastMulticastAt) / 1000 + delay;
      this.reschedule(runtime, next);
    } else {
      this.sendForAll(runtime, null);
      const config = runtime.config;
      this.reschedule(runtime, config.minRtrAdvInterval + this.platform.random() * (config.maxRtrAdvInterval - config.minRtrAdvInterval));
    }
  }

  receiveAdvertisement(
    portName: string, source: IPv6Address, advertisement: {
      curHopLimit: number; managed: boolean; other: boolean; reachableTime: number; retransTimer: number;
      options: readonly NDPOption[];
    },
  ): void {
    if (!this.running) return;
    const runtime = this.runtimes.find((candidate) => candidate.config.name === portName);
    if (runtime === undefined || !runtime.ready) return;
    const config = runtime.config;
    const from = source.toString();
    if (advertisement.curHopLimit !== 0 && config.advCurHopLimit !== 0 && advertisement.curHopLimit !== config.advCurHopLimit) {
      this.platform.log('warning', `our AdvCurHopLimit on ${config.name} doesn't agree with ${from}`);
    }
    if (advertisement.managed && !config.advManagedFlag) {
      this.platform.log('warning', `our AdvManagedFlag on ${config.name} doesn't agree with ${from}`);
    }
    if (advertisement.other && !config.advOtherConfigFlag) {
      this.platform.log('warning', `our AdvOtherConfigFlag on ${config.name} doesn't agree with ${from}`);
    }
    if (advertisement.reachableTime !== 0 && config.advReachableTime !== 0 && advertisement.reachableTime !== config.advReachableTime) {
      this.platform.log('warning', `our AdvReachableTime on ${config.name} doesn't agree with ${from}`);
    }
    if (advertisement.retransTimer !== 0 && config.advRetransTimer !== 0 && advertisement.retransTimer !== config.advRetransTimer) {
      this.platform.log('warning', `our AdvRetransTimer on ${config.name} doesn't agree with ${from}`);
    }
    for (const option of advertisement.options) {
      if (option.optionType === 'mtu' && config.advLinkMTU !== 0 && option.mtu !== config.advLinkMTU) {
        this.platform.log('warning', `our AdvLinkMTU on ${config.name} doesn't agree with ${from}`);
      } else if (option.optionType === 'prefix-info') {
        for (const prefix of config.prefixes) {
          if (prefix.prefixLength !== option.prefixLength) continue;
          if (!prefix.address.getNetworkPrefix(prefix.prefixLength).equals(option.prefix.getNetworkPrefix(prefix.prefixLength))) continue;
          if (!prefix.decrementLifetimes && option.validLifetime !== prefix.validLifetime) {
            this.platform.log('warning', `our AdvValidLifetime on ${config.name} for ${prefix.address} doesn't agree with ${from}`);
          }
          if (!prefix.decrementLifetimes && option.preferredLifetime !== prefix.preferredLifetime) {
            this.platform.log('warning', `our AdvPreferredLifetime on ${config.name} for ${prefix.address} doesn't agree with ${from}`);
          }
        }
      } else if (option.optionType === 'rdnss') {
        for (const address of option.addresses) {
          if (!config.rdnss.some((own) => own.addresses.some((candidate) => candidate.equals(address)))) {
            this.platform.log('warning', `RDNSS address ${address} received on ${config.name} from ${from} is not advertised by us`);
          }
        }
      } else if (option.optionType === 'dnssl') {
        for (const domain of option.domains) {
          if (!config.dnssl.some((own) => own.suffixes.includes(domain))) {
            this.platform.log('warning', `DNSSL suffix ${domain} received on ${config.name} from ${from} is not advertised by us`);
          }
        }
      }
    }
  }
}

