import type { RadiusPacket, RadiusUser } from '@/network/radius/types';
import { MICROSOFT_VENDOR_ID } from '@/network/radius/dictionary';
import type { Pipeline, ProcessingSection } from './PipelineConfig';

export type ModuleResult = 'reject' | 'fail' | 'ok' | 'handled' | 'invalid' | 'userlock' | 'notfound' | 'noop' | 'updated';

export interface ResolutionTrace {
  preprocessRejected: boolean;
  matched: Array<{ name: string; line: number }>;
  loginTime: string | null;
  loginVerdict: ModuleResult;
  secondsLeft: number;
}

export interface DebugInput {
  server: string;
  pipeline: Pipeline | undefined;
  request: RadiusPacket;
  user: RadiusUser | undefined;
  resolution: ResolutionTrace | null;
  usersPath: string;
  accepted: boolean;
  receivedLines: string[];
  replyLines: string[];
}

const DEFAULT_AUTHORIZE = ['preprocess', 'chap', 'mschap', 'eap', 'files', 'logintime', 'pap'];
const KNOWN_GOOD_NAMES: Record<string, string> = {
  'cleartext-password': 'Cleartext-Password', 'md5-password': 'MD5-Password', 'smd5-password': 'SMD5-Password',
  'sha-password': 'SHA-Password', 'ssha-password': 'SSHA-Password', 'sha2-password': 'SHA2-Password', 'nt-password': 'NT-Password',
  'crypt-password': 'Crypt-Password', 'password-with-header': 'Password-With-Header',
};

export function knownGoodDisplayName(itemName: string): string {
  return KNOWN_GOOD_NAMES[itemName.toLowerCase()] ?? itemName;
}

const PRIORITY: ModuleResult[] = ['reject', 'userlock', 'fail', 'invalid', 'handled', 'updated', 'ok', 'notfound', 'noop'];

function combine(results: ModuleResult[]): ModuleResult {
  for (const candidate of PRIORITY) if (results.includes(candidate)) return candidate;
  return 'noop';
}

function located(pipeline: Pipeline | undefined, section: ProcessingSection): string {
  const place = pipeline?.locations.get(section);
  return place === undefined ? '' : ` from file ${place.file} line ${place.line}`;
}

export function requestDebugLines(input: DebugInput): string[] {
  const { request, user, pipeline } = input;
  const has = (type: string) => request.attributes.some((attribute) => attribute.type === type);
  const lines: string[] = [`Virtual server ${input.server} received request`, ...input.receivedLines, `server ${input.server} {`];
  const inner = (text: string, depth: number): void => { lines.push(`${'  '.repeat(depth)}${text}`); };
  const authorize = pipeline?.sections.get('authorize');
  const order = authorize === undefined ? DEFAULT_AUTHORIZE : Array.from(authorize);
  const hasCleartext = user !== undefined && user.knownGoodName !== undefined;
  let authType: 'PAP' | 'CHAP' | 'Accept' | null = null;
  const results: ModuleResult[] = [];
  const body: string[] = [];
  for (const module of order) {
    let result: ModuleResult = 'noop';
    const messages: string[] = [];
    if (module === 'preprocess') result = input.resolution?.preprocessRejected === true ? 'reject' : 'ok';
    else if (module === 'chap' && has('chap-password')) { result = 'ok'; messages.push('chap: &control:Auth-Type := CHAP'); if (authType === null) authType = 'CHAP'; }
    else if (module === 'mschap' && request.attributes.some((attribute) => attribute.type === 'vendor-specific' && attribute.vendor?.id === MICROSOFT_VENDOR_ID && attribute.vendor.type === 25)) result = 'ok';
    else if (module === 'eap') {
      if (has('eap-message')) result = 'ok';
      else messages.push('eap: No EAP-Message, not doing EAP');
    } else if (module === 'files') {
      for (const entry of input.resolution?.matched ?? []) messages.push(`files: ${input.usersPath}: Matched entry ${entry.name} at line ${entry.line}`);
      result = (input.resolution?.matched.length ?? 0) > 0 ? 'ok' : 'noop';
    } else if (module === 'logintime' && input.resolution?.loginTime !== null && input.resolution !== null) {
      messages.push('logintime: Checking Login-Time');
      result = input.resolution.loginVerdict;
      if (result === 'updated') {
        messages.push(`logintime: Login within allowed time-slot, ${input.resolution.secondsLeft} seconds left in this session`);
        messages.push(`logintime: reply:Session-Timeout set to ${input.resolution.secondsLeft}`);
      } else if (result === 'userlock') messages.push('logintime: ERROR: Login outside of allowed time-slot');
    } else if (module === 'pap') {
      if (!has('user-password')) messages.push('pap: No User-Password attribute in the request.  Cannot do PAP');
      else if (!hasCleartext) {
        messages.push('pap: WARNING: No "known good" password found for the user.  Not setting Auth-Type');
        messages.push('pap: WARNING: Authentication will fail unless a "known good" password is available');
      } else { result = 'updated'; if (authType === null) authType = 'PAP'; }
    }
    results.push(result);
    for (const message of messages) body.push(`      ${message}`);
    body.push(`    [${module}] = ${result}`);
  }
  if (user?.acceptAny === true) authType = 'Accept';
  const sectionResult = combine(results);
  inner(`# Executing section authorize${located(pipeline, 'authorize')}`, 1);
  inner('authorize {', 2);
  lines.push(...body.map((line) => `  ${line}`));
  inner(`} # authorize = ${sectionResult}`, 2);
  if (sectionResult !== 'reject' && sectionResult !== 'userlock') {
    if (authType === 'Accept') {
      inner('Found Auth-Type = Accept', 1);
      inner('Auth-Type = Accept, accepting the user', 1);
    } else if (authType === null) {
      inner('ERROR: No Auth-Type found: rejecting the user via Post-Auth-Type = Reject', 1);
      inner('Failed to authenticate the user', 1);
    } else {
      inner(`Found Auth-Type = ${authType}`, 1);
      const place = pipeline?.authTypes.get(authType);
      inner(`# Executing group from file ${place?.file ?? ''} line ${place?.line ?? 0}`.replace(' from file  line 0', ''), 1);
      inner(`Auth-Type ${authType} {`, 2);
      const module = authType === 'PAP' ? 'pap' : 'chap';
      if (authType === 'PAP') {
        inner('pap: Login attempt with password', 4);
        const name = user?.knownGoodName ?? 'Cleartext-Password';
        inner(name === 'Cleartext-Password' ? 'pap: Comparing with "known good" Cleartext-Password' : `pap: Comparing with "known-good" ${name}`, 4);
        if (input.accepted) inner('pap: User authenticated successfully', 4);
        else {
          inner(name === 'Cleartext-Password' ? 'pap: ERROR: Cleartext password does not match "known good" password' : `pap: ERROR: ${name} does not match "known good" digest`, 4);
          inner("pap: Passwords don't match", 4);
        }
      } else if (input.accepted) {
        inner('chap: Comparing with "known good" Cleartext-Password', 4);
        inner(`chap: CHAP user "${String(request.attributes.find((attribute) => attribute.type === 'user-name')?.value ?? '')}" authenticated successfully`, 4);
      } else {
        inner('chap: Comparing with "known good" Cleartext-Password', 4);
        inner('chap: ERROR: Password comparison failed: password is incorrect', 4);
      }
      inner(`[${module}] = ${input.accepted ? 'ok' : 'reject'}`, 3);
      inner(`} # Auth-Type ${authType} = ${input.accepted ? 'ok' : 'reject'}`, 2);
      if (!input.accepted) inner('Failed to authenticate the user', 1);
    }
  }
  lines.push(`} # server ${input.server}`, 'Virtual server sending reply', ...input.replyLines);
  return lines;
}
