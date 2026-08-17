export enum CliMode {
  USER_EXEC = 'USER_EXEC',
  PRIVILEGED_EXEC = 'PRIVILEGED_EXEC',
  GLOBAL_CONFIG = 'GLOBAL_CONFIG',
  INTERFACE_CONFIG = 'INTERFACE_CONFIG',
  LINE_CONFIG = 'LINE_CONFIG',
  ROUTER_CONFIG = 'ROUTER_CONFIG',
  VLAN_CONFIG = 'VLAN_CONFIG',
}

export interface CliSession {
  readonly mode: CliMode;
  readonly privilegeLevel: number;
  readonly hostname: string;
  readonly device: unknown;
  readonly viewName?: string;
}
