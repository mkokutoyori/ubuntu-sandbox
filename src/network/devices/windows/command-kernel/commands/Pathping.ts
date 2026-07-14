import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, EXIT_INTERRUPTED, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { IPAddress } from '@/network/core/types';
import type { WindowsPingReply } from '@/command-kernel/machine/types';
import {
  PATHPING_HELP,
  parseWinPathpingArgs,
  formatPathpingHeader,
  formatPathpingDiscoveryHop,
  formatPathpingComputing,
  formatPathpingTableHeader,
  formatPathpingTable,
  formatPathpingTrailer,
  pathpingDurationSeconds,
  PathpingStatsRow,
} from '@/network/devices/windows/WinPathping';

export class PathpingCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pathping',
    summary: 'Combine tracert et ping pour diagnostiquer les pertes saut par saut',
    usage: PATHPING_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options pathping' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    // Options style BSD (`-q`, `-p`, `-h`...) : atterrissent en positionnels bruts.
    lenientOptions: true,
    // Deux phases émises au fil de l'eau (§14.6) : découverte du chemin puis
    // calcul des statistiques par saut. Routée par l'entrée terminal générique
    // comme un job de premier plan annulable (Ctrl+C), sans intercepteur dédié.
    streaming: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await this.emit(ctx, 'PATHPING: not supported on this device');
      return 1;
    }
    if (args.length === 0) {
      await this.emit(ctx, PATHPING_HELP);
      return EXIT_OK;
    }

    const parsed = parseWinPathpingArgs(args);
    if (!parsed.targetStr) {
      await this.emit(ctx, PATHPING_HELP);
      return EXIT_OK;
    }

    const targetIP = await ctx.machine.netConfig.resolveHostname(parsed.targetStr);
    if (!targetIP) {
      await this.emit(ctx, `Unable to resolve target system name ${parsed.targetStr}.`);
      return 1;
    }
    const hostname = parsed.targetStr !== targetIP ? parsed.targetStr : undefined;

    // Phase 1 — découverte du chemin (en-tête + liste des sauts).
    for (const line of formatPathpingHeader(new IPAddress(targetIP), parsed.maxHops, hostname)) {
      await this.emit(ctx, line);
    }

    const probeTimeoutMs = Math.min(parsed.timeoutMs, 200);
    const effectiveMaxHops = Math.min(parsed.maxHops, 8);
    const hops = await ctx.machine.netConfig.traceroute(targetIP, effectiveMaxHops, probeTimeoutMs);
    if (ctx.signal.aborted) return EXIT_INTERRUPTED;

    const sourceIp = ctx.machine.netConfig.egressSourceIp(targetIP);
    const rows: PathpingStatsRow[] = [{
      hop: 0,
      ip: sourceIp ?? '0.0.0.0',
      hostname: parsed.noResolve ? undefined : ctx.machine.hostname,
      rttMs: undefined,
      sourceLost: 0,
      sourceSent: 0,
      nodeLost: 0,
      linkLost: 0,
    }];
    let hopNum = 0;
    for (const hop of hops) {
      if (!hop.ip) continue;
      hopNum++;
      await this.emit(ctx, formatPathpingDiscoveryHop(hopNum, hop.ip));
      rows.push({ hop: hopNum, ip: hop.ip, hostname: undefined, rttMs: undefined, sourceLost: 0, sourceSent: 0, nodeLost: 0, linkLost: 0 });
    }
    if (rows.length <= 1) {
      await this.emit(ctx, `Unable to resolve target system name ${parsed.targetStr}.`);
      return 1;
    }

    // Phase 2 — calcul des statistiques : chaque saut sondé `queriesPerHop`
    // fois, une requête à la fois, `periodMs` entre chacune (respecte Ctrl+C).
    const durationSec = pathpingDurationSeconds(parsed, rows.length - 1);
    for (const line of formatPathpingComputing(durationSec)) await this.emit(ctx, line);

    for (let i = 1; i < rows.length; i++) {
      if (ctx.signal.aborted) return EXIT_INTERRUPTED;
      const row = rows[i];
      const rtts: number[] = [];
      const results: WindowsPingReply[] = [];
      for (let q = 0; q < parsed.queriesPerHop; q++) {
        if (ctx.signal.aborted) break;
        const batch = await ctx.machine.netConfig.pingSequence(row.ip, 1, parsed.timeoutMs);
        const r = batch[0] ?? { success: false, rttMs: 0, ttl: 0, fromIP: '', error: 'Request timed out' };
        results.push(r);
        if (r.success) rtts.push(r.rttMs);
        if (q < parsed.queriesPerHop - 1 && !ctx.signal.aborted) await this.pace(parsed.periodMs, ctx.signal);
      }
      row.sourceSent = results.length;
      row.sourceLost = results.filter((r) => !r.success).length;
      if (rtts.length > 0) row.rttMs = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    }
    if (ctx.signal.aborted) return EXIT_INTERRUPTED;

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const prevLossRate = prev.sourceSent > 0 ? prev.sourceLost / prev.sourceSent : 0;
      const curLossRate = cur.sourceSent > 0 ? cur.sourceLost / cur.sourceSent : 0;
      cur.linkLost = Math.round(Math.max(0, curLossRate - prevLossRate) * cur.sourceSent);
    }

    await this.emit(ctx, '');
    for (const line of formatPathpingTableHeader()) await this.emit(ctx, line);
    for (const line of formatPathpingTable(rows, parsed.queriesPerHop)) await this.emit(ctx, line);
    await this.emit(ctx, '');
    await this.emit(ctx, formatPathpingTrailer());
    return EXIT_OK;
  }
}
