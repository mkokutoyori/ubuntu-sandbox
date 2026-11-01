import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

export function snapshotControlfilePath(explicit: string | undefined, dbName: string): string {
  return explicit ?? `${ORACLE_CONFIG.HOME}/dbs/snapcf_${dbName}.f`;
}
