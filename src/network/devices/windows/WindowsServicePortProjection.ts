import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { IPV4_ONLY, ipFamilyOf, wildcardAddressOf } from '../../tcp/TcpStack';
import type { IpFamily, TcpAcceptHandler, TcpListenOptions } from '../../tcp/TcpStack';
import type { ListenerIdentity } from '../../tcp/ListenerSocketSink';

export interface ServiceListenerStack {
  listen(localPort: number, opts: TcpListenOptions, localIp?: string): unknown;
  closeListener(localPort: number, localIp?: string): void;
  listListeners(): ReadonlyArray<{ readonly localPort: number; readonly localIp: string }>;
}

export interface ServiceListenerProcesses {
  identityOfService(serviceName: string): ListenerIdentity;
  identityOfImage(image: string): ListenerIdentity;
}

export type ListenerOwner =
  | { readonly service: string }
  | { readonly image: string };

export interface WindowsEndpoint {
  open(identity: ListenerIdentity): void;
  close(): void;
}

export interface WindowsEndpointDeclaration {
  readonly owner: ListenerOwner | (() => ListenerOwner);
  readonly active: () => boolean;
  readonly endpoint: WindowsEndpoint;
}

export interface WindowsListenerDeclaration {
  readonly ports: readonly number[];
  readonly owner: ListenerOwner;
  readonly active: () => boolean;
  readonly accept: (port: number) => TcpAcceptHandler;
  readonly families?: readonly IpFamily[];
}

export class WindowsServicePortProjection {
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly declarations: WindowsEndpointDeclaration[] = [];
  private reconciling = false;
  private requested = false;

  constructor(
    bus: IEventBus,
    private readonly deviceId: string,
    private readonly stack: ServiceListenerStack,
    private readonly processes: ServiceListenerProcesses,
  ) {
    this.subscriptions.push(
      bus.subscribe('windows.service.started', (e) => this.onServiceEvent(e.payload.deviceId)),
      bus.subscribe('windows.service.stopped', (e) => this.onServiceEvent(e.payload.deviceId)),
      bus.subscribe('windows.service.crashed', (e) => this.onServiceEvent(e.payload.deviceId)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  declare(declaration: WindowsListenerDeclaration): void {
    this.declareEndpoint({
      owner: declaration.owner,
      active: declaration.active,
      endpoint: this.tcpEndpoint(declaration.ports, declaration.accept, declaration.families ?? IPV4_ONLY),
    });
  }

  declareEndpoint(declaration: WindowsEndpointDeclaration): void {
    this.declarations.push(declaration);
  }

  reconcile(): void {
    this.requested = true;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      let failure: unknown = null;
      while (this.requested) {
        this.requested = false;
        for (const declaration of this.declarations) {
          try {
            if (declaration.active()) declaration.endpoint.open(this.ownerOf(declaration.owner));
            else declaration.endpoint.close();
          } catch (error) {
            failure ??= error;
          }
        }
      }
      if (failure !== null) throw failure;
    } finally {
      this.reconciling = false;
    }
  }

  private onServiceEvent(deviceId: string): void {
    if (deviceId === this.deviceId) this.reconcile();
  }

  private tcpEndpoint(
    ports: readonly number[], accept: (port: number) => TcpAcceptHandler, families: readonly IpFamily[],
  ): WindowsEndpoint {
    return {
      open: (identity) => {
        for (const family of families) {
          const open = new Set(this.stack.listListeners()
            .filter((listener) => ipFamilyOf(listener.localIp) === family)
            .map((listener) => listener.localPort));
          for (const port of ports) {
            if (!open.has(port)) this.stack.listen(port, { onAccept: accept(port), identity }, wildcardAddressOf(family));
          }
        }
      },
      close: () => {
        for (const family of families) {
          for (const port of ports) this.stack.closeListener(port, wildcardAddressOf(family));
        }
      },
    };
  }

  private ownerOf(declared: ListenerOwner | (() => ListenerOwner)): ListenerIdentity {
    const owner = typeof declared === 'function' ? declared() : declared;
    return 'service' in owner
      ? this.processes.identityOfService(owner.service)
      : this.processes.identityOfImage(owner.image);
  }
}
