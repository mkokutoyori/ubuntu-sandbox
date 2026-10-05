import type { SshAlgorithmPreferences } from './transport/SshTransport';

export interface SshClientProfile {
  readonly identification: string;
  readonly algorithms: SshAlgorithmPreferences;
  readonly extInfo: boolean;
}

export interface SshClientProfileHolder {
  sshClientProfile(): SshClientProfile | null;
}

export function sshClientProfileOf(device: object): SshClientProfile | null {
  return (device as Partial<SshClientProfileHolder>).sshClientProfile?.() ?? null;
}
