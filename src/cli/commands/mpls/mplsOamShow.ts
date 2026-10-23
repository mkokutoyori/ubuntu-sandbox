import { ReturnCode } from '@/network/mpls/oam/EchoCodec';
import type { LspPingOutcome, LspTraceHop } from '@/network/devices/router/MplsOam';

export const MPLS_OAM_CODES = [
  'Codes:',
  "'!' - success, 'Q' - request not sent, '.' - timeout,",
  "'L' - labeled output interface, 'B' - unlabeled output interface,",
  "'D' - DS Map mismatch, 'F' - no FEC mapping, 'f' - FEC mismatch,",
  "'M' - malformed request, 'm' - unsupported tlvs, 'N' - no rx label,",
  "'P' - no rx intf label prot, 'p' - premature termination of LSP,",
  "'R' - transit router, 'X' - unknown return code, 'x' - return code 0",
  'Type escape sequence to abort.',
];

const CODE_LETTERS: Readonly<Record<number, string>> = {
  [ReturnCode.None]: 'x',
  [ReturnCode.Malformed]: 'M',
  [ReturnCode.TlvNotUnderstood]: 'm',
  [ReturnCode.Egress]: '!',
  [ReturnCode.NoMapping]: 'F',
  [ReturnCode.DownstreamMismatch]: 'D',
  [ReturnCode.Switched]: 'R',
  [ReturnCode.SwitchedNoMplsForwarding]: 'B',
  [ReturnCode.MappingIsNotTheLabel]: 'f',
  [ReturnCode.NoLabelEntry]: 'N',
  [ReturnCode.ProtocolNotAssociated]: 'P',
  [ReturnCode.PrematureTermination]: 'p',
};

export function returnCodeLetter(code: number): string {
  return CODE_LETTERS[code] ?? 'X';
}

export function outcomeLetter(outcome: LspPingOutcome): string {
  if (outcome.kind === 'not-sent') return 'Q';
  if (outcome.kind === 'timeout') return '.';
  return returnCodeLetter(outcome.reply.message.returnCode);
}

export interface PingTally {
  readonly sent: number;
  readonly successes: number;
  readonly roundTripMs: readonly number[];
}

export function formatPingSummary(tally: PingTally): string {
  const percent = tally.sent === 0 ? 0 : Math.floor((100 * tally.successes) / tally.sent);
  const head = `Success rate is ${percent} percent (${tally.successes}/${tally.sent})`;
  if (tally.roundTripMs.length === 0) return head;
  const rounded = tally.roundTripMs.map(ms => Math.round(ms));
  const average = Math.round(rounded.reduce((total, ms) => total + ms, 0) / rounded.length);
  return `${head}, round-trip min/avg/max = ${Math.min(...rounded)}/${average}/${Math.max(...rounded)} ms`;
}

export function formatPingMpls(
  header: { readonly count: number; readonly size: number; readonly target: string; readonly timeoutSeconds: number },
  outcomes: ReadonlyArray<{ readonly outcome: LspPingOutcome; readonly counted: boolean }>,
  verbose: boolean,
): string {
  const lines = [`Sending ${header.count}, ${header.size}-byte MPLS Echos to ${header.target}, timeout is ${header.timeoutSeconds} seconds:`, ...MPLS_OAM_CODES];
  const letters = outcomes.map(entry => outcomeLetter(entry.outcome));
  if (verbose) {
    outcomes.forEach((entry, index) => {
      lines.push(entry.outcome.kind === 'reply'
        ? `${letters[index]} ${entry.outcome.reply.from}, return code ${entry.outcome.reply.message.returnCode}`
        : letters[index]);
    });
  } else {
    lines.push(letters.join(''));
  }
  const successes = outcomes.filter(entry => entry.outcome.kind === 'reply' && entry.counted && entry.outcome.reply.message.returnCode === ReturnCode.Egress);
  lines.push(formatPingSummary({
    sent: outcomes.length, successes: successes.length,
    roundTripMs: successes.map(entry => (entry.outcome.kind === 'reply' ? entry.outcome.reply.roundTripMs : 0)),
  }));
  return lines.join('\n');
}

function labelsText(labels: readonly number[]): string {
  if (labels.length === 0) return '[]';
  if (labels.every(label => label === 3)) return '[implicit-null]';
  return `[Labels: ${labels.map(label => (label === 3 ? 'implicit-null' : String(label))).join('/')} Exp: ${labels.map(() => 0).join('/')}]`;
}

export function formatTraceMpls(
  header: { readonly target: string; readonly timeoutSeconds: number },
  origin: { readonly interfaceAddress: string; readonly mtu: number; readonly labels: readonly number[] },
  hops: readonly LspTraceHop[],
): string {
  const lines = [`Tracing MPLS Label Switched Path to ${header.target}, timeout is ${header.timeoutSeconds} seconds`, ...MPLS_OAM_CODES];
  lines.push(`  0 ${origin.interfaceAddress} mtu ${origin.mtu} ${labelsText(origin.labels)}`);
  for (const hop of hops) {
    const letter = outcomeLetter(hop.outcome);
    if (hop.outcome.kind !== 'reply') {
      lines.push(`${letter} ${hop.ttl}`);
      continue;
    }
    const downstream = hop.downstream === null ? '' : ` mtu ${hop.downstream.mtu} ${labelsText(hop.downstream.labelStack.map(entry => entry.label))}`;
    lines.push(`${letter} ${hop.ttl} ${hop.outcome.reply.from}${downstream} ${Math.round(hop.outcome.reply.roundTripMs)} ms`);
  }
  return lines.join('\n');
}
