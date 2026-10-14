import type { RuleAction } from '../../model/SecurityRule';

export interface AsaAclLine {
  readonly acl: string;
  readonly action: RuleAction;
  readonly protocol: string;
  readonly source: string;
  readonly destination: string;
  readonly port?: string;
}

export type AsaManagementService = 'ssh' | 'telnet';

export interface AsaManagementSource {
  readonly service: AsaManagementService;
  readonly network: string;
  readonly mask: string;
  readonly iface: string;
}

export const ASA_SSH_DEFAULT_TIMEOUT_MINUTES = 5;

export const ASA_KEY_EXCHANGE_GROUPS: Readonly<Record<string, string>> = {
  'dh-group1-sha1': 'diffie-hellman-group1-sha1',
  'dh-group14-sha1': 'diffie-hellman-group14-sha1',
  'dh-group14-sha256': 'diffie-hellman-group14-sha256',
  'curve25519-sha256': 'curve25519-sha256',
};

export class AsaRunningState {
  readonly objectNatLines = new Map<string, string>();
  readonly manualNatLines = new Map<string, string>();
  readonly loggingHostInterfaces = new Map<string, string>();
  readonly aclLines: AsaAclLine[] = [];
  manualRuleCounter = 0;
  ruleCounter = 0;
  readonly managementSources: AsaManagementSource[] = [];
  sshTimeoutMinutes = ASA_SSH_DEFAULT_TIMEOUT_MINUTES;
  sshVersion: 1 | 2 | null = null;
  sshScopy = false;
  sshKeyExchangeGroup: string | null = null;
  sshEncryptionCustom: string[] = [];
  sshIntegrityCustom: string[] = [];
  readonly aaaLines: string[] = [];
}
