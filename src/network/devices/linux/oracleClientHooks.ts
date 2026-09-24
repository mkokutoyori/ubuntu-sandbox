import type { HostCapableDevice } from '@/network';
import { handleTnsping } from '@/terminal/commands/OracleCommands';
import { parseSqlPlusInvocation, runSqlPlusScript } from '@/terminal/commands/database';

interface OracleClientExecutor {
  _oracleTnsping: ((args: string[]) => string) | null;
  _oracleBootstrap: ((args: string[], stdin?: string) => string | null) | null;
}

export function installOracleClientHooks(
  device: HostCapableDevice, deviceId: string, executor: OracleClientExecutor,
): void {
  executor._oracleTnsping = (args) => {
    const lines: string[] = [];
    handleTnsping(device, args, (text) => lines.push(text));
    return lines.join('\n');
  };
  executor._oracleBootstrap = (args, stdin) => {
    const { connArgs, sqlSource } = parseSqlPlusInvocation(args, stdin);
    if (!connArgs || !connArgs[0].includes('@') || !sqlSource) return null;
    return runSqlPlusScript(deviceId, connArgs, sqlSource);
  };
}
