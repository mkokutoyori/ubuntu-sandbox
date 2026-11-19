import type { RadiusPacket, RadiusUser } from '@/network/radius/types';
import type { Pipeline, ProcessingSection } from './PipelineConfig';
import type { ModuleResult } from './Unlang';

export type { ModuleResult };

export interface ResolutionTrace {
  lines: string[];
  result: ModuleResult;
  authType: 'PAP' | 'CHAP' | 'Accept' | null;
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

const KNOWN_GOOD_NAMES: Record<string, string> = {
  'cleartext-password': 'Cleartext-Password', 'md5-password': 'MD5-Password', 'smd5-password': 'SMD5-Password',
  'sha-password': 'SHA-Password', 'ssha-password': 'SSHA-Password', 'sha2-password': 'SHA2-Password', 'nt-password': 'NT-Password',
  'crypt-password': 'Crypt-Password', 'password-with-header': 'Password-With-Header',
};

export function knownGoodDisplayName(itemName: string): string {
  return KNOWN_GOOD_NAMES[itemName.toLowerCase()] ?? itemName;
}

function located(pipeline: Pipeline | undefined, section: ProcessingSection): string {
  const place = pipeline?.locations.get(section);
  return place === undefined ? '' : ` from file ${place.file} line ${place.line}`;
}

export function requestDebugLines(input: DebugInput): string[] {
  const { request, user, pipeline } = input;
  const lines: string[] = [`Virtual server ${input.server} received request`, ...input.receivedLines, `server ${input.server} {`];
  const inner = (text: string, depth: number): void => { lines.push(`${'  '.repeat(depth)}${text}`); };
  const sectionResult = input.resolution?.result ?? 'noop';
  const authType = input.resolution?.authType ?? null;
  inner(`# Executing section authorize${located(pipeline, 'authorize')}`, 1);
  inner('authorize {', 2);
  lines.push(...(input.resolution?.lines ?? []));
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
