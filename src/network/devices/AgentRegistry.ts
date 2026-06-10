/**
 * AgentRegistry — owns the lifecycle of a device's protocol agents.
 *
 * Vendor devices (CiscoRouter, HuaweiRouter, CiscoSwitch, HuaweiSwitch)
 * each run 4-18 protocol agents (CDP, LLDP, STP, HSRP, …) that share the
 * same contract: `start()` installs event-bus subscribers and timers,
 * `stop()` removes them. Before this registry every device repeated the
 * same boilerplate — a `.start()` call per agent in the constructor and a
 * `if (agent) { agent.stop(); agent.start(); }` litany in `setEventBus()`
 * (the restart re-binds subscriptions to the newly injected bus). Adding an
 * agent meant touching three places per device.
 *
 * `register()` records without starting so construction order stays
 * decoupled from start order, exactly like the previous hand-written code
 * (all agents constructed first, then started together).
 */
export interface ManagedAgent {
  start(): void;
  stop(): void;
}

export class AgentRegistry {
  private readonly agents: ManagedAgent[] = [];

  /** Record an agent and hand it back, so fields can be assigned inline. */
  register<T extends ManagedAgent>(agent: T): T {
    this.agents.push(agent);
    return agent;
  }

  /** Record several agents at once, in order. */
  registerAll(...agents: ManagedAgent[]): void {
    for (const agent of agents) this.register(agent);
  }

  /** Start every agent in registration order. */
  startAll(): void {
    for (const agent of this.agents) agent.start();
  }

  /** Stop every agent in registration order. */
  stopAll(): void {
    for (const agent of this.agents) agent.stop();
  }

  /**
   * Stop/start each agent in registration order — used after event-bus
   * injection so subscribers re-attach to the new bus.
   */
  restartAll(): void {
    for (const agent of this.agents) {
      agent.stop();
      agent.start();
    }
  }

  /** Number of managed agents (test convenience). */
  size(): number {
    return this.agents.length;
  }
}
