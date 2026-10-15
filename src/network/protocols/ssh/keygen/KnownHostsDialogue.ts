import { hashedLineFor, lineMatchesName, parseKnownHostsLines } from '../hostkey/KnownHostsLines';
import { keygenDigest } from '@/network/devices/linux/network/SshKeygenMaterial';
import { print, type KeygenDialogue, type KeygenRequest, type SshKeygenHost } from './KeygenTypes';

function knownHostsPathOf(host: SshKeygenHost): string {
  return `${host.sshDir}/known_hosts`;
}

const KEY_TYPE_NAMES: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ssh-dss': 'DSA', 'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA', 'ecdsa-sha2-nistp521': 'ECDSA',
};

export function* knownHostsDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const path = request.file ?? knownHostsPathOf(host);
  const text = host.store.read(path);
  if (text === null) {
    yield print(`Cannot stat ${path}: No such file or directory`);
    return 255;
  }
  const lines = parseKnownHostsLines(text);
  if (request.findHost !== undefined) {
    const wanted = request.findHost;
    let found = false;
    for (const line of lines) {
      if (!lineMatchesName(line, wanted)) continue;
      found = true;
      const marker = line.marker === 'ca' ? 'CA' : line.marker === 'revoke' ? 'REVOKED' : '';
      if (!request.quiet) yield print(`# Host ${wanted} found: line ${line.number} ${marker}`);
      if (request.hashHosts) {
        for (const hashed of hashedLineFor(line)) yield print(hashed);
      } else if (request.fingerprint) {
        const fingerprint = keygenDigest(`${line.keyType} ${line.keyBlob}`, request.hash);
        yield print(`${wanted} ${KEY_TYPE_NAMES[line.keyType] ?? line.keyType} ${fingerprint}${line.comment === '' ? '' : ` ${line.comment}`}`);
      } else {
        yield print(line.raw);
      }
    }
    return found ? 0 : 1;
  }
  const invalid = lines.some((line) => line.status === 'invalid');
  if (invalid) {
    yield print(`${path} is not a valid known_hosts file.`);
    yield print('Not replacing existing known_hosts file because of errors');
    return 1;
  }
  const deleting = request.deleteHost !== undefined;
  const wanted = request.deleteHost ?? '';
  const kept: string[] = [];
  let removed = false;
  let unhashed = false;
  for (const line of lines) {
    if (deleting) {
      if (lineMatchesName(line, wanted) && line.marker === null) {
        removed = true;
        yield print(`# Host ${wanted} found: line ${line.number}`);
        continue;
      }
      kept.push(line.raw);
      continue;
    }
    const rewritten = hashedLineFor(line);
    if (rewritten.length !== 1 || rewritten[0] !== line.raw) unhashed = true;
    kept.push(...rewritten);
  }
  if (deleting && !removed) {
    yield print(`Host ${wanted} not found in ${path}`);
    return 0;
  }
  const failure = host.store.write(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`, false);
  if (failure !== null) {
    yield print(`Unable to write ${path}`);
    return 1;
  }
  host.store.write(`${path}.old`, text, false);
  yield print(`${path} updated.`);
  yield print(`Original contents retained as ${path}.old`);
  if (unhashed) {
    yield print(`WARNING: ${path}.old contains unhashed entries`);
    yield print('Delete this file to ensure privacy of hostnames');
  }
  return 0;
}
