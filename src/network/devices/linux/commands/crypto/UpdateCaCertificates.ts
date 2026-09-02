import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { pemToCert } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';

const LOCAL_DIR = '/usr/local/share/ca-certificates';
const BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

function identity(cert: X509Certificate): string {
  return `${cert.subject}|${cert.serialNumber}`;
}

export const updateCaCertificatesCommand: LinuxCommand = {
  name: 'update-ca-certificates',
  package: 'ca-certificates',
  needsNetworkContext: true,
  binaryPath: '/usr/sbin/update-ca-certificates',
  manSection: 8,
  usage: 'update-ca-certificates [--fresh] [--verbose]',
  help: 'Update /etc/ssl/certs and ca-certificates.crt.',
  options: [
    { flag: '--fresh', description: 'Remove symlinks before rebuilding.' },
    { flag: '--verbose', description: 'Be verbose.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    const r = this.runWithStatusSync!(ctx, args);
    return r.stderr ? `${r.output}${r.output ? '\n' : ''}${r.stderr}` : r.output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const vfs = ctx.executor.vfs;
    const verbose = args.includes('--verbose') || args.includes('-v');

    const known = new Set(ctx.tlsTrustAnchors.map(identity));
    const lines: string[] = [`Updating certificates in /etc/ssl/certs...`];

    const names = (vfs.listDirectory(LOCAL_DIR) ?? []).map(entry => entry.name);
    const pems: string[] = [];
    let added = 0;

    for (const name of [...names].sort()) {
      if (!name.endsWith('.crt') && !name.endsWith('.pem')) continue;
      const text = vfs.readFile(`${LOCAL_DIR}/${name}`);
      if (text === null) continue;
      const cert = pemToCert(text);
      if (!cert) {
        lines.push(`W: ${LOCAL_DIR}/${name} does not contain a certificate or CRL: skipping`);
        continue;
      }
      pems.push(text.trim());
      if (known.has(identity(cert))) continue;
      known.add(identity(cert));
      ctx.addTlsTrustAnchor?.(cert);
      added += 1;
      if (verbose) lines.push(`Adding debian:${name.replace(/\.(crt|pem)$/, '')}.pem`);
    }

    vfs.writeFile(
      BUNDLE, pems.length > 0 ? `${pems.join('\n')}\n` : '',
      ctx.executor.userMgr.currentUid, ctx.executor.userMgr.currentGid, 0o022,
    );

    lines.push(`${added} added, 0 removed; done.`);
    lines.push('Running hooks in /etc/ca-certificates/update.d...');
    lines.push('done.');
    return { output: lines.join('\n'), exitCode: 0, stderr: '' };
  },
};
