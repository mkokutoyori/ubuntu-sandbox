import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { TcpAcceptHandler, TcpListenOptions } from '../../tcp/TcpStack';
import type { ListenerIdentity } from '../../tcp/ListenerSocketSink';
import type { WindowsProcess } from './WindowsProcessManager';

export interface ServiceListenerStack {
  listen(localPort: number, opts: TcpListenOptions): unknown;
  closeListener(localPort: number): void;
  listListeners(): ReadonlyArray<{ readonly localPort: number }>;
}

export interface ServiceListenerProcesses {
  getPidForService(serviceName: string): number;
  getProcess(pid: number): WindowsProcess | undefined;
  getProcessesByName(name: string): WindowsProcess[];
}

export type ListenerOwner =
  | { readonly service: string }
  | { readonly image: string };

export interface WindowsListenerDeclaration {
  readonly ports: readonly number[];
  readonly owner: ListenerOwner;
  readonly active: () => boolean;
  readonly accept: (port: number) => TcpAcceptHandler;
}

export class WindowsServicePortProjection {
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly declarations: WindowsListenerDeclaration[] = [];

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
    this.declarations.push(declaration);
  }

  reconcile(): void {
    for (const declaration of this.declarations) {
      if (declaration.active()) this.open(declaration);
      else this.close(declaration);
    }
  }

  private onServiceEvent(deviceId: string): void {
    if (deviceId === this.deviceId) this.reconcile();
  }

  private open(declaration: WindowsListenerDeclaration): void {
    const identity = this.ownerOf(declaration.owner);
    const open = new Set(this.stack.listListeners().map((listener) => listener.localPort));
    for (const port of declaration.ports) {
      if (!open.has(port)) this.stack.listen(port, { onAccept: declaration.accept(port), identity });
    }
  }

  private close(declaration: WindowsListenerDeclaration): void {
    for (const port of declaration.ports) this.stack.closeListener(port);
  }

  private ownerOf(owner: ListenerOwner): ListenerIdentity {
    const process = 'service' in owner
      ? this.processes.getProcess(this.processes.getPidForService(owner.service))
      : this.processes.getProcessesByName(owner.image)[0];
    return process ? { pid: process.pid, processName: process.name } : {};
  }
}
