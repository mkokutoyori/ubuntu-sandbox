/**
 * ScpSession — high-level orchestrator for a single `scp` invocation.
 *
 *   parse argv → resolve endpoints → run ScpTransfer → format output
 *
 * Sits on top of the SFTP/SCP model classes and exposes a single
 * `run()` method to callers (LinuxCommandExecutor, the cross-vendor
 * dispatchers). Failures map to the OpenSSH-style `scp: <reason>` line
 * with exit code 1.
 */

import { parseScpArgs, type ScpEndpoint } from '../Scp';
import { ScpTransfer, type ScpTransferOptions } from './ScpTransfer';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';

export interface ScpEndpointBinding {
  readonly endpoint: ScpEndpoint;
  readonly fs: ISftpFileSystem;
  readonly cwd: string;
}

export interface ScpSessionOptions {
  readonly args: readonly string[];
  readonly resolveRemote: (host: string) => ISftpFileSystem | null;
  readonly local: { fs: ISftpFileSystem; cwd: string };
}

export interface ScpSessionResult {
  readonly output: string;
  readonly exitCode: number;
}

export class ScpSession {
  constructor(private readonly opts: ScpSessionOptions) {}

  run(): ScpSessionResult {
    const parsed = parseScpArgs([...this.opts.args]);
    if (!parsed) {
      return { output: 'usage: scp [-options] source ... target', exitCode: 1 };
    }
    const source = this.bind(parsed.source);
    const dest   = this.bind(parsed.destination);
    if (!source) return { output: `scp: ${parsed.source.host}: no route to host`, exitCode: 1 };
    if (!dest)   return { output: `scp: ${parsed.destination.host}: no route to host`, exitCode: 1 };

    const transferOpts: ScpTransferOptions = {
      recursive: parsed.recursive,
      preserve: parsed.preserve,
      quiet: parsed.quiet,
      verbose: parsed.verbose,
      localCwd:  source.endpoint.remote ? dest.cwd   : source.cwd,
      remoteCwd: source.endpoint.remote ? source.cwd : dest.cwd,
    };
    const transfer = new ScpTransfer(
      { local: source.endpoint.remote ? dest.fs   : source.fs,
        remote: source.endpoint.remote ? source.fs : dest.fs },
      parsed.source, parsed.destination, transferOpts,
    );
    const result = transfer.run();
    if (!result.ok) return { output: `scp: ${result.error ?? 'transfer failed'}`, exitCode: 1 };
    if (parsed.quiet) return { output: '', exitCode: 0 };
    return { output: result.summary, exitCode: 0 };
  }

  private bind(ep: ScpEndpoint): ScpEndpointBinding | null {
    if (!ep.remote) {
      return { endpoint: ep, fs: this.opts.local.fs, cwd: this.opts.local.cwd };
    }
    const fs = this.opts.resolveRemote(ep.host ?? '');
    return fs ? { endpoint: ep, fs, cwd: '/' } : null;
  }
}
