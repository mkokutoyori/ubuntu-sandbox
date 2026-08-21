export interface PolicyProbe {
  readonly ingressZone: string;
  readonly egressZone: string;
  readonly ingressInterface: string;
  readonly egressInterface: string;
  readonly sourceIP: string;
  readonly destIP: string;
  readonly protocol: number;
  readonly sourcePort?: number;
  readonly destPort?: number;
  readonly icmpType?: number;
  readonly icmpCode?: number;
  readonly application?: string;
  readonly urlCategory?: string;
  readonly destinationTranslated?: boolean;
  readonly destinationNatRuleId?: string;
}
