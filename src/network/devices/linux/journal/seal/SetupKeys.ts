import type { SealingHost } from '../JournalctlTool';
import {
  generateMasterKey, generateState0, masterPublicKey, RECOMMENDED_SECPAR, RECOMMENDED_SEED_LENGTH,
} from './Fsprg';
import { encodeSealingKey, formatVerificationKey } from './SealingKeyFile';

export interface SetupKeysIo {
  info(message: string): void;
  say(text: string): void;
  tty(text: string): void;
  fail(message: string, errno?: string | null): never;
}

export interface SetupKeysOptions {
  readonly force: boolean;
  readonly intervalUsec: number;
  readonly nowUsec: number;
  readonly formatInterval: (usec: number) => string;
}

export function setupKeys(host: SealingHost, options: SetupKeysOptions, io: SetupKeysIo): void {
  const directory = host.persistentDirectory();
  if (directory !== 'directory') {
    return io.fail('/var/log/journal is not a directory, must be using persistent logging for FSS.');
  }
  const machine = host.machineId();
  const path = host.keyPath();
  if (options.force) {
    const refused = host.removeKey();
    if (refused !== null) return io.fail(`unlink("${path}") failed`, refused);
  } else if (host.keyExists()) {
    return io.fail(`Sealing key file ${path} exists already. Use --force to recreate.`);
  }
  io.info('Generating seed...');
  const seed = host.randomBytes(RECOMMENDED_SEED_LENGTH);
  io.info('Generating key pair...');
  const publicKey = masterPublicKey(generateMasterKey(seed));
  io.info('Generating sealing key...');
  const state = generateState0(publicKey, seed);
  const epochNumber = Math.floor(options.nowUsec / options.intervalUsec);
  const content = encodeSealingKey({
    machineId: machine, bootId: host.bootId(), startUsec: epochNumber * options.intervalUsec, intervalUsec: options.intervalUsec, secpar: RECOMMENDED_SECPAR, state,
  });
  const refused = host.writeKey(content);
  if (refused !== null) return io.fail(`Failed to open ${path}.tmp.XXXXXX`, refused);
  const key = formatVerificationKey(seed, epochNumber, options.intervalUsec);
  if (host.onTty()) {
    const hostname = host.hostname();
    io.tty(
      `\nNew keys have been generated for host ${hostname}${hostname === '' ? '' : '/'}${machine}.\n\n`
      + 'The secret sealing key has been written to the following local file.\n'
      + 'This key file is automatically updated when the sealing key is advanced.\n'
      + 'It should not be used on multiple hosts.\n\n'
      + `\t${path}\n\n`
      + `The sealing key is automatically changed every ${options.formatInterval(options.intervalUsec)}.\n\n`
      + 'Please write down the following secret verification key. It should be stored\n'
      + 'in a safe location and should not be saved locally on disk.\n\n\t',
    );
  }
  io.say(`${key}\n`);
}
