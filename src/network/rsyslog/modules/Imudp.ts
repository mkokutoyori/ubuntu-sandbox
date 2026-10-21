import type { NvList } from '../config/Ast';
import { arrayParam, getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import type { AllowedSenderList } from '../engine/AllowedSenders';
import type { Datagram, Listener } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { StatsObject } from '../engine/Statistics';
import type {
  DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext, ModuleRateLimiter,
} from '../engine/Modules';

const MAX_WORKER_THREADS = 32;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIME_REQUERY = 2;
const DEFAULT_RATE_LIMIT_BURST = 10000;
const SCHEDULING_PRIORITY_UNSET = -12345;

const SCHEDULING_PRIORITY_RANGE: Readonly<Record<string, { min: number; max: number }>> = {
  fifo: { min: 1, max: 99 }, rr: { min: 1, max: 99 }, other: { min: 0, max: 0 },
};

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'schedulingpolicy', type: 'word' }, { name: 'schedulingpriority', type: 'int' }, { name: 'batchsize', type: 'int' },
  { name: 'threads', type: 'positive' }, { name: 'timerequery', type: 'int' }, { name: 'preservecase', type: 'binary' },
  { name: 'allowedsender', type: 'array' },
];

const INPUT_PARAMS: readonly ParamDescriptor[] = [
  { name: 'port', type: 'array', required: true }, { name: 'listenportfilename', type: 'string' }, { name: 'defaulttz', type: 'string' },
  { name: 'inputname', type: 'word' }, { name: 'inputname.appendport', type: 'binary' }, { name: 'name', type: 'word' },
  { name: 'name.appendport', type: 'binary' }, { name: 'address', type: 'string' }, { name: 'device', type: 'string' },
  { name: 'ratelimit.name', type: 'string' }, { name: 'ratelimit.interval', type: 'int' }, { name: 'ratelimit.burst', type: 'int' },
  { name: 'rcvbufsize', type: 'size' }, { name: 'ipfreebind', type: 'int' }, { name: 'ruleset', type: 'string' },
  { name: 'allowedsender', type: 'array' },
];

interface ImudpModuleConfig {
  configuredViaModule: boolean;
  workerThreads: number;
  batchSize: number;
  timeRequery: number;
  schedulingPriority: number;
  schedulingPolicy: string | null;
  preserveCase: boolean;
  allowedSenders: AllowedSenderList | null;
}

interface ImudpLegacyState {
  bindRuleset: string | null;
  bindAddress: string | null;
  bindDevice: string | null;
  schedulingPolicy: string | null;
  schedulingPriority: number;
  timeRequery: number;
}

function defaultModuleConfig(): ImudpModuleConfig {
  return {
    configuredViaModule: false, workerThreads: 1, batchSize: DEFAULT_BATCH_SIZE, timeRequery: DEFAULT_TIME_REQUERY,
    schedulingPriority: SCHEDULING_PRIORITY_UNSET, schedulingPolicy: null, preserveCase: false, allowedSenders: null,
  };
}

function defaultLegacyState(): ImudpLegacyState {
  return {
    bindRuleset: null, bindAddress: null, bindDevice: null, schedulingPolicy: null, schedulingPriority: SCHEDULING_PRIORITY_UNSET,
    timeRequery: DEFAULT_TIME_REQUERY,
  };
}

function moduleConfig(context: ModuleContext): ImudpModuleConfig {
  return context.moduleState('imudp.config', defaultModuleConfig);
}

function legacyState(context: ModuleContext): ImudpLegacyState {
  return context.moduleState('imudp.legacy', defaultLegacyState);
}

interface ListenerSettings {
  port: string;
  portListenFile: string | null;
  address: string | null;
  device: string | null;
  ruleset: string | null;
  inputName: string | null;
  appendPortToInputName: boolean;
  defaultTimeZone: string | null;
  rateInterval: number;
  rateBurst: number;
  rateName: string | null;
  receiveBuffer: number;
  freeBind: 0 | 1 | 2;
  allowedSenders: AllowedSenderList | null;
}

interface WorkerCounters {
  calledRecvmmsg: number;
  calledRecvmsg: number;
  messagesReceived: number;
}

function workerCounters(context: ModuleContext): WorkerCounters {
  return context.moduleState('imudp.workers', () => {
    const first: WorkerCounters = { calledRecvmmsg: 0, calledRecvmsg: 0, messagesReceived: 0 };
    for (let index = 0; index < moduleConfig(context).workerThreads; index++) {
      const state = index === 0 ? first : { calledRecvmmsg: 0, calledRecvmsg: 0, messagesReceived: 0 };
      const object = context.statistics.create(`imudp(w${index})`, { origin: 'imudp' });
      object.addCounter({ name: 'called.recvmmsg', read: () => state.calledRecvmmsg, reset: () => { state.calledRecvmmsg = 0; } });
      object.addCounter({ name: 'called.recvmsg', read: () => state.calledRecvmsg, reset: () => { state.calledRecvmsg = 0; } });
      object.addCounter({ name: 'msgs.received', read: () => state.messagesReceived, reset: () => { state.messagesReceived = 0; } });
    }
    return first;
  });
}

class ImudpListener implements InputInstance {
  readonly bindsBeforePrivilegeDrop = true;
  readonly description: string;
  private listeners: Listener[] = [];
  private readonly counters = new Map<string, { submitted: number; disallowed: number }>();
  private statisticsObjects: StatsObject[] = [];

  constructor(
    private readonly settings: ListenerSettings,
    private readonly context: InputContext,
    private readonly limiter: (displayName: string) => ModuleRateLimiter | null,
  ) {
    this.description = `imudp(${settings.address ?? '*'}/${settings.port})`;
  }

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(
        `imudp: ruleset '${ruleset}' for ${this.settings.address ?? '*'}:${this.settings.port} not found - using default ruleset instead`, RS_RET.ERR,
      );
    }
  }

  private effectiveRuleset(): string | null {
    const ruleset = this.settings.ruleset;
    return ruleset !== null && this.context.rulesetExists(ruleset) ? ruleset : null;
  }

  private effectiveAllowedSenders(): AllowedSenderList {
    return this.settings.allowedSenders ?? moduleConfig(this.context).allowedSenders ?? this.context.settings.allowedSenders.udp;
  }

  start(): boolean {
    const settings = this.settings;
    const bindAddress = settings.address === null || settings.address === '*' ? null : settings.address;
    const bindName = bindAddress ?? '*';
    const port = settings.port === '' ? '514' : settings.port;
    const portNumber = Number(port);
    const outcome = this.context.host.network.listenDatagram(
      Number.isInteger(portNumber) ? portNumber : -1,
      bindAddress,
      {
        family: this.context.settings.ipProtocol,
        receiveBufferBytes: settings.receiveBuffer > 0 ? settings.receiveBuffer : undefined,
        device: settings.device ?? undefined,
        freeBind: settings.freeBind,
      },
      (datagram) => this.receive(datagram),
    );
    if (outcome.listeners.length === 0) {
      this.context.runtime.error('No UDP socket could successfully be initialized, some functionality may be disabled.\n', RS_RET.NO_ERRCODE);
      this.context.runtime.error(`imudp: Could not create udp listener, ignoring port ${port} bind-address ${bindAddress ?? '(null)'}.`, RS_RET.NO_ERRCODE);
      return false;
    }
    if (settings.portListenFile !== null) {
      if (outcome.listeners.length !== 1) {
        this.context.runtime.error(
          `imudp: listenPortFileName requires exactly one bound socket, got ${outcome.listeners.length}; set address to a single local address`,
          RS_RET.INVALID_PARAMS,
        );
        for (const listener of outcome.listeners) listener.close();
        return false;
      }
      this.context.host.files.write(settings.portListenFile, `${outcome.listeners[0].port}\n`);
    }
    this.listeners = outcome.listeners;
    for (const listener of this.listeners) this.registerListenerStatistics(this.displayName(listener.family));
    workerCounters(this.context);
    return true;
  }

  private registerListenerStatistics(name: string): void {
    const state = { submitted: 0, disallowed: 0 };
    const object = this.context.statistics.create(name, { origin: 'imudp' });
    object.addCounter({ name: 'submitted', read: () => state.submitted, reset: () => { state.submitted = 0; } });
    object.addCounter({ name: 'disallowed', read: () => state.disallowed, reset: () => { state.disallowed = 0; } });
    this.counters.set(name, state);
    this.statisticsObjects.push(object);
  }

  stop(): void {
    for (const listener of this.listeners) listener.close();
    this.listeners = [];
    for (const object of this.statisticsObjects) this.context.statistics.remove(object);
    this.statisticsObjects = [];
    this.counters.clear();
  }

  private displayName(family: 'IPv4' | 'IPv6'): string {
    const settings = this.settings;
    return `${settings.inputName ?? 'imudp'}(${settings.address === null || settings.address === '*' ? '*' : settings.address}/${settings.port === '' ? '514' : settings.port}/${family})`;
  }

  private receive(datagram: Datagram): void {
    const worker = workerCounters(this.context);
    worker.calledRecvmmsg++;
    worker.messagesReceived++;
    if (datagram.payload.length === 0) return;
    const family: 'IPv4' | 'IPv6' = datagram.sourceIp.includes(':') ? 'IPv6' : 'IPv4';
    const display = this.displayName(this.listeners[0]?.family ?? family);
    const counters = this.counters.get(display);
    const list = this.effectiveAllowedSenders();
    const verdict = list.verdict(datagram.sourceIp, '', false);
    if (verdict === 'denied') {
      if (counters !== undefined) counters.disallowed++;
      this.context.runtime.error('imudp: UDP message from disallowed sender discarded', RS_RET.NO_ERRCODE);
      return;
    }
    const baseName = this.settings.inputName ?? 'imudp';
    const inputName = this.settings.appendPortToInputName ? `${baseName}${this.settings.port === '' ? '514' : this.settings.port}` : baseName;
    if (counters !== undefined) counters.submitted++;
    this.context.submitter.submit({
      raw: '',
      bytes: datagram.payload,
      inputName,
      fromHost: null,
      fromHostIp: null,
      fromHostPort: null,
      ruleset: this.effectiveRuleset(),
      sender: { ip: datagram.sourceIp, port: datagram.sourcePort },
      preserveCase: moduleConfig(this.context).preserveCase,
      pendingAcl: verdict === 'needs-name' ? list : undefined,
      defaultTimeZone: this.settings.defaultTimeZone,
      limiter: this.limiterFor(display) ?? undefined,
    });
  }

  private readonly limiters = new Map<string, ModuleRateLimiter | null>();

  private limiterFor(display: string): ModuleRateLimiter | null {
    if (!this.limiters.has(display)) this.limiters.set(display, this.limiter(display));
    return this.limiters.get(display) ?? null;
  }
}

function createInstances(params: NvList, context: InputContext): ImudpListener[] | null {
  const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
  const values = getParams(params, INPUT_PARAMS, { report, uidOf: () => null, gidOf: () => null });
  if (values === null) {
    context.runtime.error('imudp: required parameter are missing\n', RS_RET.MISSING_CNFPARAMS);
    return null;
  }
  reportUnused(params, report);
  const ports = arrayParam(values, 'port') ?? [];
  const listenPortFile = stringParam(values, 'listenportfilename') ?? null;
  if (listenPortFile !== null && ports.length > 1) {
    context.runtime.error('imudp: listenPortFileName cannot be used with multiple port values; use one input per port', RS_RET.INVALID_PARAMS);
    return null;
  }
  const name = stringParam(values, 'name');
  const legacyName = stringParam(values, 'inputname');
  let inputName: string | null = null;
  if (legacyName !== undefined) context.runtime.error('imudp: deprecated parameter inputname used. Suggest to use name instead', RS_RET.DEPRECATED);
  if (name !== undefined && legacyName !== undefined) {
    context.runtime.error('imudp: name and inputname parameter specified - only one can be used', RS_RET.INVALID_PARAMS);
    return null;
  }
  inputName = name ?? legacyName ?? null;
  const appendPort = numberParam(values, 'name.appendport');
  const legacyAppendPort = numberParam(values, 'inputname.appendport');
  if (legacyAppendPort !== undefined) {
    context.runtime.error('imudp: deprecated parameter inputname.appendport used. Suggest to use name.appendport instead', RS_RET.DEPRECATED);
  }
  if (appendPort !== undefined && legacyAppendPort !== undefined) {
    context.runtime.error('imudp: name.appendport and inputname.appendport parameter specified - only one can be used', RS_RET.INVALID_PARAMS);
    return null;
  }
  const rateName = stringParam(values, 'ratelimit.name');
  let rateInterval = numberParam(values, 'ratelimit.interval') ?? -1;
  let rateBurst = numberParam(values, 'ratelimit.burst') ?? -1;
  if (rateName !== undefined) {
    if (rateInterval !== -1 || rateBurst !== -1) {
      context.runtime.error('imudp: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using ratelimit.name', RS_RET.INVALID_PARAMS);
    }
    rateInterval = 0;
    rateBurst = 0;
  } else {
    if (rateInterval === -1) rateInterval = 0;
    if (rateBurst === -1) rateBurst = DEFAULT_RATE_LIMIT_BURST;
  }
  let receiveBuffer = 0;
  const requestedBuffer = numberParam(values, 'rcvbufsize');
  if (requestedBuffer !== undefined) {
    if (requestedBuffer > 1024 * 1024 * 1024) context.runtime.error('imudp: rcvbufsize maximum is 1 GiB, using default instead', RS_RET.MISSING_CNFPARAMS);
    else receiveBuffer = requestedBuffer;
  }
  const allowedEntries = arrayParam(values, 'allowedsender');
  let allowedSenders: AllowedSenderList | null = null;
  if (allowedEntries !== undefined) {
    allowedSenders = context.allowedSenders(allowedEntries, 'imudp');
    if (allowedSenders === null) return null;
  }
  const instances: ImudpListener[] = [];
  for (const port of ports) {
    const settings: ListenerSettings = {
      port, portListenFile: listenPortFile, address: stringParam(values, 'address') ?? null, device: stringParam(values, 'device') ?? null,
      ruleset: stringParam(values, 'ruleset') ?? null, inputName, appendPortToInputName: (appendPort ?? legacyAppendPort ?? 0) !== 0,
      defaultTimeZone: stringParam(values, 'defaulttz') ?? null, rateInterval, rateBurst, rateName: rateName ?? null, receiveBuffer,
      freeBind: ((numberParam(values, 'ipfreebind') ?? 2) as 0 | 1 | 2), allowedSenders,
    };
    instances.push(buildListener(settings, context));
  }
  return instances;
}

function buildListener(settings: ListenerSettings, context: InputContext): ImudpListener {
  return new ImudpListener(settings, context, (displayName) => {
    const created = context.rateLimiter({ module: displayName, interval: settings.rateInterval, burst: settings.rateBurst, configName: settings.rateName, forInput: true });
    return created === null ? null : created.limiter;
  });
}

function validateScheduling(config: ImudpModuleConfig, context: ModuleContext): void {
  const { schedulingPolicy: policy, schedulingPriority: priority } = config;
  if (policy !== null && priority === SCHEDULING_PRIORITY_UNSET) {
    context.runtime.error('imudp: scheduling policy set, but without priority - ignoring settings', RS_RET.ERR_SCHED_PARAMS);
  } else if (policy === null && priority !== SCHEDULING_PRIORITY_UNSET) {
    context.runtime.error('imudp: scheduling priority set, but without policy - ignoring settings', RS_RET.ERR_SCHED_PARAMS);
  } else if (policy !== null) {
    const range = SCHEDULING_PRIORITY_RANGE[policy.toLowerCase()];
    if (range === undefined) {
      context.runtime.error(`imudp: invalid scheduling policy '${policy}' - ignoring setting`, RS_RET.NO_ERRCODE);
    } else if (priority < range.min || priority > range.max) {
      context.runtime.error(
        `imudp: scheduling priority ${priority} out of range (${range.min} - ${range.max}) for scheduling policy '${policy}' - ignoring settings`, RS_RET.NO_ERRCODE,
      );
    }
  }
}

function directives(): DirectiveRegistration[] {
  return [
    { name: 'inputudpserverbindruleset', type: 'word', apply: (value, context) => { legacyState(context).bindRuleset = String(value); } },
    { name: 'udpserveraddress', type: 'word', apply: (value, context) => { legacyState(context).bindAddress = String(value); } },
    {
      name: 'udpserverrun', type: 'word',
      apply: (value, context) => {
        const legacy = legacyState(context);
        const port = String(value) === '' ? '514' : String(value);
        const settings: ListenerSettings = {
          port, portListenFile: null, address: legacy.bindAddress === '' ? null : legacy.bindAddress, device: legacy.bindDevice === '' ? null : legacy.bindDevice,
          ruleset: legacy.bindRuleset === '' ? null : legacy.bindRuleset, inputName: null, appendPortToInputName: false, defaultTimeZone: null,
          rateInterval: 0, rateBurst: DEFAULT_RATE_LIMIT_BURST, rateName: null, receiveBuffer: 0, freeBind: 2, allowedSenders: null,
        };
        context.registerInput('imudp', buildListener(settings, context));
      },
    },
    {
      name: 'imudpschedulingpolicy', type: 'word',
      apply: (value, context) => {
        if (moduleConfig(context).configuredViaModule) context.runtime.error('$imudpschedulingpolicy not permitted after module(...) parameters were given', RS_RET.ERR);
        else legacyState(context).schedulingPolicy = String(value);
      },
    },
    {
      name: 'imudpschedulingpriority', type: 'int',
      apply: (value, context) => {
        if (moduleConfig(context).configuredViaModule) context.runtime.error('$imudpschedulingpriority not permitted after module(...) parameters were given', RS_RET.ERR);
        else legacyState(context).schedulingPriority = Number(value);
      },
    },
    {
      name: 'udpservertimerequery', type: 'int',
      apply: (value, context) => {
        if (moduleConfig(context).configuredViaModule) context.runtime.error('$udpservertimerequery not permitted after module(...) parameters were given', RS_RET.ERR);
        else legacyState(context).timeRequery = Number(value);
      },
    },
  ];
}

export const imudp: InputModule = {
  kind: 'input',
  name: 'imudp',
  builtin: false,
  newInstances: createInstances,
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('imudp: error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const config = moduleConfig(context);
    config.timeRequery = numberParam(values, 'timerequery') ?? config.timeRequery;
    config.batchSize = numberParam(values, 'batchsize') ?? config.batchSize;
    config.schedulingPriority = numberParam(values, 'schedulingpriority') ?? config.schedulingPriority;
    config.schedulingPolicy = stringParam(values, 'schedulingpolicy') ?? config.schedulingPolicy;
    const threads = numberParam(values, 'threads');
    if (threads !== undefined) {
      if (threads > MAX_WORKER_THREADS) {
        context.runtime.error(`imudp: configured for ${threads}worker threads, but maximum permitted is ${MAX_WORKER_THREADS}`, RS_RET.PARAM_ERROR);
        config.workerThreads = MAX_WORKER_THREADS;
      } else {
        config.workerThreads = threads;
      }
    }
    config.preserveCase = (numberParam(values, 'preservecase') ?? (config.preserveCase ? 1 : 0)) !== 0;
    const senders = arrayParam(values, 'allowedsender');
    if (senders !== undefined) {
      const list = (context as InputContext).allowedSenders(senders, 'imudp');
      if (list === null) return false;
      config.allowedSenders = list;
    }
    config.configuredViaModule = true;
    return true;
  },
  check(instanceCount, context) {
    const config = moduleConfig(context);
    if (!config.configuredViaModule) {
      const legacy = legacyState(context);
      config.schedulingPriority = legacy.schedulingPriority;
      config.timeRequery = legacy.timeRequery;
      config.schedulingPolicy = legacy.schedulingPolicy !== null && legacy.schedulingPolicy !== '' ? legacy.schedulingPolicy : null;
    }
    validateScheduling(config, context);
    if (instanceCount === 0) {
      context.runtime.error('imudp: module loaded, but no listeners defined - no input will be gathered', RS_RET.NO_LISTNERS);
    }
  },
  reset(context) {
    Object.assign(legacyState(context), defaultLegacyState());
  },
};

