export const OPENSSH_USAGE = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
  '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
  '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]',
  '           [-i identity_file] [-J [user@]host[:port]] [-L address]',
  '           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]',
  '           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]',
  '           [-w local_tun[:remote_tun]] destination [command [argument ...]]',
].join('\n');

const FLAG_OPTIONS = new Set('1246afgknqstvxACGKMNPTVXYy');
const VALUE_OPTIONS = new Set('bceilmopBDEFIJLOQRSwW');

export interface SshReplyWithoutSession {
  readonly output: string;
  readonly exitCode: number;
}

export function sshReplyWithoutSession(
  args: readonly string[], clientVersion: string,
): SshReplyWithoutSession | null {
  const usage = { output: OPENSSH_USAGE, exitCode: 255 };
  let destination = false;
  let terminated = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (terminated || !arg.startsWith('-') || arg === '-') {
      if (destination) break;
      destination = true;
      continue;
    }
    if (arg === '--') {
      terminated = true;
      continue;
    }
    for (let c = 1; c < arg.length; c++) {
      const letter = arg[c];
      if (letter === 'V') return { output: clientVersion, exitCode: 0 };
      if (VALUE_OPTIONS.has(letter)) {
        if (c === arg.length - 1) i++;
        break;
      }
      if (!FLAG_OPTIONS.has(letter)) return usage;
    }
  }
  return destination ? null : usage;
}
