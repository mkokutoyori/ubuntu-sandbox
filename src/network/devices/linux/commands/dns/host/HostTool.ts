import { emit, outputOf, type ToolOutput } from '../../../kerberos/Krb5ToolOutput';
import { parseHostArguments } from './HostArguments';
import type { HostPort } from './HostPort';
import { HostSession } from './HostSession';

export async function runHost(args: readonly string[], port: HostPort): Promise<ToolOutput> {
  const parsed = parseHostArguments(args, { ipv6: port.ipv6Available() });
  if (parsed.kind === 'exit') {
    const out = outputOf();
    if (parsed.stdout !== '') emit(out, 'stdout', parsed.stdout);
    if (parsed.stderr !== '') emit(out, 'stderr', parsed.stderr);
    out.exitCode = parsed.status;
    return out;
  }
  return new HostSession(parsed.options, port).run();
}
