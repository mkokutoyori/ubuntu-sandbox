import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslCb, SaslFeat, SaslProp, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract,
  type SaslOutParams, type SaslSecurityProperties, type StepOutcome,
} from './saslTypes';
import type { GssClientEnvironment } from '@/network/kerberos/gssapi/GssClientEnvironment';

const ERROR_STRINGS: Readonly<Record<number, string>> = {
  [SaslRc.CONTINUE]: 'another step is needed in authentication',
  [SaslRc.OK]: 'successful result',
  [SaslRc.FAIL]: 'generic failure',
  [SaslRc.NOMEM]: 'no memory available',
  [SaslRc.BUFOVER]: 'overflowed buffer',
  [SaslRc.NOMECH]: 'no mechanism available',
  [SaslRc.BADPROT]: 'bad protocol / cancel',
  [SaslRc.NOTDONE]: "can't request information until later in exchange",
  [SaslRc.BADPARAM]: 'invalid parameter supplied',
  [SaslRc.TRYAGAIN]: 'transient failure (e.g., weak key)',
  [SaslRc.BADMAC]: 'integrity check failed',
  [SaslRc.NOTINIT]: 'SASL library is not initialized',
  [SaslRc.INTERACT]: 'needs user interaction',
  [SaslRc.BADSERV]: 'server failed mutual authentication step',
  [SaslRc.WRONGMECH]: "mechanism doesn't support requested feature",
  [SaslRc.BADAUTH]: 'authentication failure',
  [SaslRc.NOAUTHZ]: 'authorization failure',
  [SaslRc.TOOWEAK]: 'mechanism too weak for this user',
  [SaslRc.ENCRYPT]: 'encryption needed to use mechanism',
  [SaslRc.TRANS]: 'One time use of a plaintext password will enable requested mechanism for user',
  [SaslRc.EXPIRED]: 'passphrase expired, has to be reset',
  [SaslRc.DISABLED]: 'account disabled',
  [SaslRc.NOUSER]: 'user not found',
  [SaslRc.BADVERS]: 'version mismatch with plug-in',
  [SaslRc.UNAVAIL]: 'remote authentication server unavailable',
  [SaslRc.NOVERIFY]: 'user exists, but no verifier for user',
  [SaslRc.PWLOCK]: 'passphrase locked',
  [SaslRc.NOCHANGE]: 'requested change was not needed',
  [SaslRc.WEAKPASS]: 'passphrase is too weak for security policy',
  [SaslRc.NOUSERPASS]: 'user supplied passwords are not permitted',
  [SaslRc.NEED_OLD_PASSWD]: 'sasl_setpass needs old password in order to perform password change',
  [SaslRc.CONSTRAINT_VIOLAT]: "sasl_setpass can't store a property because of a constraint violation",
  [SaslRc.BADBINDING]: 'channel binding failure',
  [SaslRc.CONFIGERR]: 'error when parsing configuration file',
};

export function saslErrstring(code: number): string {
  return ERROR_STRINGS[code] ?? 'undefined error!';
}

function saslUsererr(code: number): number {
  return code === SaslRc.NOVERIFY || code === SaslRc.NOUSER ? SaslRc.BADAUTH : code;
}

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const MECH_PLUS_SUFFIX = /-PLUS$/i;

function isEqualMech(wanted: string, mechName: string): boolean {
  return wanted.toLowerCase() === mechName.toLowerCase();
}

function mechCompare(a: ClientMechanism, b: ClientMechanism): number {
  const secDiff = a.securityFlags ^ b.securityFlags;
  const order = [
    SaslSec.NOANONYMOUS, SaslSec.NOPLAINTEXT, SaslSec.MUTUAL_AUTH, SaslSec.NOACTIVE,
    SaslSec.NODICTIONARY, SaslSec.FORWARD_SECRECY,
  ];
  for (const flag of order) {
    if ((secDiff & a.securityFlags & flag) !== 0) return 1;
    if ((secDiff & b.securityFlags & flag) !== 0) return -1;
  }
  const featuresDiff = a.features ^ b.features;
  if ((featuresDiff & a.features & SaslFeat.CHANNEL_BINDING) !== 0) return 1;
  if ((featuresDiff & b.features & SaslFeat.CHANNEL_BINDING) !== 0) return -1;
  if (a.maxSsf > b.maxSsf) return 1;
  if (a.maxSsf < b.maxSsf) return -1;
  const hashA = a.securityFlags >>> 16;
  const hashB = b.securityFlags >>> 16;
  if (hashA > hashB) return 1;
  if (hashA < hashB) return -1;
  return 0;
}

export function orderMechanisms(plugins: readonly ClientMechanism[]): ClientMechanism[] {
  const list: ClientMechanism[] = [];
  for (const plugin of plugins) {
    if (list.length === 0 || mechCompare(plugin, list[0]) >= 0) {
      list.unshift(plugin);
      continue;
    }
    let index = 0;
    while (index + 1 < list.length && mechCompare(plugin, list[index + 1]) <= 0) index++;
    list.splice(index + 1, 0, plugin);
  }
  return list;
}

export interface SaslHostEnvironment {
  plugins(): readonly ClientMechanism[];
  gss?(): GssClientEnvironment | null;
  hostname(): string;
  random(length: number): Uint8Array;
}

export interface SaslClientEnvironment {
  readonly plugins: readonly ClientMechanism[];
  readonly clientFqdn: string;
  readonly hostname: string;
  readonly random: (length: number) => Uint8Array;
  readonly gss?: GssClientEnvironment | null;
}

const CALLBACK_IDS = new Set<number>([
  SaslCb.GETREALM, SaslCb.USER, SaslCb.AUTHNAME, SaslCb.PASS, SaslCb.ECHOPROMPT, SaslCb.NOECHOPROMPT,
]);
const DEFAULT_PROMPTS: readonly number[] = [SaslCb.AUTHNAME, SaslCb.PASS];

function findPrompt(prompts: SaslInteract[] | null, id: number): SaslInteract | null {
  if (prompts === null) return null;
  for (const prompt of prompts) {
    if (prompt.id === SaslCb.LIST_END) break;
    if (prompt.id === id) return prompt;
  }
  return null;
}

export class SaslClientConn {
  props: SaslSecurityProperties = { minSsf: 0, maxSsf: 0, maxBufsize: 0, securityFlags: 0 };
  externalSsf = 0;
  externalAuthId: string | null = null;
  readonly oparams: SaslOutParams = {
    user: null, authid: null, mechSsf: 0, maxOutbuf: 0, done: false, encode: null, decode: null,
  };
  errorCode: number = SaslRc.OK;
  errorBuffer = '';
  readonly serverFqdn: string | null;
  private readonly mechList: ClientMechanism[];
  private mech: ClientMechanism | null = null;
  private session: ClientMechanismSession | null = null;
  private params: SaslClientParams | null = null;

  constructor(
    readonly service: string,
    serverFqdn: string | null,
    private readonly environment: SaslClientEnvironment,
  ) {
    this.serverFqdn = serverFqdn === null ? null : serverFqdn.toLowerCase();
    this.mechList = orderMechanisms(environment.plugins);
  }

  static create(
    service: string, serverFqdn: string | null, environment: SaslClientEnvironment,
  ): { rc: number; conn: SaslClientConn | null; error: string } {
    const conn = new SaslClientConn(service, serverFqdn, environment);
    if (conn.mechList.length === 0) {
      conn.seterror(SaslRc.NOMECH, 'No worthy mechs found');
      return { rc: SaslRc.NOMECH, conn: null, error: conn.errdetail() };
    }
    return { rc: SaslRc.OK, conn, error: '' };
  }

  seterror(code: number, message: string): void {
    this.errorCode = code;
    this.errorBuffer = message;
  }

  errdetail(): string {
    return `SASL(${saslUsererr(this.errorCode)}): ${saslErrstring(this.errorCode)}: ${this.errorBuffer}`;
  }

  setSecProps(props: SaslSecurityProperties): number {
    if (props.maxBufsize === 0 && props.minSsf !== 0) {
      this.seterror(SaslRc.TOOWEAK, 'Attempt to disable security layers (maxoutbuf == 0) with min_ssf > 0');
      return SaslRc.TOOWEAK;
    }
    this.props = { ...props };
    return SaslRc.OK;
  }

  setExternal(ssf: number, authId: string | null): void {
    this.externalSsf = ssf;
    this.externalAuthId = authId !== null && authId !== '' ? authId : null;
  }

  private getCallback(id: number): number {
    return CALLBACK_IDS.has(id) ? SaslRc.INTERACT : SaslRc.FAIL;
  }

  private haveAllPrompts(mech: ClientMechanism): boolean {
    for (const id of mech.requiredPrompts ?? DEFAULT_PROMPTS) {
      const result = this.getCallback(id);
      if (result !== SaslRc.OK && result !== SaslRc.INTERACT) return false;
    }
    return true;
  }

  private canonUser(user: string, flags: number): number {
    const isSpace = (character: string): boolean => /[ \t\n\v\f\r]/.test(character);
    let length = user.length;
    let begin = 0;
    while (begin < length && isSpace(user[begin])) begin++;
    length -= begin;
    while (length > 0 && isSpace(user[begin + length - 1])) length--;
    if (begin === length) {
      this.seterror(SaslRc.FAIL, 'All-whitespace username.');
      return SaslRc.FAIL;
    }
    const canonical = user.slice(begin, begin + length);
    if ((flags & SASL_CU_AUTHID) !== 0) this.oparams.authid = canonical;
    if ((flags & SASL_CU_AUTHZID) !== 0) this.oparams.user = canonical;
    return SaslRc.OK;
  }

  private newParams(): SaslClientParams {
    return {
      service: this.service,
      externalAuthId: this.externalAuthId,
      serverFqdn: this.serverFqdn,
      clientFqdn: this.environment.clientFqdn,
      hostname: this.environment.hostname,
      props: this.props,
      externalSsf: this.externalSsf,
      oparams: this.oparams,
      random: this.environment.random,
      gss: this.environment.gss ?? null,
      seterror: (message: string) => this.seterror(SaslRc.FAIL, message),
      canonUser: (user, flags) => this.canonUser(user, flags),
      getSimple: (id, required, prompts) => {
        const prompt = findPrompt(prompts, id);
        if (prompt !== null) {
          if (required && prompt.result === null) {
            this.seterror(SaslRc.FAIL, 'Unexpectedly missing a prompt result in _plug_get_simple');
            return { rc: SaslRc.BADPARAM, value: null };
          }
          return { rc: SaslRc.OK, value: prompt.result };
        }
        const callback = this.getCallback(id);
        if (callback === SaslRc.FAIL && !required) return { rc: SaslRc.OK, value: null };
        return { rc: callback, value: null };
      },
      getRealm: (prompts) => {
        const prompt = findPrompt(prompts, SaslCb.GETREALM);
        if (prompt !== null) {
          if (prompt.result === null) {
            this.seterror(SaslRc.FAIL, 'Unexpectedly missing a prompt result in _plug_get_realm');
            return { rc: SaslRc.BADPARAM, value: null };
          }
          return { rc: SaslRc.OK, value: utf8(prompt.result) };
        }
        return { rc: this.getCallback(SaslCb.GETREALM), value: null };
      },
      getPassword: (prompts) => {
        const prompt = findPrompt(prompts, SaslCb.PASS);
        if (prompt !== null) {
          if (prompt.result === null) {
            this.seterror(SaslRc.FAIL, 'Unexpectedly missing a prompt result in _plug_get_password');
            return { rc: SaslRc.BADPARAM, value: null };
          }
          return { rc: SaslRc.OK, value: prompt.result };
        }
        return { rc: this.getCallback(SaslCb.PASS), value: null };
      },
    };
  }

  async start(
    mechlist: string | null, prompts: SaslInteract[] | null,
  ): Promise<{ rc: number; mech: string | null; out: Uint8Array | null; prompts: SaslInteract[] | null }> {
    if (mechlist === null) {
      this.seterror(SaslRc.BADPARAM, 'Parameter error in cyrus-sasl-2.1.28/lib/client.c near line 727');
      return { rc: SaslRc.BADPARAM, mech: null, out: null, prompts: null };
    }
    if (prompts !== null && this.session !== null) {
      return this.dostep(null, prompts);
    }
    const minssf = this.props.minSsf < this.externalSsf ? 0 : this.props.minSsf - this.externalSsf;
    const names = mechlist.split(/[^A-Za-z0-9_-]+/).filter((name) => name !== '');
    if (names.length === 0) {
      this.seterror(SaslRc.NOMECH, '');
      return { rc: SaslRc.NOMECH, mech: null, out: null, prompts: null };
    }
    let best: ClientMechanism | null = null;
    for (const candidate of this.mechList) {
      if (best !== null) break;
      for (const name of names) {
        if (!isEqualMech(name, candidate.name)) continue;
        if (!this.haveAllPrompts(candidate)) break;
        if (minssf > candidate.maxSsf) break;
        let myflags = this.props.securityFlags;
        if (this.props.minSsf <= this.externalSsf && this.externalSsf > 1) myflags &= ~SaslSec.NOPLAINTEXT;
        if (((myflags ^ candidate.securityFlags) & myflags) !== 0) break;
        if ((candidate.features & SaslFeat.NEEDSERVERFQDN) !== 0 && this.serverFqdn === null) break;
        best = candidate;
        break;
      }
    }
    if (best === null) {
      this.seterror(SaslRc.NOMECH, 'No worthy mechs found');
      return { rc: SaslRc.NOMECH, mech: null, out: null, prompts: null };
    }
    this.mech = best;
    this.params = this.newParams();
    const created = best.create(this.params);
    if (typeof created === 'number') {
      this.session = null;
      this.errorCode = created;
      return { rc: created, mech: best.name, out: null, prompts: null };
    }
    this.session = created;
    const mechName = best.name;
    if ((best.features & SaslFeat.SERVER_FIRST) !== 0) {
      return { rc: SaslRc.CONTINUE, mech: mechName, out: null, prompts: null };
    }
    const stepped = await this.dostep(null, null);
    return { ...stepped, mech: mechName };
  }

  private async dostep(
    serverIn: Uint8Array | null, prompts: SaslInteract[] | null,
  ): Promise<{ rc: number; mech: string | null; out: Uint8Array | null; prompts: SaslInteract[] | null }> {
    const mechName = this.mech === null ? null : this.mech.name;
    if (this.session === null || this.params === null) {
      return { rc: SaslRc.BADPARAM, mech: mechName, out: null, prompts: null };
    }
    if (this.oparams.done) {
      this.seterror(SaslRc.FAIL, 'attempting client step after doneflag');
      return { rc: SaslRc.FAIL, mech: mechName, out: null, prompts: null };
    }
    const outcome: StepOutcome = await this.session.step(this.params, serverIn, prompts);
    if (outcome.rc === SaslRc.INTERACT && outcome.prompts !== undefined) {
      return { rc: SaslRc.INTERACT, mech: mechName, out: null, prompts: outcome.prompts };
    }
    let out = outcome.out ?? null;
    let rc: number = outcome.rc;
    if (rc === SaslRc.OK) {
      if (out === null) out = new Uint8Array(0);
      if (this.oparams.maxOutbuf === 0) this.oparams.maxOutbuf = this.props.maxBufsize;
      if (this.oparams.user === null || this.oparams.authid === null) {
        this.seterror(SaslRc.BADPROT, 'mech did not call canon_user for both authzid and authid');
        rc = SaslRc.BADPROT;
      }
    }
    if (rc !== SaslRc.CONTINUE && rc !== SaslRc.INTERACT) this.errorCode = rc;
    return { rc, mech: mechName, out, prompts: null };
  }

  async step(
    serverIn: Uint8Array | null, prompts: SaslInteract[] | null,
  ): Promise<{ rc: number; out: Uint8Array | null; prompts: SaslInteract[] | null }> {
    const stepped = await this.dostep(serverIn, prompts);
    return { rc: stepped.rc, out: stepped.out, prompts: stepped.prompts };
  }

  getProp(id: number): { rc: number; value: string | number | null } {
    switch (id) {
      case SaslProp.SSF: return { rc: SaslRc.OK, value: this.oparams.mechSsf };
      case SaslProp.MAXOUTBUF: return { rc: SaslRc.OK, value: this.oparams.maxOutbuf };
      case SaslProp.USERNAME:
        return this.oparams.user === null ? { rc: SaslRc.NOTDONE, value: null } : { rc: SaslRc.OK, value: this.oparams.user };
      case SaslProp.SERVERFQDN: return { rc: SaslRc.OK, value: this.serverFqdn };
      case SaslProp.SERVICE: return { rc: SaslRc.OK, value: this.service };
      case SaslProp.MECHNAME:
        return this.mech === null ? { rc: SaslRc.NOTDONE, value: null } : { rc: SaslRc.OK, value: this.mech.name };
      default: return { rc: SaslRc.BADPARAM, value: null };
    }
  }

  encode(data: Uint8Array): { rc: number; out: Uint8Array } {
    if (this.props.maxBufsize === 0) {
      this.seterror(SaslRc.TOOWEAK, 'called sasl_encode[v] with application that does not support security layers');
      return { rc: SaslRc.TOOWEAK, out: new Uint8Array(0) };
    }
    const encode = this.oparams.encode;
    if (encode === null) return { rc: SaslRc.OK, out: data };
    const chunks: Uint8Array[] = [];
    const limit = this.oparams.maxOutbuf;
    for (let offset = 0; offset < data.length; offset += limit) {
      const encoded = encode(data.subarray(offset, Math.min(data.length, offset + limit)));
      if (encoded.rc !== SaslRc.OK) {
        this.errorCode = encoded.rc;
        return { rc: encoded.rc, out: new Uint8Array(0) };
      }
      chunks.push(encoded.data);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      out.set(chunk, position);
      position += chunk.length;
    }
    return { rc: SaslRc.OK, out };
  }

  decode(data: Uint8Array): { rc: number; out: Uint8Array } {
    if (this.props.maxBufsize === 0) {
      this.seterror(SaslRc.TOOWEAK, 'called sasl_decode with application that does not support security layers');
      return { rc: SaslRc.TOOWEAK, out: new Uint8Array(0) };
    }
    const decode = this.oparams.decode;
    if (decode === null) {
      if (data.length > this.props.maxBufsize) {
        this.seterror(SaslRc.BUFOVER, 'input too large for default sasl_decode');
        return { rc: SaslRc.BUFOVER, out: new Uint8Array(0) };
      }
      return { rc: SaslRc.OK, out: data };
    }
    const decoded = decode(data);
    if (decoded.rc !== SaslRc.OK) this.errorCode = decoded.rc;
    return { rc: decoded.rc, out: decoded.data };
  }

  get mechanismName(): string | null {
    return this.mech === null ? null : this.mech.name;
  }
}

export function stripPlusSuffix(name: string): string {
  return name.replace(MECH_PLUS_SUFFIX, '');
}
