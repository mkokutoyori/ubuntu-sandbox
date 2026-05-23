import type { IEventBus } from '@/events/EventBus';
import { NetworkOsAccount, publishAccountEvent } from './NetworkOsAccount';

export interface NetworkOsCredentialStoreOptions {
  deviceId: string;
  bus: IEventBus;
}

export class NetworkOsCredentialStore {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly accounts: Map<string, NetworkOsAccount> = new Map();

  constructor(opts: NetworkOsCredentialStoreOptions) {
    this.deviceId = opts.deviceId;
    this.bus = opts.bus;
  }

  size(): number { return this.accounts.size; }
  has(name: string): boolean { return this.accounts.has(name); }
  get(name: string): NetworkOsAccount | undefined { return this.accounts.get(name); }

  list(): readonly NetworkOsAccount[] {
    return Array.from(this.accounts.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  upsert(account: NetworkOsAccount): NetworkOsAccount {
    const existed = this.accounts.has(account.name);
    this.accounts.set(account.name, account);
    publishAccountEvent(
      this.bus,
      existed ? 'router.aaa.account.updated' : 'router.aaa.account.created',
      this.deviceId,
      account,
    );
    return account;
  }

  remove(name: string): NetworkOsAccount | undefined {
    const previous = this.accounts.get(name);
    if (!previous) return undefined;
    this.accounts.delete(name);
    publishAccountEvent(this.bus, 'router.aaa.account.deleted', this.deviceId, previous);
    return previous;
  }

  mutate(name: string, mutator: (a: NetworkOsAccount) => NetworkOsAccount): NetworkOsAccount | undefined {
    const current = this.accounts.get(name);
    if (!current) return undefined;
    const next = mutator(current);
    return this.upsert(next);
  }

  recordLoginSuccess(name: string, from: string, method: 'password' | 'publickey' | 'keyboard-interactive', at: number = Date.now()): void {
    const updated = this.mutate(name, a => a.withSuccessfulLogin(at, from, method));
    if (updated) {
      publishAccountEvent(this.bus, 'router.aaa.account.login.success', this.deviceId, updated, { from, method, at });
    }
  }

  recordLoginFailure(name: string, from: string, reason: string, at: number = Date.now()): void {
    const updated = this.mutate(name, a => a.withFailedLogin(at, from));
    if (updated) {
      publishAccountEvent(this.bus, 'router.aaa.account.login.failure', this.deviceId, updated, { from, reason, at });
    } else {
      publishAccountEvent(this.bus, 'router.aaa.account.login.failure', this.deviceId, NetworkOsAccount.create({ name, now: at }), { from, reason, at });
    }
  }

  lock(name: string, reason: string, at: number = Date.now()): NetworkOsAccount | undefined {
    const updated = this.mutate(name, a => a.lock(reason, at));
    if (updated) {
      publishAccountEvent(this.bus, 'router.aaa.account.locked', this.deviceId, updated, { reason, at });
    }
    return updated;
  }

  unlock(name: string, at: number = Date.now()): NetworkOsAccount | undefined {
    const updated = this.mutate(name, a => a.unlock(at));
    if (updated) {
      publishAccountEvent(this.bus, 'router.aaa.account.unlocked', this.deviceId, updated, { at });
    }
    return updated;
  }
}
