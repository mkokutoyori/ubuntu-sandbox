import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { compileFilter } from '@/network/devices/linux/network/tcpdump/TcpdumpFilter';
import { expandFilterTokens } from '@/network/devices/linux/network/tcpdump/TcpdumpCli';
import type { CaptureFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import type { CapturedFrame } from './PacketCapture';

export type SnifferMatcher = (entry: CapturedFrame) => boolean;

export type SnifferFilterResult =
  | { readonly ok: true; readonly matches: SnifferMatcher }
  | { readonly ok: false; readonly message: string };

export function decodeCaptured(entry: CapturedFrame): CaptureFrame {
  return decodeEthernetFrame(entry.frame, entry.iface, entry.direction, new Date(entry.at));
}

export function compileSnifferFilter(expression: string): SnifferFilterResult {
  const tokens = expandFilterTokens([expression]);
  if (tokens.length === 0) return { ok: true, matches: () => true };
  const compiled = compileFilter(tokens);
  if (compiled.ok === false) return { ok: false, message: compiled.message };
  return { ok: true, matches: (entry) => compiled.predicate(decodeCaptured(entry)) };
}
