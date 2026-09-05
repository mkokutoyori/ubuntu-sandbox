export type RuleAction =
  | 'allow'
  | 'deny'
  | 'drop'
  | 'reset-client'
  | 'reset-server'
  | 'reset-both'
  | 'tunnel'
  | 'ipsec';

export type TcpSessionWithoutSyn = 'all' | 'data-only' | 'disable';

export interface SecurityRule {
  readonly id: string;
  seq: number;
  name?: string;
  enabled: boolean;

  from: string[];
  to: string[];
  source: string[];
  destination: string[];
  source6: string[];
  destination6: string[];
  sourceNegated: boolean;
  destinationNegated: boolean;

  service: string[];
  serviceNegated: boolean;
  application: string[];
  urlCategory: string[];
  user: string[];

  schedule?: string;

  action: RuleAction;
  natEnabled?: boolean;
  natPool?: string;
  fixedPort?: boolean;
  matchTranslatedDestination?: boolean;

  logStart: boolean;
  logEnd: boolean;

  securityProfileGroup?: string;
  sessionTimeoutOverrideSec?: number;
  capturePackets?: boolean;
  haMgmtInterfaceOnly?: boolean;
  tcpSessionWithoutSyn?: TcpSessionWithoutSyn;

  utmEnabled?: boolean;
  inspectionMode?: string;
  authGroups?: readonly string[];
  authUsers?: readonly string[];
  antivirusProfile?: string;
  webFilterProfile?: string;
  applicationList?: string;
  dnsFilterProfile?: string;
  fileFilterProfile?: string;
  sslSshProfile?: string;
  protocolOptions?: string;

  comment?: string;
  tags: string[];
  readonly implicit: boolean;

  hitCount: number;
  byteCount: number;
  lastHitAt?: number;
  readonly createdAt: number;
  modifiedAt: number;
}

export interface SecurityRuleInit {
  id: string;
  seq: number;
  name?: string;
  enabled?: boolean;
  from?: string[];
  to?: string[];
  source?: string[];
  destination?: string[];
  source6?: string[];
  destination6?: string[];
  sourceNegated?: boolean;
  destinationNegated?: boolean;
  service?: string[];
  serviceNegated?: boolean;
  application?: string[];
  urlCategory?: string[];
  user?: string[];
  schedule?: string;
  action?: RuleAction;
  natEnabled?: boolean;
  natPool?: string;
  fixedPort?: boolean;
  matchTranslatedDestination?: boolean;
  logStart?: boolean;
  logEnd?: boolean;
  securityProfileGroup?: string;
  sessionTimeoutOverrideSec?: number;
  capturePackets?: boolean;
  haMgmtInterfaceOnly?: boolean;
  tcpSessionWithoutSyn?: TcpSessionWithoutSyn;
  utmEnabled?: boolean;
  inspectionMode?: string;
  authGroups?: readonly string[];
  authUsers?: readonly string[];
  antivirusProfile?: string;
  webFilterProfile?: string;
  applicationList?: string;
  dnsFilterProfile?: string;
  fileFilterProfile?: string;
  sslSshProfile?: string;
  protocolOptions?: string;
  comment?: string;
  tags?: string[];
  implicit?: boolean;
  createdAt?: number;
}

export const IMPLICIT_RULE_ID = '__implicit__';

export const DENY_ACTIONS: readonly RuleAction[] = Object.freeze([
  'deny', 'drop', 'reset-client', 'reset-server', 'reset-both',
]);

export function isDenyAction(action: RuleAction): boolean {
  return DENY_ACTIONS.includes(action);
}

export function makeRule(init: SecurityRuleInit): SecurityRule {
  const createdAt = init.createdAt ?? 0;
  return {
    id: init.id,
    seq: init.seq,
    name: init.name,
    enabled: init.enabled ?? true,
    from: [...(init.from ?? ['any'])],
    to: [...(init.to ?? ['any'])],
    source: [...(init.source ?? ['any'])],
    destination: [...(init.destination ?? ['any'])],
    source6: [...(init.source6 ?? [])],
    destination6: [...(init.destination6 ?? [])],
    sourceNegated: init.sourceNegated ?? false,
    destinationNegated: init.destinationNegated ?? false,
    service: [...(init.service ?? ['any'])],
    serviceNegated: init.serviceNegated ?? false,
    application: [...(init.application ?? [])],
    urlCategory: [...(init.urlCategory ?? [])],
    user: [...(init.user ?? [])],
    schedule: init.schedule,
    action: init.action ?? 'deny',
    natEnabled: init.natEnabled,
    natPool: init.natPool,
    fixedPort: init.fixedPort,
    matchTranslatedDestination: init.matchTranslatedDestination,
    logStart: init.logStart ?? false,
    logEnd: init.logEnd ?? false,
    securityProfileGroup: init.securityProfileGroup,
    sessionTimeoutOverrideSec: init.sessionTimeoutOverrideSec,
    capturePackets: init.capturePackets,
    haMgmtInterfaceOnly: init.haMgmtInterfaceOnly,
    tcpSessionWithoutSyn: init.tcpSessionWithoutSyn,
    utmEnabled: init.utmEnabled,
    inspectionMode: init.inspectionMode,
    authGroups: init.authGroups === undefined ? undefined : Object.freeze([...init.authGroups]),
    authUsers: init.authUsers === undefined ? undefined : Object.freeze([...init.authUsers]),
    antivirusProfile: init.antivirusProfile,
    webFilterProfile: init.webFilterProfile,
    applicationList: init.applicationList,
    dnsFilterProfile: init.dnsFilterProfile,
    fileFilterProfile: init.fileFilterProfile,
    sslSshProfile: init.sslSshProfile,
    protocolOptions: init.protocolOptions,
    comment: init.comment,
    tags: [...(init.tags ?? [])],
    implicit: init.implicit ?? false,
    hitCount: 0,
    byteCount: 0,
    createdAt,
    modifiedAt: createdAt,
  };
}
