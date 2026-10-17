import { print, printError, type KeygenDialogue, type KeygenRequest, type KeygenStep, type SshKeygenHost } from './KeygenTypes';

const SK_ERR_DEVICE_NOT_FOUND = -4;
const ELF_MAGIC = '\x7fELF';
const ELF_HEADER_BYTES = 64;
const SK_TYPES: readonly string[] = ['ed25519-sk', 'ecdsa-sk'];

export function isSecurityKeyType(type: string): boolean {
  return SK_TYPES.includes(type);
}

type KeygenSteps<T> = Generator<KeygenStep, T, string | null | undefined>;

function libraryFailure(host: SshKeygenHost, path: string, symbol: string): { readonly step: string; readonly reason: string } {
  const content = host.store.read(path);
  if (content === null) return { step: 'dlopen', reason: `${path}: cannot open shared object file: No such file or directory` };
  if (content.length < ELF_HEADER_BYTES) return { step: 'dlopen', reason: `${path}: file too short` };
  if (!content.startsWith(ELF_MAGIC)) return { step: 'dlopen', reason: `${path}: invalid ELF header` };
  return { step: `dlsym(${symbol})`, reason: `${path}: undefined symbol: ${symbol}` };
}

function* providerFailure(host: SshKeygenHost, provider: string): KeygenSteps<boolean> {
  if (provider.toLowerCase() === 'internal') return false;
  const failure = libraryFailure(host, provider, 'sk_api_version');
  yield printError(`Provider "${provider}" ${failure.step} failed: ${failure.reason}`);
  return true;
}

export function* enrollSecurityKeyDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const provider = request.securityKeyProvider ?? 'internal';
  let needsPin = false;
  for (const option of request.signerOptions) {
    const lower = option.toLowerCase();
    if (lower === 'no-touch-required') continue;
    if (lower === 'verify-required' || lower === 'resident') needsPin = true;
    else if (lower.startsWith('device=') || lower.startsWith('user=') || lower.startsWith('challenge=') || lower.startsWith('write-attestation=')) continue;
    else if (lower.startsWith('application=')) {
      if (!option.slice('application='.length).startsWith('ssh:')) {
        yield printError('FIDO application string must begin with "ssh:"');
        return 255;
      }
    } else {
      yield printError(`Option "${option}" is unsupported for FIDO authenticator enrollment`);
      return 255;
    }
  }
  if (!request.quiet) yield print('You may need to touch your authenticator to authorize key generation.');
  if (needsPin) yield { kind: 'ask', prompt: 'Enter PIN for authenticator: ', hidden: true };
  if (yield* providerFailure(host, provider)) {
    yield printError('Key enrollment failed: invalid format');
    return 255;
  }
  yield printError('Key enrollment failed: device not found');
  return 255;
}

export function* downloadSecurityKeysDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  for (const option of request.signerOptions) {
    if (!option.toLowerCase().startsWith('device=')) {
      yield printError(`Option "${option}" is unsupported for FIDO authenticator download`);
      return 255;
    }
  }
  const provider = request.securityKeyProvider ?? 'internal';
  yield { kind: 'ask', prompt: 'Enter PIN for authenticator: ', hidden: true };
  if (!request.quiet) yield print('You may need to touch your authenticator to authorize key download.');
  if (yield* providerFailure(host, provider)) {
    yield printError('Unable to load resident keys: invalid format');
    return 255;
  }
  yield printError(`Provider "${provider}" returned failure ${SK_ERR_DEVICE_NOT_FOUND}`);
  yield printError('Unable to load resident keys: device not found');
  return 255;
}

export function* pkcs11Problem(host: SshKeygenHost, provider: string): KeygenSteps<void> {
  const failure = libraryFailure(host, provider, 'C_GetFunctionList');
  const label = failure.step === 'dlopen' ? `dlopen ${provider}` : failure.step;
  yield printError(`${label} failed: ${failure.reason}`);
}

export function* downloadPkcs11Dialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  yield* pkcs11Problem(host, request.pkcs11Provider ?? '');
  yield printError('cannot read public key from pkcs11');
  return 255;
}
