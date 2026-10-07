import type {
  CommandInteractionPlan, InteractionRuntime, InteractionStep, InteractionValidation,
} from '@/shell/interaction/CommandInteraction';
import { tokenize } from '../LinuxShellParser';
import { ENC_ALGOS } from '@/network/crypto/openssl/OpenSslEnc';
import { isEncryptedPrivateKeyPem } from '@/network/pki/pem';

export interface OpensslPlannerDevice {
  readTextFile?(path: string): string | null;
}

const MINIMUM_PASS_PHRASE_LENGTH = 4;
const PASS_PHRASE_ATTEMPTS = 3;

interface DistinguishedNameField {
  readonly prompt: string;
  readonly attribute: string;
  readonly defaultValue: string;
  readonly minimum: number;
  readonly maximum: number;
}

const DISTINGUISHED_NAME_FIELDS: readonly DistinguishedNameField[] = [
  { prompt: 'Country Name (2 letter code)', attribute: 'C', defaultValue: 'AU', minimum: 2, maximum: 2 },
  { prompt: 'State or Province Name (full name)', attribute: 'ST', defaultValue: 'Some-State', minimum: 0, maximum: 128 },
  { prompt: 'Locality Name (eg, city)', attribute: 'L', defaultValue: '', minimum: 0, maximum: 128 },
  { prompt: 'Organization Name (eg, company)', attribute: 'O', defaultValue: 'Internet Widgits Pty Ltd', minimum: 0, maximum: 64 },
  { prompt: 'Organizational Unit Name (eg, section)', attribute: 'OU', defaultValue: '', minimum: 0, maximum: 64 },
  { prompt: 'Common Name (e.g. server FQDN or YOUR name)', attribute: 'CN', defaultValue: '', minimum: 0, maximum: 64 },
  { prompt: 'Email Address', attribute: 'emailAddress', defaultValue: '', minimum: 0, maximum: 40 },
];

const REQUEST_HEADER = [
  '-----',
  'You are about to be asked to enter information that will be incorporated',
  'into your certificate request.',
  'What you are about to enter is what is called a Distinguished Name or a DN.',
  'There are quite a few fields but you can leave some blank',
  'For some fields there will be a default value,',
  "If you enter '.', the field will be left blank.",
  '-----',
];

const ATTRIBUTES_HEADER = [
  "Please enter the following 'extra' attributes",
  'to be sent with your certificate request',
];

function shellQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

function lengthRefusal(field: DistinguishedNameField, value: string): string | null {
  if (value.length > field.maximum) {
    return `string is too long, it needs to be no more than ${field.maximum} bytes long`;
  }
  if (value.length < field.minimum) {
    return `string is too short, it needs to be at least ${field.minimum} bytes long`;
  }
  return null;
}

function secretSteps(prompt: string, storeAs: string, minimum: number, verify: boolean): InteractionStep[] {
  const steps: InteractionStep[] = [{
    kind: 'password',
    prompt,
    storeAs,
    validate: (value): InteractionValidation => (value.length >= minimum
      ? { valid: true }
      : {
        valid: false,
        errorMessage: `phrase is too short, needs to be at least ${minimum} chars`,
        maxRetries: PASS_PHRASE_ATTEMPTS - 1,
      }),
  }];
  if (verify) {
    steps.push({
      kind: 'password',
      prompt: `Verifying - ${prompt}`,
      validate: (value, values): InteractionValidation => (value === values.get(storeAs)
        ? { valid: true }
        : { valid: false, errorMessage: 'Verify failure\nbad password read', maxRetries: 0 }),
    });
  }
  return steps;
}

function rewriteAndRun(tokens: readonly string[], extra: (values: ReadonlyMap<string, string>) => string[]): InteractionStep {
  return {
    kind: 'run',
    run: async (rt: InteractionRuntime) => {
      const result = await rt.exec([...tokens, ...extra(rt.values)].map(shellQuote).join(' '));
      if (result) rt.output(result);
    },
  };
}

function passPhraseSteps(): InteractionStep[] {
  return secretSteps('Enter PEM pass phrase:', 'pem_pass_phrase', MINIMUM_PASS_PHRASE_LENGTH, true);
}

function fieldSteps(field: DistinguishedNameField): InteractionStep {
  const shown = field.defaultValue === '' ? '[]' : `[${field.defaultValue}]`;
  return {
    kind: 'text',
    prompt: `${field.prompt} ${shown}:`,
    allowEmpty: true,
    storeAs: `dn_${field.attribute}`,
    validate: (value): InteractionValidation => {
      const trimmed = value.trim();
      if (trimmed === '' || trimmed === '.') return { valid: true };
      const refusal = lengthRefusal(field, trimmed);
      return refusal === null ? { valid: true } : { valid: false, errorMessage: refusal };
    },
  };
}

function subjectFrom(values: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  for (const field of DISTINGUISHED_NAME_FIELDS) {
    const answer = (values.get(`dn_${field.attribute}`) ?? '').trim();
    const value = answer === '.' ? '' : answer === '' ? field.defaultValue : answer;
    if (value !== '') parts.push(`${field.attribute}=${value.replace(/([/\\])/g, '\\$1')}`);
  }
  return `/${parts.join('/')}`;
}

function requestPlan(tokens: readonly string[], device: OpensslPlannerDevice): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (flags.has('-subj') || flags.has('-batch') || flags.has('-config') || flags.has('-help')) return null;
  const isCertificate = flags.has('-x509');
  const generatesKey = !flags.has('-key') && flags.has('-keyout');
  const asksPassPhrase = generatesKey && !flags.has('-nodes') && !flags.has('-noenc') && !flags.has('-passout');

  const keyPath = flags.has('-key') && !flags.has('-passin') ? tokens[tokens.indexOf('-key') + 1] : undefined;
  const keyText = keyPath === undefined ? null : device.readTextFile?.(keyPath) ?? null;
  const asksKeyPassPhrase = keyText !== null && isEncryptedPrivateKeyPem(keyText);

  const steps: InteractionStep[] = [];
  if (asksKeyPassPhrase) steps.push(...secretSteps(`Enter pass phrase for ${keyPath}:`, 'key_pass_phrase', 0, false));
  if (asksPassPhrase) steps.push(...passPhraseSteps());
  steps.push({ kind: 'output', lines: REQUEST_HEADER });
  for (const field of DISTINGUISHED_NAME_FIELDS) steps.push(fieldSteps(field));
  if (!isCertificate) {
    steps.push({ kind: 'output', lines: ATTRIBUTES_HEADER });
    steps.push({ kind: 'text', prompt: 'A challenge password []:', allowEmpty: true, storeAs: 'challenge_password' });
    steps.push({ kind: 'text', prompt: 'An optional company name []:', allowEmpty: true, storeAs: 'unstructured_name' });
  }
  steps.push({
    kind: 'run',
    run: async (rt: InteractionRuntime) => {
      const extra = ['-subj', subjectFrom(rt.values)];
      if (asksPassPhrase) extra.push('-passout', `pass:${rt.values.get('pem_pass_phrase') ?? ''}`);
      if (asksKeyPassPhrase) extra.push('-passin', `pass:${rt.values.get('key_pass_phrase') ?? ''}`);
      const result = await rt.exec([...tokens, ...extra].map(shellQuote).join(' '));
      if (result) rt.output(result);
    },
  });
  return { steps };
}

const CIPHER_FLAGS: readonly string[] = [
  '-aes128', '-aes192', '-aes256', '-des3', '-camellia128', '-camellia192', '-camellia256',
  '-aria128', '-aria192', '-aria256',
];

function operandsOf(tokens: readonly string[], valued: ReadonlySet<string>): string[] {
  const operands: string[] = [];
  for (let i = 2; i < tokens.length; i++) {
    if (valued.has(tokens[i])) i++;
    else if (!tokens[i].startsWith('-')) operands.push(tokens[i]);
  }
  return operands;
}

function encryptionPlan(tokens: readonly string[], forced?: string): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (['-k', '-kfile', '-pass', '-K', '-help'].some((flag) => flags.has(flag))) return null;
  const algorithm = forced ?? Object.keys(ENC_ALGOS).find((name) => flags.has(`-${name}`));
  if (algorithm === undefined) return null;
  const encrypting = !flags.has('-d');
  const prompt = `enter ${algorithm.toUpperCase()} ${encrypting ? 'encryption' : 'decryption'} password:`;
  return {
    steps: [
      ...secretSteps(prompt, 'enc_password', 0, encrypting),
      rewriteAndRun(tokens, (values) => ['-pass', `pass:${values.get('enc_password') ?? ''}`]),
    ],
  };
}

function passwdPlan(tokens: readonly string[]): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (flags.has('-in') || flags.has('-stdin') || flags.has('-help')) return null;
  if (operandsOf(tokens, new Set(['-salt', '-in', '-rand', '-writerand', '-provider', '-provider-path', '-propquery'])).length > 0) return null;
  const verify = !(flags.has('-salt') || flags.has('-noverify'));
  return {
    steps: [
      ...secretSteps('Password: ', 'passwd_secret', 0, verify),
      rewriteAndRun(tokens, (values) => [values.get('passwd_secret') ?? '']),
    ],
  };
}

function genrsaPlan(tokens: readonly string[]): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (!CIPHER_FLAGS.some((flag) => flags.has(flag)) || flags.has('-passout') || flags.has('-help')) return null;
  return {
    steps: [
      ...secretSteps('Enter PEM pass phrase:', 'pem_pass_phrase', MINIMUM_PASS_PHRASE_LENGTH, true),
      rewriteAndRun(tokens, (values) => ['-passout', `pass:${values.get('pem_pass_phrase') ?? ''}`]),
    ],
  };
}

function pkcs8Plan(tokens: readonly string[]): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (!flags.has('-topk8') || flags.has('-nocrypt') || flags.has('-passout') || flags.has('-help')) return null;
  return {
    steps: [
      ...secretSteps('Enter Encryption Password:', 'pkcs8_password', 0, true),
      rewriteAndRun(tokens, (values) => ['-passout', `pass:${values.get('pkcs8_password') ?? ''}`]),
    ],
  };
}

const SIGN_PROMPT = 'Sign the certificate? [y/n]:';
const COMMIT_PROMPT = '1 out of 1 certificate requests certified, commit? [y/n]';
const NOT_SIGNED = 'CERTIFICATE WILL NOT BE CERTIFIED';
const NOT_COMMITTED = 'CERTIFICATION CANCELED';

function isYes(values: ReadonlyMap<string, string>, name: string): boolean {
  return /^\s*[yY]/.test(values.get(name) ?? '');
}

function caSigningPlan(tokens: readonly string[], device: OpensslPlannerDevice): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  const standalone = ['-batch', '-revoke', '-gencrl', '-updatedb', '-status', '-help', '-spkac', '-ss_cert'];
  if (standalone.some((flag) => flags.has(flag)) || !(flags.has('-in') || flags.has('-infiles'))) return null;
  const keyPath = flags.has('-passin') ? undefined : tokens[tokens.indexOf('-keyfile') + 1];
  const keyText = keyPath === undefined ? null : device.readTextFile?.(keyPath) ?? null;
  const asksKeyPassPhrase = keyText !== null && isEncryptedPrivateKeyPem(keyText);
  let passin: string[] = [];
  const pipeline = (answers: string, extra: readonly string[]): string =>
    `printf '%s' ${shellQuote(answers)} | ${[...tokens, ...passin, ...extra].map(shellQuote).join(' ')}`;
  return {
    steps: [
      ...(asksKeyPassPhrase ? secretSteps(`Enter pass phrase for ${keyPath}:`, 'key_pass_phrase', 0, false) : []),
      {
        kind: 'run',
        run: async (rt: InteractionRuntime) => {
          if (asksKeyPassPhrase) passin = ['-passin', `pass:${rt.values.get('key_pass_phrase') ?? ''}`];
          const preview = await rt.exec(pipeline('n\n', []));
          const at = preview.indexOf(SIGN_PROMPT);
          if (at < 0) { rt.values.set('ca_failed', '1'); if (preview) rt.output(preview); return; }
          rt.output(preview.slice(0, at).replace(/\n$/, ''));
        },
      },
      { kind: 'branch', to: (values) => (values.get('ca_failed') === '1' ? 'ca_end' : null) },
      { kind: 'text', prompt: SIGN_PROMPT, allowEmpty: true, storeAs: 'ca_sign' },
      { kind: 'branch', to: (values) => (isYes(values, 'ca_sign') ? null : 'ca_refused') },
      { kind: 'output', lines: [''] },
      { kind: 'text', prompt: COMMIT_PROMPT, allowEmpty: true, storeAs: 'ca_commit' },
      {
        kind: 'run',
        run: async (rt: InteractionRuntime) => {
          if (!isYes(rt.values, 'ca_commit')) { rt.output(NOT_COMMITTED); return; }
          const done = await rt.exec(pipeline('', ['-batch']));
          const at = done.indexOf('Write out database');
          rt.output(at < 0 ? done : done.slice(at));
        },
      },
      { kind: 'branch', to: () => 'ca_end' },
      { kind: 'label', name: 'ca_refused' },
      { kind: 'output', lines: [NOT_SIGNED] },
      { kind: 'label', name: 'ca_end' },
    ],
  };
}

const KEY_FILE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  rsa: ['-in'], pkey: ['-in'], ec: ['-in'], pkcs8: ['-in'],
  req: ['-key'], x509: ['-signkey', '-CAkey'], ca: ['-keyfile'],
  pkeyutl: ['-inkey'], rsautl: ['-inkey'], ocsp: ['-rkey'], pkcs12: ['-inkey'],
};

function encryptedKeyPlan(
  tokens: readonly string[], device: OpensslPlannerDevice,
): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (flags.has('-passin') || flags.has('-help') || device.readTextFile === undefined) return null;
  const options = KEY_FILE_OPTIONS[tokens[1]] ?? [];
  for (const option of options) {
    const at = tokens.indexOf(option);
    const path = at >= 0 ? tokens[at + 1] : undefined;
    if (path === undefined) continue;
    const text = device.readTextFile(path);
    if (text === null || !isEncryptedPrivateKeyPem(text)) continue;
    return {
      steps: [
        ...secretSteps(`Enter pass phrase for ${path}:`, 'key_pass_phrase', 0, false),
        rewriteAndRun(tokens, (values) => ['-passin', `pass:${values.get('key_pass_phrase') ?? ''}`]),
      ],
    };
  }
  return null;
}

export function buildOpensslInteractionPlan(
  command: string, device: OpensslPlannerDevice = {},
): CommandInteractionPlan | null {
  const tokens = tokenize(command.trim());
  if (tokens[0] !== 'openssl') return null;
  const sub = tokens[1];
  if (sub === 'req') return requestPlan(tokens, device) ?? encryptedKeyPlan(tokens, device);
  if (sub === 'enc') return encryptionPlan(tokens);
  if (sub !== undefined && ENC_ALGOS[sub] !== undefined) return encryptionPlan(tokens, sub);
  if (sub === 'passwd') return passwdPlan(tokens);
  if (sub === 'ca') return caSigningPlan(tokens, device) ?? encryptedKeyPlan(tokens, device);
  if (sub === 'genrsa') return genrsaPlan(tokens);
  if (sub === 'pkcs8') return pkcs8Plan(tokens) ?? encryptedKeyPlan(tokens, device);
  return encryptedKeyPlan(tokens, device);
}
