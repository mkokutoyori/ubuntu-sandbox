import type {
  CommandInteractionPlan, InteractionRuntime, InteractionStep, InteractionValidation,
} from '@/shell/interaction/CommandInteraction';
import { tokenize } from '../LinuxShellParser';

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

function passPhraseSteps(): InteractionStep[] {
  return [
    {
      kind: 'password',
      prompt: 'Enter PEM pass phrase:',
      storeAs: 'pem_pass_phrase',
      validate: (value): InteractionValidation => (value.length >= MINIMUM_PASS_PHRASE_LENGTH
        ? { valid: true }
        : {
          valid: false,
          errorMessage: `phrase is too short, needs to be at least ${MINIMUM_PASS_PHRASE_LENGTH} chars`,
          maxRetries: PASS_PHRASE_ATTEMPTS - 1,
        }),
    },
    {
      kind: 'password',
      prompt: 'Verifying - Enter PEM pass phrase:',
      validate: (value, values): InteractionValidation => (value === values.get('pem_pass_phrase')
        ? { valid: true }
        : { valid: false, errorMessage: 'Verify failure\nbad password read', maxRetries: 0 }),
    },
  ];
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

function requestPlan(tokens: readonly string[]): CommandInteractionPlan | null {
  const flags = new Set(tokens);
  if (flags.has('-subj') || flags.has('-batch') || flags.has('-config') || flags.has('-help')) return null;
  const isCertificate = flags.has('-x509');
  const generatesKey = !flags.has('-key') && flags.has('-keyout');
  const asksPassPhrase = generatesKey && !flags.has('-nodes') && !flags.has('-noenc') && !flags.has('-passout');

  const steps: InteractionStep[] = [];
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
      const result = await rt.exec([...tokens, ...extra].map(shellQuote).join(' '));
      if (result) rt.output(result);
    },
  });
  return { steps };
}

export function buildOpensslInteractionPlan(command: string): CommandInteractionPlan | null {
  const tokens = tokenize(command.trim());
  if (tokens[0] !== 'openssl') return null;
  if (tokens[1] === 'req') return requestPlan(tokens);
  return null;
}
