/**
 * `rndc` — BIND9 name server control utility (PRD-Nslookup-Dig-Rndc-Runas.md
 * §2.1.4/P9).
 *
 * Two modes, chosen by whether the caller opted into the real protocol:
 *  - **Legacy invocation** (`rndc status`, no `-s`/`-p`/`-k`/`-c`/`-y`):
 *    delegates straight to `RndcChannel.dispatch()` in-process, exactly as
 *    before — unchanged so the many existing tests written against this
 *    keyless shortcut keep passing (additive, not migration).
 *  - **Real protocol** (any of `-s`/`-p`/`-k`/`-c`/`-y` given): discovers a
 *    key (from `-k`/`-c`, defaulting to `/etc/rndc.key`), signs the command,
 *    and sends it over a real, HMAC-authenticated channel — `RndcClient.ts`
 *    for a remote/explicit server, or `Bind9Service.dispatchRndcLocally`
 *    for the local (127.0.0.1) case, since this simulator's `TcpStack` has
 *    no loopback delivery (see `RndcClient.ts`'s header comment).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { RndcChannel } from '../../bind9/RndcChannel';
import { buildNamedConfig } from '../../bind9/NamedConfig';
import type { NamedKey } from '../../bind9/NamedConfig';
import { parseNamedConf } from '../../bind9/NamedConfParser';
import { NamedConfSyntaxError } from '../../bind9/NamedConfLexer';
import { NamedConfigError } from '../../bind9/NamedConfigError';
import { sendRndcCommand } from '../../bind9/RndcClient';
import type { RndcRequest, RndcResponse } from '../../bind9/RndcWireCodec';
import { signRndcEnvelope } from '../../bind9/RndcWireCodec';

const DEFAULT_RNDC_PORT = 953;
const DEFAULT_KEY_FILE = '/etc/rndc.key';
const NONCE_SPACE = 0xffffffff;

interface RndcInvocation {
  server: string | null;
  port: number | null;
  keyFile: string | null;
  configFile: string | null;
  keyName: string | null;
  command: string[];
}

function parseRndcArgs(args: string[]): RndcInvocation {
  const invocation: RndcInvocation = {
    server: null, port: null, keyFile: null, configFile: null, keyName: null, command: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-s' && args[i + 1]) invocation.server = args[++i];
    else if (arg === '-p' && args[i + 1]) invocation.port = parseInt(args[++i], 10) || DEFAULT_RNDC_PORT;
    else if (arg === '-k' && args[i + 1]) invocation.keyFile = args[++i];
    else if (arg === '-c' && args[i + 1]) invocation.configFile = args[++i];
    else if (arg === '-y' && args[i + 1]) invocation.keyName = args[++i];
    else invocation.command.push(arg);
  }
  return invocation;
}

function usesRealProtocol(invocation: RndcInvocation): boolean {
  return invocation.server !== null || invocation.port !== null
    || invocation.keyFile !== null || invocation.configFile !== null || invocation.keyName !== null;
}

type LoadKeysResult = { readonly keys: ReadonlyMap<string, NamedKey> } | { readonly error: string };

/** `rndc.key`/`rndc.conf` share `named.conf`'s `key { algorithm; secret; };` syntax, so this reuses the same parser wholesale. */
function loadKeys(ctx: LinuxCommandContext, path: string): LoadKeysResult {
  const content = ctx.executor.readFile(path);
  if (content === null) return { error: `couldn't open file '${path}': No such file or directory` };
  try {
    const config = buildNamedConfig(parseNamedConf(content, { file: path }));
    return { keys: config.keys };
  } catch (error) {
    if (error instanceof NamedConfSyntaxError || error instanceof NamedConfigError) {
      return { error: error.message };
    }
    throw error;
  }
}

export const rndcCommand: LinuxCommand = {
  name: 'rndc',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'rndc [-s server] [-p port] [-k keyfile] [-c config] [-y keyname] command [zone]',
  help:
    'Name server control utility.\n\n' +
    'Controls the operation of a name server over the control channel\n' +
    '(127.0.0.1#953 by default).\n\n' +
    'OPTIONS\n' +
    '  -s server     Name server to control (default: 127.0.0.1).\n' +
    '  -p port       Control channel port (default: 953).\n' +
    '  -k keyfile    Path to a file containing a shared key.\n' +
    '  -c config     Path to an rndc.conf-style file containing a shared key.\n' +
    '  -y keyname    Use this key from the key file/config.\n\n' +
    'COMMANDS\n' +
    '  status                Display status of the server.\n' +
    '  reload [zone]         Reload configuration file and zones.\n' +
    '  reconfig              Reload configuration file and new zones only.\n' +
    '  flush                 Flush the server cache.\n' +
    '  freeze [zone]         Suspend updates to a dynamic zone.\n' +
    '  thaw [zone]           Enable updates to a frozen dynamic zone and\n' +
    '                        reload it.\n' +
    '  querylog [on|off]     Enable / disable query logging.',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const invocation = parseRndcArgs(args);

    if (!usesRealProtocol(invocation)) {
      return new RndcChannel(ctx.bind9).dispatch(invocation.command);
    }

    if (invocation.command.length === 0) {
      return 'rndc: no command specified\nUsage: rndc [-c config] command';
    }

    const explicitKeySource = invocation.keyFile !== null || invocation.configFile !== null;
    const keyPath = invocation.keyFile ?? invocation.configFile ?? DEFAULT_KEY_FILE;
    const loaded = loadKeys(ctx, keyPath);
    if ('error' in loaded) {
      return explicitKeySource
        ? `rndc: ${loaded.error}`
        : 'rndc: neither /etc/rndc.conf nor /etc/rndc.key was found';
    }

    const keyName = invocation.keyName ?? loaded.keys.keys().next().value ?? null;
    const key = keyName ? loaded.keys.get(keyName) : undefined;
    if (!key) {
      return `rndc: no key definition for '${keyName ?? ''}'`;
    }

    const server = invocation.server ?? '127.0.0.1';
    const port = invocation.port ?? DEFAULT_RNDC_PORT;
    const command = invocation.command.join(' ');

    if (server === '127.0.0.1' || server === 'localhost') {
      const request: RndcRequest = { nonce: Math.floor(Math.random() * NONCE_SPACE), command };
      const envelope = signRndcEnvelope(request, key.algorithm, key.secret);
      const reply = ctx.bind9.dispatchRndcLocally(envelope);
      if (!reply) return `rndc: connect failed: 127.0.0.1#${port}: connection refused`;
      return (reply.payload as RndcResponse).text;
    }

    const result = await sendRndcCommand(ctx.net.getTcpStack(), server, port, command, key.algorithm, key.secret);
    return result.text;
  },
};
