import { FilterChain, type FilterChainOutcome, type FilterVerdict } from '../../../core/FilterChain';
import type { PacketContext } from './PacketContext';

export interface PipelineStage {
  readonly name: string;
  apply(context: PacketContext): FilterVerdict<PacketContext>;
}

export class UnknownPipelineStageError extends Error {
  constructor(readonly stageName: string) {
    super(`unknown pipeline stage '${stageName}'`);
    this.name = 'UnknownPipelineStageError';
  }
}

export class DuplicatePipelineStageError extends Error {
  constructor(readonly stageName: string) {
    super(`pipeline stage '${stageName}' is already registered`);
    this.name = 'DuplicatePipelineStageError';
  }
}

export class PipelineStageRegistry {
  private readonly stages = new Map<string, PipelineStage>();

  register(stage: PipelineStage): this {
    if (this.stages.has(stage.name)) throw new DuplicatePipelineStageError(stage.name);
    this.stages.set(stage.name, stage);
    return this;
  }

  replace(stage: PipelineStage): this {
    this.stages.set(stage.name, stage);
    return this;
  }

  get(name: string): PipelineStage | undefined {
    return this.stages.get(name);
  }

  has(name: string): boolean {
    return this.stages.has(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.stages.keys()]);
  }
}

export class FirewallPipeline {
  private constructor(
    private readonly chain: FilterChain<PacketContext>,
    private readonly stages: readonly PipelineStage[],
  ) {}

  static fromStageNames(
    names: readonly string[], registry: PipelineStageRegistry, chainId = 'firewall',
  ): FirewallPipeline {
    const stages = names.map(name => {
      const stage = registry.get(name);
      if (!stage) throw new UnknownPipelineStageError(name);
      return stage;
    });

    const chain = new FilterChain<PacketContext>({ chainId });
    for (const stage of stages) {
      chain.add({ name: stage.name, apply: (context) => stage.apply(context) });
    }
    return new FirewallPipeline(chain, Object.freeze(stages));
  }

  process(context: PacketContext): FilterChainOutcome<PacketContext> {
    return this.chain.process(context);
  }

  stageNames(): readonly string[] {
    return Object.freeze(this.stages.map(stage => stage.name));
  }

  size(): number {
    return this.stages.length;
  }
}
