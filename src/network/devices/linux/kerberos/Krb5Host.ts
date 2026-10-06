import type { KerberosClient } from '@/network/kerberos/KerberosClient';

export interface SrvRecord {
  readonly target: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

export interface Krb5Host {
  environment(name: string): string | null;
  readText(path: string): string | null;
  readBytes(path: string): Uint8Array | null;
  writeBytes(path: string, bytes: Uint8Array): boolean;
  removeFile(path: string): boolean;
  fileExists(path: string): boolean;
  listDirectory(path: string): readonly string[] | null;
  uid(): number;
  userName(): string;
  nowSeconds(): number;
  resolve(name: string): Promise<string | null>;
  querySrv(name: string): Promise<readonly SrvRecord[]>;
  dialKdc(address: string, port: number): KerberosClient | null;
}
