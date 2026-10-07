import type { GssClientEnvironment } from '@/network/kerberos/gssapi/GssClientEnvironment';

export const SaslRc = {
  CONTINUE: 1,
  OK: 0,
  FAIL: -1,
  NOMEM: -2,
  BUFOVER: -3,
  NOMECH: -4,
  BADPROT: -5,
  NOTDONE: -6,
  BADPARAM: -7,
  TRYAGAIN: -8,
  BADMAC: -9,
  NOTINIT: -12,
  INTERACT: 2,
  BADSERV: -10,
  WRONGMECH: -11,
  BADAUTH: -13,
  NOAUTHZ: -14,
  TOOWEAK: -15,
  ENCRYPT: -16,
  TRANS: -17,
  EXPIRED: -18,
  DISABLED: -19,
  NOUSER: -20,
  BADVERS: -23,
  UNAVAIL: -24,
  NOVERIFY: -26,
  PWLOCK: -21,
  NOCHANGE: -22,
  WEAKPASS: -27,
  NOUSERPASS: -28,
  NEED_OLD_PASSWD: -29,
  CONSTRAINT_VIOLAT: -30,
  BADBINDING: -32,
  CONFIGERR: -100,
} as const;

export const SaslCb = {
  LIST_END: 0,
  USER: 0x4001,
  AUTHNAME: 0x4002,
  LANGUAGE: 0x4003,
  PASS: 0x4004,
  ECHOPROMPT: 0x4005,
  NOECHOPROMPT: 0x4006,
  CNONCE: 0x4007,
  GETREALM: 0x4008,
} as const;

export const SaslSec = {
  NOPLAINTEXT: 0x0001,
  NOACTIVE: 0x0002,
  NODICTIONARY: 0x0004,
  FORWARD_SECRECY: 0x0008,
  NOANONYMOUS: 0x0010,
  PASS_CREDENTIALS: 0x0020,
  MUTUAL_AUTH: 0x0040,
} as const;

export const SaslFeat = {
  NEEDSERVERFQDN: 0x0001,
  WANT_CLIENT_FIRST: 0x0002,
  SERVER_FIRST: 0x0010,
  ALLOWS_PROXY: 0x0020,
  CHANNEL_BINDING: 0x0800,
  SUPPORTS_HTTP: 0x1000,
} as const;

export const SaslProp = {
  USERNAME: 0,
  SSF: 1,
  MAXOUTBUF: 2,
  SERVICE: 12,
  SERVERFQDN: 13,
  MECHNAME: 15,
  SSF_EXTERNAL: 100,
  SEC_PROPS: 101,
  AUTH_EXTERNAL: 102,
} as const;

export function hashStrengthBits(bits: number): number {
  return Math.floor(bits / 8) << 16;
}

export const SASL_MAX_BUFF_SIZE = 0xffffff;
export const SASL_MIN_BUFF_SIZE = 4096;
export const INT_MAX = 2147483647;

export interface SaslInteract {
  id: number;
  challenge: string | null;
  prompt: string | null;
  defresult: string | null;
  result: Uint8Array | null;
}

export interface SaslSecurityProperties {
  minSsf: number;
  maxSsf: number;
  maxBufsize: number;
  securityFlags: number;
}

export function defaultSecurityProperties(): SaslSecurityProperties {
  return {
    minSsf: 0,
    maxSsf: INT_MAX,
    maxBufsize: SASL_MAX_BUFF_SIZE,
    securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOANONYMOUS,
  };
}

export interface SaslLayerResult {
  readonly rc: number;
  readonly data: Uint8Array;
}

export type SaslLayerFunction = (data: Uint8Array) => SaslLayerResult;

export interface SaslOutParams {
  user: string | null;
  authid: string | null;
  mechSsf: number;
  maxOutbuf: number;
  done: boolean;
  encode: SaslLayerFunction | null;
  decode: SaslLayerFunction | null;
}

export interface StepOutcome {
  readonly rc: number;
  readonly out?: Uint8Array | null;
  readonly prompts?: SaslInteract[];
}

export interface SaslClientParams {
  readonly service: string;
  readonly externalAuthId: string | null;
  readonly serverFqdn: string | null;
  readonly clientFqdn: string;
  readonly hostname: string;
  readonly props: SaslSecurityProperties;
  readonly externalSsf: number;
  readonly oparams: SaslOutParams;
  readonly random: (length: number) => Uint8Array;
  readonly gss: GssClientEnvironment | null;
  seterror(message: string): void;
  canonUser(user: string, flags: number): number;
  getSimple(id: number, required: boolean, prompts: SaslInteract[] | null): { rc: number; value: Uint8Array | null };
  getPassword(prompts: SaslInteract[] | null): { rc: number; value: Uint8Array | null };
  getRealm(prompts: SaslInteract[] | null): { rc: number; value: string | null };
}

export interface ClientMechanismSession {
  step(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome | Promise<StepOutcome>;
}

export interface ClientMechanism {
  readonly name: string;
  readonly maxSsf: number;
  readonly securityFlags: number;
  readonly features: number;
  readonly requiredPrompts: readonly number[] | null;
  create(params: SaslClientParams): ClientMechanismSession | number;
}

export const SASL_CU_AUTHID = 0x01;
export const SASL_CU_AUTHZID = 0x02;
