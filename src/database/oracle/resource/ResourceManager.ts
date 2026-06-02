/**
 * Oracle Resource Manager — concrete domain model.
 *
 * Mirrors the data dictionary tables fed by `DBMS_RESOURCE_MANAGER`:
 *   - resource plans (DBA_RSRC_PLANS)
 *   - consumer groups (DBA_RSRC_CONSUMER_GROUPS)
 *   - plan directives (DBA_RSRC_PLAN_DIRECTIVES)
 *   - mapping rules (DBA_RSRC_GROUP_MAPPINGS)
 *
 * Seeded with Oracle's three system-supplied plans (DEFAULT_PLAN,
 * DEFAULT_MAINTENANCE_PLAN, INTERNAL_PLAN) and the system-supplied
 * consumer groups, so a fresh database carries plausible defaults.
 */

export type CpuMethod = 'EMPHASIS' | 'RATIO';

export class ConsumerGroup {
  constructor(
    readonly name: string,
    readonly cpuMethod: CpuMethod,
    readonly comment: string,
    readonly category: 'INTERACTIVE' | 'BATCH' | 'ADMINISTRATIVE' = 'INTERACTIVE',
    readonly status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
    readonly mandatory: boolean = false,
  ) {}
}

export class ResourcePlan {
  constructor(
    readonly name: string,
    readonly cpuMethod: CpuMethod,
    readonly status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
    readonly comment: string = '',
    readonly mandatory: boolean = false,
    readonly subPlan: boolean = false,
  ) {}
}

export class PlanDirective {
  constructor(
    readonly plan: string,
    readonly groupOrSubplan: string,
    readonly type: 'CONSUMER_GROUP' | 'PLAN',
    /** Percentage CPU allocation at level 1. */
    readonly mgmtP1: number,
    /** Active session limit. */
    readonly activeSessPool: number | null,
    /** Queue timeout in seconds. */
    readonly queueingP1: number | null,
    /** Maximum CPU run time before switch (seconds). */
    readonly switchTime: number | null,
    /** Group to switch to after switchTime. */
    readonly switchGroup: string | null,
    /** Maximum idle time before kill (seconds). */
    readonly maxIdleTime: number | null,
    /** Maximum estimated execution time (seconds). */
    readonly maxEstExecTime: number | null,
    readonly comment: string = '',
  ) {}
}

export type MappingAttribute =
  | 'ORACLE_USER' | 'SERVICE_NAME' | 'CLIENT_OS_USER'
  | 'CLIENT_PROGRAM' | 'CLIENT_MACHINE' | 'MODULE_NAME'
  | 'MODULE_NAME_ACTION' | 'SERVICE_MODULE'
  | 'SERVICE_MODULE_ACTION' | 'CLIENT_ID';

export class GroupMapping {
  constructor(
    readonly attribute: MappingAttribute,
    readonly value: string,
    readonly consumerGroup: string,
    readonly status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
  ) {}
}

export class ResourceManager {
  private readonly plans = new Map<string, ResourcePlan>();
  private readonly groups = new Map<string, ConsumerGroup>();
  private readonly directives: PlanDirective[] = [];
  private readonly mappings: GroupMapping[] = [];
  /** Currently-active plan (set via ALTER SYSTEM SET RESOURCE_MANAGER_PLAN). */
  private _activePlan: string = 'DEFAULT_PLAN';

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) this.seedDefaults();
  }

  private seedDefaults(): void {
    // System-supplied consumer groups.
    for (const g of [
      new ConsumerGroup('SYS_GROUP',                  'EMPHASIS', 'Mandatory SYS/SYSTEM group', 'ADMINISTRATIVE', 'ACTIVE', true),
      new ConsumerGroup('OTHER_GROUPS',               'EMPHASIS', 'Catch-all default group',    'INTERACTIVE',    'ACTIVE', true),
      new ConsumerGroup('DEFAULT_CONSUMER_GROUP',     'EMPHASIS', 'Default user group',         'INTERACTIVE'),
      new ConsumerGroup('LOW_GROUP',                  'EMPHASIS', 'Long-running batch'),
      new ConsumerGroup('AUTO_TASK_CONSUMER_GROUP',   'EMPHASIS', 'Autotask jobs',              'BATCH'),
      new ConsumerGroup('BATCH_GROUP',                'EMPHASIS', 'Batch workload',             'BATCH'),
      new ConsumerGroup('INTERACTIVE_GROUP',          'EMPHASIS', 'Interactive workload'),
      new ConsumerGroup('ETL_GROUP',                  'EMPHASIS', 'ETL pipelines',              'BATCH'),
    ]) this.groups.set(g.name, g);

    // System-supplied plans.
    for (const p of [
      new ResourcePlan('DEFAULT_PLAN',             'EMPHASIS', 'ACTIVE', 'Default OLTP plan',           true),
      new ResourcePlan('DEFAULT_MAINTENANCE_PLAN', 'EMPHASIS', 'ACTIVE', 'Maintenance-window plan',     true),
      new ResourcePlan('INTERNAL_PLAN',            'EMPHASIS', 'ACTIVE', 'Internal Oracle plan',        true),
      new ResourcePlan('INTERNAL_QUIESCE',         'EMPHASIS', 'ACTIVE', 'Quiesce / shutdown plan',     true),
      new ResourcePlan('MIXED_WORKLOAD_PLAN',      'EMPHASIS', 'ACTIVE', 'Mixed OLTP + batch'),
      new ResourcePlan('ETL_CRITICAL_PLAN',        'EMPHASIS', 'ACTIVE', 'ETL window'),
    ]) this.plans.set(p.name, p);

    // Directives for DEFAULT_PLAN — SYS first, then OLTP, then batch.
    this.directives.push(
      new PlanDirective('DEFAULT_PLAN', 'SYS_GROUP',              'CONSUMER_GROUP', 75, null,   null, null,  null,            null, null, 'Top priority'),
      new PlanDirective('DEFAULT_PLAN', 'DEFAULT_CONSUMER_GROUP', 'CONSUMER_GROUP', 20, 50,    null, null,  null,            null, null, 'Default users'),
      new PlanDirective('DEFAULT_PLAN', 'LOW_GROUP',              'CONSUMER_GROUP',  5, 20,    null, 300,  'OTHER_GROUPS',   1800, null, 'Long-running, switch after 5 min'),
      new PlanDirective('DEFAULT_PLAN', 'OTHER_GROUPS',           'CONSUMER_GROUP',  0, null,  null, null,  null,            null, null, 'Catch-all'),
      new PlanDirective('DEFAULT_MAINTENANCE_PLAN', 'SYS_GROUP',              'CONSUMER_GROUP', 60, null,  null, null,  null,            null, null, 'Maintenance window'),
      new PlanDirective('DEFAULT_MAINTENANCE_PLAN', 'AUTO_TASK_CONSUMER_GROUP', 'CONSUMER_GROUP', 30, null, null, null, null,            null, null, 'Autotask jobs'),
      new PlanDirective('DEFAULT_MAINTENANCE_PLAN', 'OTHER_GROUPS',           'CONSUMER_GROUP', 10, null,  null, null,  null,            null, null, 'Catch-all'),
    );

    // Mapping rules — SYS/SYSTEM → SYS_GROUP always.
    this.mappings.push(
      new GroupMapping('ORACLE_USER', 'SYS',    'SYS_GROUP'),
      new GroupMapping('ORACLE_USER', 'SYSTEM', 'SYS_GROUP'),
    );
  }

  // ── DBMS_RESOURCE_MANAGER surface ─────────────────────────────────

  createConsumerGroup(g: ConsumerGroup): void { this.groups.set(g.name.toUpperCase(), g); }
  dropConsumerGroup(name: string): boolean { return this.groups.delete(name.toUpperCase()); }

  createPlan(p: ResourcePlan): void { this.plans.set(p.name.toUpperCase(), p); }
  dropPlan(name: string): boolean { return this.plans.delete(name.toUpperCase()); }

  createPlanDirective(d: PlanDirective): void { this.directives.push(d); }
  dropPlanDirective(plan: string, group: string): boolean {
    const idx = this.directives.findIndex(d =>
      d.plan.toUpperCase() === plan.toUpperCase()
      && d.groupOrSubplan.toUpperCase() === group.toUpperCase());
    if (idx < 0) return false;
    this.directives.splice(idx, 1);
    return true;
  }

  addMapping(m: GroupMapping): void { this.mappings.push(m); }
  removeMapping(attribute: MappingAttribute, value: string): boolean {
    const idx = this.mappings.findIndex(m =>
      m.attribute === attribute && m.value.toUpperCase() === value.toUpperCase());
    if (idx < 0) return false;
    this.mappings.splice(idx, 1);
    return true;
  }

  /** ALTER SYSTEM SET RESOURCE_MANAGER_PLAN. */
  setActivePlan(name: string): void {
    const upper = name.toUpperCase();
    if (!this.plans.has(upper)) throw new Error(`ORA-29355: resource plan ${upper} not found`);
    this._activePlan = upper;
  }

  get activePlan(): string { return this._activePlan; }

  // ── Mapping resolution ────────────────────────────────────────────

  /**
   * Resolve the consumer group for an incoming session. Real Oracle
   * consults mappings in a documented precedence order — we follow
   * the same order (most-specific first). Returns the group name or
   * `OTHER_GROUPS` when no mapping matches.
   */
  resolveConsumerGroup(session: {
    username: string; service: string; osUser: string;
    program: string; machine: string;
    module: string | null; action: string | null;
    clientIdentifier: string | null;
  }): string {
    const precedence: MappingAttribute[] = [
      'SERVICE_MODULE_ACTION', 'SERVICE_MODULE', 'MODULE_NAME_ACTION',
      'MODULE_NAME', 'CLIENT_ID', 'SERVICE_NAME',
      'ORACLE_USER', 'CLIENT_OS_USER', 'CLIENT_MACHINE', 'CLIENT_PROGRAM',
    ];
    for (const attr of precedence) {
      const candidates = this.mappings.filter(m => m.attribute === attr && m.status === 'ACTIVE');
      for (const c of candidates) {
        if (this.matches(c, session)) return c.consumerGroup;
      }
    }
    return 'OTHER_GROUPS';
  }

  private matches(m: GroupMapping, s: {
    username: string; service: string; osUser: string;
    program: string; machine: string;
    module: string | null; action: string | null;
    clientIdentifier: string | null;
  }): boolean {
    const want = m.value.toUpperCase();
    switch (m.attribute) {
      case 'ORACLE_USER':    return s.username.toUpperCase() === want;
      case 'SERVICE_NAME':   return s.service.toUpperCase() === want;
      case 'CLIENT_OS_USER': return s.osUser.toUpperCase() === want;
      case 'CLIENT_PROGRAM': return s.program.toUpperCase() === want;
      case 'CLIENT_MACHINE': return s.machine.toUpperCase() === want;
      case 'CLIENT_ID':      return (s.clientIdentifier ?? '').toUpperCase() === want;
      case 'MODULE_NAME':    return (s.module ?? '').toUpperCase() === want;
      case 'MODULE_NAME_ACTION':
        return `${s.module}.${s.action}`.toUpperCase() === want;
      case 'SERVICE_MODULE':
        return `${s.service}.${s.module}`.toUpperCase() === want;
      case 'SERVICE_MODULE_ACTION':
        return `${s.service}.${s.module}.${s.action}`.toUpperCase() === want;
    }
    return false;
  }

  /** Per-directive switch-after-N-seconds — used by the active manager. */
  resolveSwitchTarget(group: string, executionSeconds: number): string | null {
    const upper = group.toUpperCase();
    const plan = this.activePlan;
    const d = this.directives.find(x =>
      x.plan.toUpperCase() === plan && x.groupOrSubplan.toUpperCase() === upper);
    if (!d || d.switchTime === null || d.switchGroup === null) return null;
    return executionSeconds >= d.switchTime ? d.switchGroup : null;
  }

  // ── Snapshots ─────────────────────────────────────────────────────

  getPlans(): readonly ResourcePlan[] { return [...this.plans.values()]; }
  getConsumerGroups(): readonly ConsumerGroup[] { return [...this.groups.values()]; }
  getDirectives(): readonly PlanDirective[] { return this.directives; }
  getMappings(): readonly GroupMapping[] { return this.mappings; }
}
