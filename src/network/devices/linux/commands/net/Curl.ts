/**
 * `curl` — deep-inspection wrapper around the network-agnostic `cmdCurl`.
 *
 * When the target scheme is HTTPS but the listener on the port speaks a
 * non-TLS protocol (SSH, SMTP, Oracle TNS, …), report the OpenSSL-style
 * failure a real curl would emit. This is what makes Scenario 7's
 * "port 443 = HTTPS" assumption falsifiable from the command line.
 *
 * Non-HTTPS or non-hijacked cases fall through to the pre-existing
 * `cmdCurl` renderer.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { findHostByAddress } from '../../network/HostLookup';
import { grabBanner } from './ServiceBannerGrab';
import { detectServiceFromBanner } from './Nmap';
import { cmdCurl } from '../../LinuxNetCommands';

export const curlCommand: LinuxCommand = {
  name: 'curl',
  needsNetworkContext: true,
  usage: 'curl [-k] [-s] [-v] [-I] URL',
  help: 'Transfer data from or to a server.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    let url: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-k' || a === '--insecure') continue;
      if (a === '-s' || a === '--silent' || a === '-v' || a === '-I' || a === '--head') continue;
      if (!a.startsWith('-')) url = a;
    }
    if (!url) return cmdCurl(args);

    const m = /^(https?):\/\/([^\/:]+)(?::(\d+))?(\/.*)?$/i.exec(url);
    if (!m) return cmdCurl(args);
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const port = m[3] ? parseInt(m[3], 10) : scheme === 'https' ? 443 : 80;

    if (scheme !== 'https') return cmdCurl(args);

    const vfs = ctx.executor.vfs;
    const found = findHostByAddress(host, { readFile: (p) => vfs.readFile(p) });
    if (!found) return cmdCurl(args);

    const banner = grabBanner(found.device, port);
    if (banner && !banner.startsWith('HTTP/')) {
      const detected = detectServiceFromBanner(banner);
      const svc = detected?.service ?? 'unknown';
      return `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ${host}:${port} — peer sent non-TLS bytes (${svc} banner detected)`;
    }
    return cmdCurl(args);
  },
};
