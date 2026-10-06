import type { PamConversationFlow, PamHandle, PamHost } from './PamHandle';

export type PamModuleOutcome = number | PamConversationFlow<number>;

export type PamModuleFunction<H extends PamHost = PamHost> = (
  pamh: PamHandle<H>,
  flags: number,
  args: readonly string[],
) => PamModuleOutcome;

export interface PamModuleImplementation<H extends PamHost = PamHost> {
  readonly authenticate?: PamModuleFunction<H>;
  readonly setcred?: PamModuleFunction<H>;
  readonly acctMgmt?: PamModuleFunction<H>;
  readonly openSession?: PamModuleFunction<H>;
  readonly closeSession?: PamModuleFunction<H>;
  readonly chauthtok?: PamModuleFunction<H>;
}

export class PamModuleRegistry<H extends PamHost = PamHost> {
  private readonly modules = new Map<string, PamModuleImplementation<H>>();

  register(name: string, implementation: PamModuleImplementation<H>): this {
    if (this.modules.has(name)) throw new Error(`PAM module ${name} is already registered`);
    this.modules.set(name, implementation);
    return this;
  }

  get(name: string): PamModuleImplementation<H> | undefined {
    return this.modules.get(name);
  }

  has(name: string): boolean {
    return this.modules.has(name);
  }

  names(): string[] {
    return [...this.modules.keys()].sort();
  }
}
