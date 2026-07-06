/**
 * `lpr` — submit a file to a remote LPD queue (PRD-Windows-Server-
 * Advanced.md §5 P20, §2.1.19). A real Windows command (LPR Port Monitor /
 * "Print Services for UNIX"), reused here as the client-side entry point
 * into `LpdTransport.ts`'s real RFC 1179 wire exchange.
 */
import type { WindowsFileSystem } from './WindowsFileSystem';
import type { TcpStack } from '@/network/tcp/TcpStack';
import { submitLpdPrintJob } from './server/print/LpdTransport';

export interface LprContext {
  hostname: string;
  owner: string;
  fs: WindowsFileSystem;
  tcpStack: TcpStack;
}

export function cmdLpr(ctx: LprContext, args: string[]): string {
  let server: string | undefined;
  let queue: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-S') { server = args[++i]; }
    else if (args[i] === '-P') { queue = args[++i]; }
    else if (!args[i].startsWith('-')) { files.push(args[i]); }
  }
  if (!server || !queue || files.length === 0) {
    return 'Usage: lpr -S server -P printer filename';
  }

  const file = ctx.fs.readFile(files[0]);
  if (!file.ok) {
    return `lpr: cannot access '${files[0]}': No such file or directory`;
  }
  const content = new TextEncoder().encode(file.content ?? '');

  const res = submitLpdPrintJob(ctx.tcpStack, server, queue, files[0], ctx.owner, ctx.hostname, content);
  if (!res.ok) return res.error ?? 'lpr: submission failed';
  return '';
}
