import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { runOpenSsl, OPENSSL_VERSION } from '@/network/crypto/openssl/OpenSslEngine';
import type { OpenSslHost } from '@/network/crypto/openssl/OpenSslHost';
import { probeTlsPeer } from '@/network/tls/tlsPeerProbe';

/**
 * docs/PRD-OpenSSL.md — la porte Linux du moteur `openssl`.
 *
 * Avant ce fichier, `dpkg -l openssl` annonçait le paquet installé et
 * le binaire n'existait pas : une machine affirmait disposer d'un outil
 * absent. `binaryPath` le déclare comme n'importe quel autre exécutable,
 * de sorte que `rm /usr/bin/openssl` le fasse disparaître pour de bon.
 */

function linuxOpenSslHost(ctx: LinuxCommandContext, stdin?: string): OpenSslHost {
  const vfs = ctx.executor.vfs;
  const chemin = (p: string) => vfs.normalizePath(p, ctx.executor.getCwd());
  return {
    readFile: (p) => vfs.readFile(chemin(p)),
    writeFile: (p, contenu) => vfs.writeFile(
      chemin(p), contenu,
      ctx.executor.userMgr.currentUid, ctx.executor.userMgr.currentGid, 0o022,
    ),
    fileExists: (p) => vfs.readFile(chemin(p)) !== null,
    now: () => Date.now(),
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
      return out;
    },
    stdin: () => stdin ?? null,
    // §P7 : le verdict d'une vraie connexion, par la même porte que
    // `nc` et `nmap` — `EndHost.tcpConnectOutcome`, synchrone parce que
    // la livraison de trames l'est dans ce simulateur.
    tcpConnect: (ip, port) => ctx.net.tcpConnectOutcome(ip, port),
    tlsPeerCertificate: (ip, port, servername) => {
      const sonde = probeTlsPeer(ctx.net.getTcpStack(), ip, port, {
        servername, trustAnchors: ctx.tlsTrustAnchors,
      });
      if (!sonde.ok) return { ok: false, reason: sonde.reason ?? 'handshake failed' };
      return {
        ok: true, certificate: sonde.certificate,
        cipherSuite: sonde.cipherSuite, verified: sonde.verified,
      };
    },
    resolveHost: (nom) => {
      const hosts = vfs.readFile('/etc/hosts') ?? '';
      for (const ligne of hosts.split('\n')) {
        const sansCommentaire = ligne.split('#')[0].trim();
        if (sansCommentaire === '') continue;
        const champs = sansCommentaire.split(/\s+/);
        if (champs.slice(1).includes(nom)) return champs[0];
      }
      return null;
    },
  };
}

export const opensslCommand: LinuxCommand = {
  name: 'openssl',
  package: 'openssl',
  // Malgré son nom, `needsNetworkContext: true` est la convention de ce
  // dépôt pour « dispatcher par le registre » plutôt que par un `case`
  // du switch — elle est écrite dans `Xxd.ts`, et `date`/`uname`/`bc`
  // la suivent sans toucher au réseau non plus. Avec `false`, la
  // commande était enregistrée, listée, complétée à la tabulation… et
  // répondait `command not found`.
  needsNetworkContext: true,
  binaryPath: '/usr/bin/openssl',
  complete: makeArgCompleter({
    flags: ['version', 'help', 'dgst', 'rand', 'base64', 'passwd', 'genrsa',
      'rsa', 'req', 'x509', 'verify', 'list', 'errstr', 'prime'],
  }),
  manSection: 1,
  usage: 'openssl command [ options ... ] [ parameters ... ]',
  help: `OpenSSL ${OPENSSL_VERSION} cryptography toolkit.`,
  options: [
    { flag: 'version', description: 'Display version information.' },
    { flag: 'dgst', description: 'Compute a message digest.' },
    { flag: 'enc', description: 'Symmetric encryption and base64 armour.' },
    { flag: 'genrsa', description: 'Generate an RSA private key.' },
    { flag: 'req', description: 'Create a certificate request or a self-signed certificate.' },
    { flag: 'x509', description: 'Display, convert or sign a certificate.' },
    { flag: 'verify', description: 'Verify a certificate chain.' },
  ],

  readsStdin: true,

  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    const r = this.runWithStatusSync!(ctx, args, stdin);
    return r.stderr ? `${r.output}${r.output && r.stderr ? '\n' : ''}${r.stderr}` : r.output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const r = runOpenSsl(linuxOpenSslHost(ctx, stdin), args);
    return { output: r.output, exitCode: r.exitCode, stderr: r.stderr };
  },
};
