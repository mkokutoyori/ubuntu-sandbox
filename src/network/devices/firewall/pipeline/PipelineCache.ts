import { FirewallPipeline, type PipelineStageRegistry } from './FirewallPipeline';
import type { DeploymentMode, FirewallProfile } from '../FirewallProfile';

export class PipelineCache {
  private readonly built = new Map<string, FirewallPipeline>();

  constructor(
    private readonly deviceId: string,
    private readonly profile: FirewallProfile,
    private readonly registry: PipelineStageRegistry,
  ) {}

  forMode(mode: DeploymentMode): FirewallPipeline {
    const cached = this.built.get(mode);
    if (cached) return cached;

    const made = FirewallPipeline.fromStageNames(
      this.profile.pipeline[mode], this.registry, `firewall.${this.deviceId}.${mode}`);
    this.built.set(mode, made);
    return made;
  }
}
