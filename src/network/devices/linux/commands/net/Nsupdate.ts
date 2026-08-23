import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress } from '@/network/core/types';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { TsigKey } from '@/network/dns/tsig/Tsig';
import {
  parseNsupdateLine, parseNsupdateKeyOption, emptyNsupdateScript,
  nsupdateRequest, nsupdateRcodeName,
} from '@/network/dns/update/NsupdateScript';

export const nsupdateCommand: LinuxCommand = {
  name: 'nsupdate',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/nsupdate',
  readsStdin: true,
  usage: 'nsupdate [-y [hmac:]keyname:secret] [-v] [file]',
  async run(ctx: LinuxCommandContext, argv: string[], stdin?: string): Promise<string> {
    const sender = ctx.executor.dnsUpdateSender?.();
    if (!sender) return 'nsupdate: no DNS support on this host';

    let key: TsigKey | undefined;
    const files: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-y') {
        const parsed = parseNsupdateKeyOption(argv[++i] ?? '');
        if (typeof parsed === 'string') return parsed;
        key = parsed;
        continue;
      }
      if (a === '-v' || a === '-d' || a === '-D') continue;
      if (a.startsWith('-')) return `nsupdate: invalid option -- '${a.replace(/^-+/, '')}'`;
      files.push(a);
    }

    let text = stdin ?? '';
    if (files.length > 0) {
      const read = ctx.executor.vfs.readFile(files[0]);
      if (read === undefined || read === null) {
        return `nsupdate: can't open ${files[0]}: file not found`;
      }
      text = read;
    }
    if (text.trim().length === 0) return '';

    const script = emptyNsupdateScript();
    for (const line of text.split('\n')) {
      const error = parseNsupdateLine(line, script);
      if (error) return error;
    }
    if (script.updates.length === 0 && script.prerequisites.length === 0) return '';

    if (!script.server) return 'nsupdate: no server given and this build does not guess one';
    const serverIP = IPAddress.tryParse(script.server)
      ?? await ctx.net.resolveHostname(script.server);
    if (!serverIP) return `nsupdate: couldn't get address for '${script.server}'`;

    const request = nsupdateRequest(script);
    if (!request) return 'nsupdate: could not determine the zone to update';

    const outcome = await sender(serverIP, request, key);
    if (!outcome.answered) return 'nsupdate: no answer from the server';
    if (outcome.rcode === DnsRcode.NOERROR) return '';
    return `update failed: ${nsupdateRcodeName(outcome.rcode)}`;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const output = await nsupdateCommand.run(ctx, args, stdin) as string;
    const failed = output.startsWith('nsupdate:') || output.startsWith('update failed:');
    return { output: failed ? '' : output, exitCode: failed ? 1 : 0, stderr: failed ? output : undefined };
  },
};
