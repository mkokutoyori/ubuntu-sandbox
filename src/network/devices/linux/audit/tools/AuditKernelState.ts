import { K } from './AuditKernelConstants';
import { MAX_FIELDS, RuleData, carriesString } from './AuditctlLib';

export const EPERM = 1;
export const ENOENT = 2;
export const EAGAIN = 11;
export const EEXIST = 17;
export const EINVAL = 22;
export const ENOSPC = 28;
export const EBADF = 9;

export const NR_LISTS = 8;
export const MAX_RULES_PER_LIST = 256;
const HZ_WAIT_DEFAULT = 15000;
const FILTER_PREPEND = 0x10;
const LOCKED = 2;
export const FEATURE_LOGINUID_IMMUTABLE_MASK = 0x2;
const FEATURE_MASK_ALL = 0x3;

export interface AuditStatus {
  mask: number;
  enabled: number;
  failure: number;
  pid: number;
  rateLimit: number;
  backlogLimit: number;
  lost: number;
  backlog: number;
  featureBitmap: number;
  backlogWaitTime: number;
  backlogWaitTimeActual: number;
}

export interface AuditFeatures {
  vers: number;
  mask: number;
  features: number;
  lock: number;
}

export type KernelRequest =
  | { kind: 'none' }
  | { kind: 'status'; status: AuditStatus }
  | { kind: 'features'; features: AuditFeatures }
  | { kind: 'rule'; rule: RuleData }
  | { kind: 'text'; text: string };

export type KernelPayload =
  | { kind: 'ack'; error: number }
  | { kind: 'status'; status: AuditStatus }
  | { kind: 'features'; features: AuditFeatures }
  | { kind: 'rule'; rule: RuleData }
  | { kind: 'done' }
  | { kind: 'signal'; pid: number; uid: number };

export interface KernelMessage {
  type: number;
  seq: number;
  payload: KernelPayload;
}

export interface KernelObserver {
  ruleChanged?(op: 'add_rule' | 'remove_rule', rule: RuleData, ok: boolean): void;
  configChanged?(name: string, oldValue: number, newValue: number, ok: boolean): void;
  userMessage?(type: number, text: string): void;
  lostReset?(lost: number): void;
}

export interface KernelEnvironment {
  pathExists(path: string): boolean;
}

export function newStatus(): AuditStatus {
  return {
    mask: 0, enabled: 0, failure: 1, pid: 0, rateLimit: 0, backlogLimit: 64, lost: 0, backlog: 0,
    featureBitmap: K.AUDIT_FEATURE_BITMAP_ALL, backlogWaitTime: HZ_WAIT_DEFAULT, backlogWaitTimeActual: 0,
  };
}

function dirnameOf(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const at = trimmed.lastIndexOf('/');
  if (at < 0) return '.';
  if (at === 0) return '/';
  return trimmed.slice(0, at);
}

export class AuditKernelState {
  status: AuditStatus = newStatus();
  features: AuditFeatures = { vers: K.AUDIT_FEATURE_VERSION, mask: FEATURE_MASK_ALL, features: 0, lock: 0 };
  readonly lists: RuleData[][] = Array.from({ length: NR_LISTS }, () => []);
  observer: KernelObserver = {};

  constructor(private readonly environment: KernelEnvironment) {}

  allRules(): RuleData[] {
    return this.lists.flat();
  }

  clearRules(): void {
    for (const list of this.lists) list.length = 0;
  }

  private configChange(name: string, field: 'enabled' | 'failure' | 'rateLimit' | 'backlogLimit' | 'backlogWaitTime', value: number): number {
    const old = this.status[field];
    const locked = this.status.enabled === LOCKED;
    if (!locked) this.status[field] = value;
    this.observer.configChanged?.(name, old, value, !locked);
    return locked ? -EPERM : 0;
  }

  private handleSet(s: AuditStatus): number {
    let err: number;
    if (s.mask & K.AUDIT_STATUS_ENABLED) {
      if (s.enabled > LOCKED) return -EINVAL;
      err = this.configChange('audit_enabled', 'enabled', s.enabled);
      if (err < 0) return err;
    }
    if (s.mask & K.AUDIT_STATUS_FAILURE) {
      if (s.failure !== 0 && s.failure !== 1 && s.failure !== 2) return -EINVAL;
      err = this.configChange('audit_failure', 'failure', s.failure);
      if (err < 0) return err;
    }
    if (s.mask & K.AUDIT_STATUS_PID) this.status.pid = s.pid;
    if (s.mask & K.AUDIT_STATUS_RATE_LIMIT) {
      err = this.configChange('audit_rate_limit', 'rateLimit', s.rateLimit);
      if (err < 0) return err;
    }
    if (s.mask & K.AUDIT_STATUS_BACKLOG_LIMIT) {
      err = this.configChange('audit_backlog_limit', 'backlogLimit', s.backlogLimit);
      if (err < 0) return err;
    }
    if (s.mask & K.AUDIT_STATUS_BACKLOG_WAIT_TIME) {
      if (s.backlogWaitTime > 10 * HZ_WAIT_DEFAULT) return -EINVAL;
      err = this.configChange('audit_backlog_wait_time', 'backlogWaitTime', s.backlogWaitTime);
      if (err < 0) return err;
    }
    if (s.mask & K.AUDIT_STATUS_LOST) {
      this.observer.lostReset?.(this.status.lost);
      this.status.lost = 0;
    }
    if (s.mask & K.AUDIT_STATUS_BACKLOG_WAIT_TIME_ACTUAL) this.status.backlogWaitTimeActual = 0;
    return 0;
  }

  private validate(rule: RuleData): number {
    const list = (rule.flags & ~FILTER_PREPEND) >>> 0;
    if (list >= NR_LISTS || list === K.AUDIT_FILTER_ENTRY) return -EINVAL;
    if (rule.action !== K.AUDIT_NEVER && rule.action !== K.AUDIT_POSSIBLE && rule.action !== K.AUDIT_ALWAYS) return -EINVAL;
    if (rule.fieldCount > MAX_FIELDS) return -EINVAL;
    let offset = 0;
    for (let i = 0; i < rule.fieldCount; i++) {
      const field = rule.fields[i];
      if (field === K.AUDIT_WATCH || field === K.AUDIT_DIR) {
        const length = rule.values[i];
        if (list !== K.AUDIT_FILTER_EXIT || (rule.fieldflags[i] & K.AUDIT_OPERATORS) >>> 0 !== K.AUDIT_EQUAL) return -EINVAL;
        if (offset + length > rule.buflen || length === 0 || length > 4096) return -EINVAL;
        const path = rule.bufferText(offset, length);
        if (path[0] !== '/') return -EINVAL;
        if (!this.environment.pathExists(dirnameOf(path))) return -ENOENT;
      }
      if (carriesString(field)) offset += rule.values[i];
      if (field === K.AUDIT_PERM && list !== K.AUDIT_FILTER_EXIT && list !== K.AUDIT_FILTER_EXCLUDE) return -EINVAL;
    }
    return 0;
  }

  private changeRule(type: number, incoming: RuleData): number {
    if (this.status.enabled === LOCKED) {
      this.observer.ruleChanged?.(type === K.AUDIT_ADD_RULE ? 'add_rule' : 'remove_rule', incoming, false);
      return -EPERM;
    }
    const err = this.validate(incoming);
    if (err < 0) return err;
    const rule = incoming.clone();
    const prepend = (rule.flags & FILTER_PREPEND) !== 0;
    rule.flags &= ~FILTER_PREPEND;
    const list = this.lists[rule.flags >>> 0];
    const index = list.findIndex((existing) => existing.sameAs(rule));
    if (type === K.AUDIT_ADD_RULE) {
      if (index >= 0) return -EEXIST;
      if (list.length >= MAX_RULES_PER_LIST) return -ENOSPC;
      if (prepend) list.unshift(rule);
      else list.push(rule);
      this.observer.ruleChanged?.('add_rule', rule, true);
      return 0;
    }
    if (index < 0) return -ENOENT;
    list.splice(index, 1);
    this.observer.ruleChanged?.('remove_rule', rule, true);
    return 0;
  }

  request(type: number, seq: number, payload: KernelRequest): KernelMessage[] {
    const ack = (error: number): KernelMessage => ({ type: K.NLMSG_ERROR, seq, payload: { kind: 'ack', error } });
    switch (type) {
      case K.AUDIT_GET: {
        const status = { ...this.status };
        status.mask = K.AUDIT_STATUS_ENABLED | K.AUDIT_STATUS_FAILURE | K.AUDIT_STATUS_PID | K.AUDIT_STATUS_RATE_LIMIT
          | K.AUDIT_STATUS_BACKLOG_LIMIT | K.AUDIT_STATUS_BACKLOG_WAIT_TIME;
        return [ack(0), { type: K.AUDIT_GET, seq, payload: { kind: 'status', status } }];
      }
      case K.AUDIT_SET:
        return [ack(payload.kind === 'status' ? this.handleSet(payload.status) : -EINVAL)];
      case K.AUDIT_GET_FEATURE:
        return [ack(0), { type: K.AUDIT_GET_FEATURE, seq, payload: { kind: 'features', features: { ...this.features } } }];
      case K.AUDIT_SET_FEATURE: {
        if (payload.kind !== 'features') return [ack(-EINVAL)];
        const f = payload.features;
        if ((f.mask & ~FEATURE_MASK_ALL) !== 0) return [ack(-EINVAL)];
        if ((f.mask & this.features.lock) !== 0) return [ack(-EPERM)];
        this.features.features = (this.features.features & ~f.mask) | (f.features & f.mask);
        this.features.lock |= f.lock & f.mask;
        return [ack(0)];
      }
      case K.AUDIT_LIST_RULES: {
        const out: KernelMessage[] = [ack(0)];
        for (const list of this.lists) for (const rule of list) out.push({ type: K.AUDIT_LIST_RULES, seq, payload: { kind: 'rule', rule: rule.clone() } });
        out.push({ type: K.NLMSG_DONE, seq, payload: { kind: 'done' } });
        return out;
      }
      case K.AUDIT_ADD_RULE:
      case K.AUDIT_DEL_RULE:
        if (payload.kind !== 'rule') return [ack(-EINVAL)];
        return [ack(this.changeRule(type, payload.rule))];
      case K.AUDIT_SIGNAL_INFO:
        return [ack(0), { type: K.AUDIT_SIGNAL_INFO, seq, payload: { kind: 'signal', pid: this.status.pid, uid: 0 } }];
      case K.AUDIT_USER:
        if (payload.kind === 'text') this.observer.userMessage?.(type, payload.text);
        return [ack(0)];
      case K.AUDIT_TRIM:
      case K.AUDIT_MAKE_EQUIV:
        return [ack(0)];
      default:
        return [ack(-EINVAL)];
    }
  }
}
