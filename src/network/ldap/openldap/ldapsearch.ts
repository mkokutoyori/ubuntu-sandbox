import type { LdapControl, LdapMessage, PartialAttribute } from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { Getopt, GETOPT_END } from './getopt';
import { b64DecodeLength, b64Ntop, b64Pton } from './base64';
import {
  atoux, fromUtf8, isDigit, sscanfInt, startsWithIgnoreCase, strcasecmp, strtol, utf8,
} from './cRuntime';
import { LdapRc, ldapErr2String } from './ldapErrors';
import { LdifPut, type LdifPutType, ldifIsNotPrintable, ldifPut, LDIF_LINE_WIDTH, LDIF_LINE_WIDTH_MAX } from './ldif';
import { dnToUfn, dnToDomain, explodeDnWithoutTypes } from './ldapDn';
import { ldapUrlDesc2Str, ldapUrlParseListExt, LdapUrlParse, LdapUrlErr, LdapScope } from './ldapUrl';
import { LdapLog, LdapDebug } from './ldapLog';
import { ldapsearchUsage } from './ldapsearchUsage';
import { type ConfigHost, applyConfigOption, loadGlobalOptions, LdapDeref, LdapVersion } from './ldapOptions';
import {
  LdapSession, LdapMsg, LdapRes, LDAP_RES_ANY, type LdapTransport, type ParsedResult, type ResultBatch, type SessionClock,
} from './ldapSession';
import { putFilter, putVrFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilterString';
import * as C from './ldapControls';
import { traceControlParse } from './ldapControlTrace';
import { saslDefaults, saslInteract, type SaslTerminal } from './lutilSasl';
import { parseSecprops } from './sasl/saslSecprops';
import type { SaslHostEnvironment } from './sasl/saslClient';

export interface LdapToolHost extends ConfigHost {
  readonly transport: LdapTransport;
  readonly clock: SessionClock;
  readStdinLine(): string | null;
  readStdinCharacter(): string | null;
  readFile(path: string): { bytes: Uint8Array } | { error: string };
  fileMode(path: string): number | null;
  createTemporaryFile(template: string, bytes: Uint8Array): { path: string } | { error: string };
  localHostName(): string | null;
  localAddress(): string | null;
  readonly sasl: SaslHostEnvironment;
  lookupDomainHosts(domain: string): string | null;
}

export interface LdapToolResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly interleaved: string;
  readonly exitCode: number;
}

class ToolExit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

const PASSWORD_BUFFER_SIZE = 512;
const EXIT_FAILURE = 1;
const LDAP_MAXINT = 2147483647;
const AUTH_SIMPLE = 0x80;
const AUTH_SASL = 0xa3;
const BUFSIZ = 8192;
const SASL_AUTOMATIC = 0;
const SASL_INTERACTIVE = 1;
const SASL_QUIET = 2;

const OPTIONS = 'a:Ab:cE:F:l:Ls:S:tT:uz:Cd:D:e:f:H:IMnNO:o:P:QR:U:vVw:WxX:y:Y:Z';
const VERSION_BANNER = '@(#) $OpenLDAP: ldapsearch 2.5.18+dfsg-0ubuntu0.22.04.2 (Ubuntu) (Mar 20 2024 10:00:00) $\n\tbuildd@lcy02-amd64-017:/build/openldap-3Mw0k2/openldap-2.5.18+dfsg/debian/build/clients/tools\n';
const LIBRARY_VENDOR = 'OpenLDAP';
const LIBRARY_VERSION = 20518;

type Intr = 0 | 1 | 2 | 3;

export async function runLdapsearch(argv: readonly string[], host: LdapToolHost): Promise<LdapToolResult> {
  const tool = new LdapSearchTool(argv, host);
  const status = await tool.main();
  return { stdout: tool.stdoutText, stderr: tool.stderrText, interleaved: tool.interleavedText, exitCode: status & 0xff };
}

function longOf(text: string): { value: number; ok: boolean } {
  const parsed = strtol(text);
  return { value: parsed.value, ok: parsed.rest === '' };
}

function entryAttributes(message: LdapMessage): { name: string; values: Uint8Array[] }[] {
  const op = message.protocolOp;
  if (op.kind !== 'searchResultEntry') return [];
  return op.attributes.map((attribute: PartialAttribute) => ({
    name: attribute.type,
    values: attribute.valueBytes ?? attribute.values.map(utf8),
  }));
}

class LdapSearchTool {
  stdoutText = '';
  stderrText = '';
  interleavedText = '';

  private prog = 'ldapsearch';
  private argvOptionsEnd = 0;

  private contoper = 0;
  private debug = 0;
  private log: LdapLog = new LdapLog((text) => this.fprintfStderr(text));
  private infile: string | null = null;
  private infileLines: string[] | null = null;
  private dont = 0;
  private nocanon = 0;
  private referrals = 0;
  private verbose = 0;
  private ldif = 0;
  private ldifWrap = 0;
  private ldapuri: string | null = null;
  private useTls = 0;
  private protocol = -1;
  private version = 0;
  private authmethod = -1;
  private binddn: string | null = null;
  private wantBindpw = 0;
  private passwd: Uint8Array | null = null;
  private pwFile: string | null = null;
  private saslFlags = SASL_AUTOMATIC;
  private saslRealm: string | null = null;
  private saslAuthcId: string | null = null;
  private saslAuthzId: string | null = null;
  private saslMech: string | null = null;
  private saslSecprops: string | null = null;
  private assertctl = 0;
  private assertion: string | null = null;
  private authzid: string | null = null;
  private authzcrit = 1;
  private proxydn: string | null = null;
  private manageDIT = 0;
  private manageDSAit = 0;
  private noop = 0;
  private ppolicy = 0;
  private preread = 0;
  private prereadAttrs: string | null = null;
  private postread = 0;
  private postreadAttrs: string | null = null;
  private morePagedResults = 1;
  private prCookie: Uint8Array = new Uint8Array(0);
  private chaining = 0;
  private chainingResolve = -1;
  private chainingContinuation = -1;
  private sessionTracking = 0;
  private sessionTrackingName: string | null = null;
  private stValue: Uint8Array | null = null;
  private vlvPos = 0;
  private vlvCount = 0;
  private vlvContext: Uint8Array | null = null;
  private bauthzid = 0;
  private unknownControls: LdapControl[] = [];
  private nettimeout = -1;
  private gotintr: Intr = 0;
  private abcan: Intr = 0;
  private backlog = 0;

  private scope: number = LdapScope.SUBTREE;
  private deref = -1;
  private attrsonly = 0;
  private timelimit = -1;
  private sizelimit = -1;
  private defTmpdir = '/tmp';
  private defUrlpre = '';
  private tmpdir: string | null = null;
  private urlpre: string | null = null;
  private base: string | null = null;
  private sortattr: string | null = null;
  private includeufn = 0;
  private vals2tmp = 0;
  private subentries = 0;
  private valuesReturnFilter = 0;
  private vrFilter: string | null = null;
  private accountUsability = 0;
  private dontUseCopy = 0;
  private domainScope = 0;
  private sss = 0;
  private sssKeys: C.SortKey[] | null = null;
  private vlv = 0;
  private vlvInfo: C.VlvInfo = { beforeCount: 0, afterCount: 0, offset: 0, count: 0, attrValue: null, context: null };
  private ldapsync = 0;
  private syncCookie: Uint8Array | null = null;
  private syncSlimit = -1;
  private psearch = 0;
  private psChgtypes = 0;
  private psChgsonly = 0;
  private psEchgCtrls = 0;
  private pagedResults = 0;
  private pagePrompt = 1;
  private pageSize = 0;
  private entriesLeft = 0;
  private npagedresponses = 0;
  private npagedentries = 0;
  private npagedreferences = 0;
  private npagedextended = 0;
  private npagedpartial = 0;
  private genericControls: LdapControl[] = [];
  private derefcrit = 0;
  private derefSpecs: C.DerefSpec[] | null = null;
  private dirSync = 0;
  private dirSyncFlags = 0;
  private dirSyncMaxAttrCount = 0;
  private dirSyncCookie: Uint8Array = new Uint8Array(0);
  private extendedDn = 0;
  private extendedDnFlag = 0;
  private showDeleted = 0;
  private serverNotif = 0;

  private session: LdapSession | null = null;
  private operands: string[] = [];
  private globalOptions!: ReturnType<typeof loadGlobalOptions>;

  constructor(private readonly argv: readonly string[], private readonly host: LdapToolHost) {}

  private printf(text: string): void {
    this.stdoutText += text;
    this.interleavedText += text;
  }

  private fprintfStderr(text: string): void {
    this.stderrText += text;
    this.interleavedText += text;
  }

  private exit(status: number): never {
    throw new ToolExit(status);
  }

  private usage(): never {
    this.fprintfStderr(ldapsearchUsage(this.prog, this.defUrlpre, this.defTmpdir));
    this.exit(EXIT_FAILURE);
  }

  private err2string(code: number): string {
    this.log.debug(LdapDebug.TRACE, 'ldap_err2string\n');
    return ldapErr2String(code);
  }

  private toolPerror(
    func: string, err: number, extra: string | null, matched: string | null,
    info: string | null, refs: readonly string[] | null,
  ): void {
    this.fprintfStderr(`${func}: ${this.err2string(err)} (${err})${extra ?? ''}\n`);
    if (matched !== null && matched !== '') this.fprintfStderr(`\tmatched DN: ${matched}\n`);
    if (info !== null && info !== '') this.fprintfStderr(`\tadditional info: ${info}\n`);
    if (refs !== null && refs.length > 0) {
      this.fprintfStderr('\treferrals:\n');
      for (const ref of refs) this.fprintfStderr(`\t\t${ref}\n`);
    }
  }

  private toolWriteLdif(type: LdifPutType, name: string | null, value: Uint8Array | null): void {
    this.printf(ldifPut(type, name, value, this.ldifWrap));
  }

  private toolUnbind(): void {
    const session = this.session;
    if (session === null) return;
    session.serverControls = null;
    session.unbind();
  }

  private toolExit(status: number): never {
    this.toolUnbind();
    this.exit(status);
  }

  private toolIsOid(text: string): boolean {
    if (!isDigit(text[0])) return false;
    let first = true;
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === '.') {
        if (i + 1 >= text.length) return false;
        first = true;
        continue;
      }
      if (!isDigit(character)) return false;
      if (first && character === '0' && text[i + 1] !== '.') return false;
      first = false;
    }
    return true;
  }

  async main(): Promise<number> {
    try {
      return await this.run();
    } catch (error) {
      if (error instanceof ToolExit) return error.status;
      throw error;
    }
  }

  private async run(): Promise<number> {
    const slash = (this.argv[0] ?? 'ldapsearch').lastIndexOf('/');
    this.prog = slash >= 0 ? this.argv[0].slice(slash + 1) : (this.argv[0] ?? 'ldapsearch');
    const environmentTmp = this.host.environment('TMPDIR') ?? this.host.environment('TMP') ?? this.host.environment('TEMP');
    this.defTmpdir = environmentTmp === null || environmentTmp === '' ? '/tmp' : environmentTmp;
    this.defUrlpre = `file:///${this.defTmpdir.startsWith('/') ? this.defTmpdir.slice(1) : this.defTmpdir}/`;

    this.globalOptions = loadGlobalOptions(this.host);
    this.toolArgs();

    if (this.vlv && !this.sss) {
      this.fprintfStderr('VLV control requires server side sort control\n');
      return EXIT_FAILURE;
    }

    const operands = this.operands;
    let filtpattern: string;
    let attrs: string[] | null = null;
    let at = 0;
    if (operands.length < 1 || (!operands[0].startsWith('(') && !operands[0].includes('='))) {
      filtpattern = '(objectclass=*)';
    } else {
      filtpattern = operands[at++];
    }
    if (at < operands.length) attrs = operands.slice(at);

    if (this.infile !== null) {
      let percent = 0;
      if (this.openInfile() === null) return EXIT_FAILURE;
      for (let i = 0; i < filtpattern.length; i++) {
        if (filtpattern[i] === '%') {
          if (percent) {
            this.fprintfStderr(`Bad filter pattern "${filtpattern}"\n`);
            return EXIT_FAILURE;
          }
          percent++;
          if (filtpattern[i + 1] !== 's') {
            this.fprintfStderr(`Bad filter pattern "${filtpattern}"\n`);
            return EXIT_FAILURE;
          }
        }
      }
    }

    if (this.tmpdir === null) {
      this.tmpdir = this.defTmpdir;
      if (this.urlpre === null) this.urlpre = this.defUrlpre;
    }
    if (this.urlpre === null) {
      this.urlpre = `file:///${this.tmpdir.startsWith('/') ? this.tmpdir.slice(1) : this.tmpdir}/`;
    }

    const session = await this.toolConnSetup(false);
    this.session = session;
    await this.toolBind(session);
    return await this.searchPages(session, filtpattern, attrs);
  }

  private openInfile(): string[] | null {
    if (this.infile === '-') {
      if (this.infileLines === null) {
        const lines: string[] = [];
        for (let line = this.host.readStdinLine(); line !== null; line = this.host.readStdinLine()) lines.push(`${line}\n`);
        this.infileLines = lines;
      }
      return this.infileLines;
    }
    if (this.infileLines !== null) return this.infileLines;
    const read = this.host.readFile(this.infile as string);
    if ('error' in read) {
      this.fprintfStderr(`${this.infile}: ${read.error}\n`);
      return null;
    }
    const text = fromUtf8(read.bytes);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) {
        if (start < text.length) lines.push(text.slice(start));
        break;
      }
      lines.push(text.slice(start, newline + 1));
      start = newline + 1;
    }
    this.infileLines = lines;
    return lines;
  }

  private parseVlv(cvalue: string): boolean {
    const invalid = (): boolean => {
      this.fprintfStderr(`VLV control value "${cvalue}" invalid\n`);
      return true;
    };
    const first = /^\s*([+-]?\d+)\/([+-]?\d+)/.exec(cvalue);
    if (first === null) return invalid();
    this.vlvInfo.beforeCount = Number.parseInt(first[1], 10);
    this.vlvInfo.afterCount = Number.parseInt(first[2], 10);
    let keyp = cvalue.slice(cvalue.indexOf('/') + 1);
    const key2 = keyp.indexOf('/');
    if (key2 >= 0) {
      keyp = keyp.slice(key2 + 1);
      const second = /^\s*([+-]?\d+)\/([+-]?\d+)/.exec(keyp);
      if (second === null) return invalid();
      this.vlvInfo.offset = Number.parseInt(second[1], 10);
      this.vlvInfo.count = Number.parseInt(second[2], 10);
      this.vlvInfo.attrValue = null;
    } else {
      const colon = keyp.indexOf(':');
      if (colon < 0) return invalid();
      this.vlvInfo.attrValue = keyp.slice(colon + 1);
    }
    return false;
  }

  private toolArgs(): void {
    const getopt = new Getopt(this.argv, OPTIONS, message => this.fprintfStderr(`${message}\n`));
    for (;;) {
      const next = getopt.next();
      if (next === GETOPT_END) break;
      const option = next.option as string;
      const optarg = next.argument as string;
      switch (option) {
        case 'c': this.contoper++; break;
        case 'C': this.referrals++; break;
        case 'd': {
          const parsed = longOf(optarg);
          if (!parsed.ok) {
            this.fprintfStderr(`${this.prog}: unable to parse debug value "${optarg}"\n`);
            this.exit(EXIT_FAILURE);
          }
          this.debug |= parsed.value;
          break;
        }
        case 'D':
          if (this.binddn !== null) {
            this.fprintfStderr(`${this.prog}: -D previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.binddn = optarg;
          break;
        case 'e': this.handleGeneralExtension(optarg); break;
        case 'f':
          if (this.infile !== null) {
            this.fprintfStderr(`${this.prog}: -f previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.infile = optarg;
          break;
        case 'H':
          if (this.ldapuri !== null) {
            this.fprintfStderr(`${this.prog}: -H previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.ldapuri = optarg;
          break;
        case 'I':
          if (this.authmethod !== -1 && this.authmethod !== AUTH_SASL) {
            this.fprintfStderr(`${this.prog}: incompatible previous authentication choice\n`);
            this.exit(EXIT_FAILURE);
          }
          this.authmethod = AUTH_SASL;
          this.saslFlags = SASL_INTERACTIVE;
          break;
        case 'M': this.manageDSAit++; break;
        case 'n': this.dont++; break;
        case 'N': this.nocanon++; break;
        case 'o': this.handleLibraryOption(optarg); break;
        case 'O':
          if (this.saslSecprops !== null) {
            this.fprintfStderr(`${this.prog}: -O previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.requireSaslChoice('incompatible previous authentication choice');
          this.authmethod = AUTH_SASL;
          this.saslSecprops = optarg;
          break;
        case 'P': this.handleProtocolVersion(optarg); break;
        case 'Q':
          this.requireSaslChoice('incompatible previous authentication choice');
          this.authmethod = AUTH_SASL;
          this.saslFlags = SASL_QUIET;
          break;
        case 'R':
          if (this.saslRealm !== null) {
            this.fprintfStderr(`${this.prog}: -R previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.requireSaslChoice('incompatible previous authentication choice');
          this.authmethod = AUTH_SASL;
          this.saslRealm = optarg;
          break;
        case 'U':
          if (this.saslAuthcId !== null) {
            this.fprintfStderr(`${this.prog}: -U previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          this.requireSaslChoice('incompatible previous authentication choice');
          this.authmethod = AUTH_SASL;
          this.saslAuthcId = optarg;
          break;
        case 'v': this.verbose++; break;
        case 'V': this.version++; break;
        case 'w': this.passwd = utf8(optarg); break;
        case 'W': this.wantBindpw++; break;
        case 'y': this.pwFile = optarg; break;
        case 'Y':
          if (this.saslMech !== null) {
            this.fprintfStderr(`${this.prog}: -Y previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          if (this.authmethod !== -1 && this.authmethod !== AUTH_SASL) {
            this.fprintfStderr(`${this.prog}: incompatible with authentication choice\n`);
            this.exit(EXIT_FAILURE);
          }
          this.authmethod = AUTH_SASL;
          this.saslMech = optarg;
          break;
        case 'x':
          if (this.authmethod !== -1 && this.authmethod !== AUTH_SIMPLE) {
            this.fprintfStderr(`${this.prog}: incompatible with previous authentication choice\n`);
            this.exit(EXIT_FAILURE);
          }
          this.authmethod = AUTH_SIMPLE;
          break;
        case 'X':
          if (this.saslAuthzId !== null) {
            this.fprintfStderr(`${this.prog}: -X previously specified\n`);
            this.exit(EXIT_FAILURE);
          }
          if (this.authmethod !== -1 && this.authmethod !== AUTH_SASL) {
            this.fprintfStderr(`${this.prog}: -X incompatible with authentication choice\n`);
            this.exit(EXIT_FAILURE);
          }
          this.authmethod = AUTH_SASL;
          this.saslAuthzId = optarg;
          break;
        case 'Z': this.useTls++; break;
        default:
          if (this.handlePrivateOption(option, optarg)) break;
          this.fprintfStderr(`${this.prog}: unrecognized option -${getopt.optionCharacter}\n`);
          this.usage();
      }
    }
    this.operands = getopt.operands();

    if (this.version) {
      this.fprintfStderr(`${this.prog}: ${VERSION_BANNER}\t(LDAP library: ${LIBRARY_VENDOR} ${LIBRARY_VERSION})\n`);
      if (this.version > 1) this.exit(0);
    }

    if (this.protocol === -1) this.protocol = LdapVersion.V3;
    if (this.authmethod === -1 && this.protocol > LdapVersion.V2) {
      this.authmethod = this.binddn !== null ? AUTH_SIMPLE : AUTH_SASL;
    }
    if (this.protocol === LdapVersion.V2) {
      if (this.assertctl || this.authzid !== null || this.manageDIT || this.manageDSAit
        || this.proxydn !== null || this.chaining || this.sessionTracking
        || this.noop || this.ppolicy || this.preread || this.postread) {
        this.fprintfStderr(`${this.prog}: -e/-M incompatible with LDAPv2\n`);
        this.exit(EXIT_FAILURE);
      }
      if (this.useTls) {
        this.fprintfStderr(`${this.prog}: -Z incompatible with LDAPv2\n`);
        this.exit(EXIT_FAILURE);
      }
      if (this.authmethod === AUTH_SASL) {
        this.fprintfStderr(`${this.prog}: -[IOQRUXY] incompatible with LDAPv2\n`);
        this.exit(EXIT_FAILURE);
      }
    }
    if ((this.pwFile !== null || this.wantBindpw) && this.passwd !== null) {
      this.fprintfStderr(`${this.prog}: -${this.pwFile !== null ? 'y' : 'W'} incompatible with -w\n`);
      this.exit(EXIT_FAILURE);
    }
  }

  private requireSaslChoice(message: string): void {
    if (this.authmethod !== -1 && this.authmethod !== AUTH_SASL) {
      this.fprintfStderr(`${this.prog}: ${message}\n`);
      this.exit(EXIT_FAILURE);
    }
  }

  private handleProtocolVersion(optarg: string): void {
    const parsed = longOf(optarg);
    if (!parsed.ok) {
      this.fprintfStderr(`${this.prog}: unable to parse protocol version "${optarg}"\n`);
      this.exit(EXIT_FAILURE);
    }
    switch (parsed.value) {
      case 2:
        if (this.protocol === LdapVersion.V3) {
          this.fprintfStderr(`${this.prog}: -P 2 incompatible with version ${this.protocol}\n`);
          this.exit(EXIT_FAILURE);
        }
        this.protocol = LdapVersion.V2;
        break;
      case 3:
        if (this.protocol === LdapVersion.V2) {
          this.fprintfStderr(`${this.prog}: -P 2 incompatible with version ${this.protocol}\n`);
          this.exit(EXIT_FAILURE);
        }
        this.protocol = LdapVersion.V3;
        break;
      default:
        this.fprintfStderr(`${this.prog}: protocol version should be 2 or 3\n`);
        this.usage();
    }
  }

  private handleLibraryOption(optarg: string): void {
    let control = optarg;
    let cvalue: string | null = null;
    const equals = control.indexOf('=');
    if (equals >= 0) {
      cvalue = control.slice(equals + 1);
      control = control.slice(0, equals);
    }
    control = control.replace(/-/g, '_');
    if (strcasecmp(control, 'nettimeout') === 0) {
      if (this.nettimeout !== -1) {
        this.fprintfStderr('nettimeout option previously specified\n');
        this.exit(EXIT_FAILURE);
      }
      if (cvalue === null || cvalue === '') {
        this.fprintfStderr('nettimeout: option value expected\n');
        this.usage();
      }
      if (strcasecmp(cvalue, 'none') === 0) {
        this.nettimeout = 0;
      } else if (strcasecmp(cvalue, 'max') === 0) {
        this.nettimeout = LDAP_MAXINT;
      } else {
        const parsed = longOf(cvalue);
        if (!parsed.ok) {
          this.fprintfStderr(`Unable to parse network timeout "${cvalue}"\n`);
          this.exit(EXIT_FAILURE);
        }
        this.nettimeout = parsed.value;
      }
      if (this.nettimeout < 0 || this.nettimeout > LDAP_MAXINT) {
        this.fprintfStderr(`${this.prog}: invalid network timeout (${this.nettimeout}) specified\n`);
        this.exit(EXIT_FAILURE);
      }
    } else if (strcasecmp(control, 'ldif_wrap') === 0) {
      if (cvalue === null) {
        this.ldifWrap = LDIF_LINE_WIDTH;
      } else if (strcasecmp(cvalue, 'no') === 0) {
        this.ldifWrap = LDIF_LINE_WIDTH_MAX;
      } else {
        const value = atoux(cvalue);
        if (value === null) {
          this.fprintfStderr(`Unable to parse ldif_wrap="${cvalue}"\n`);
          this.exit(EXIT_FAILURE);
        }
        this.ldifWrap = value;
      }
    } else if (!applyConfigOption(this.globalOptions, control, cvalue ?? '', 'userconf') || cvalue === null) {
      this.fprintfStderr(`Invalid general option name: ${control}\n`);
      this.usage();
    }
  }

  private noValueExpected(name: string, cvalue: string | null): void {
    if (cvalue !== null) {
      this.fprintfStderr(`${name}: no control value expected\n`);
      this.usage();
    }
  }

  private previouslySpecified(flag: number | string | null, label: string): void {
    if (flag) {
      this.fprintfStderr(`${label} control previously specified\n`);
      this.exit(EXIT_FAILURE);
    }
  }

  private handleGeneralExtension(optarg: string): void {
    let crit = 0;
    let argument = optarg;
    while (argument[0] === '!') {
      crit++;
      argument = argument.slice(1);
    }
    let control = argument;
    let cvalue: string | null = null;
    const equals = control.indexOf('=');
    if (equals >= 0) {
      cvalue = control.slice(equals + 1);
      control = control.slice(0, equals);
    }
    const is = (name: string): boolean => strcasecmp(control, name) === 0;

    if (is('assert')) {
      this.previouslySpecified(this.assertctl, 'assert');
      if (cvalue === null) {
        this.fprintfStderr('assert: control value expected\n');
        this.usage();
      }
      this.assertctl = 1 + crit;
      this.assertion = cvalue;
    } else if (is('authzid')) {
      if (this.authzid !== null) {
        this.fprintfStderr('authzid control previously specified\n');
        this.exit(EXIT_FAILURE);
      }
      if (this.proxydn !== null) {
        this.fprintfStderr('authzid control incompatible with proxydn\n');
        this.exit(EXIT_FAILURE);
      }
      if (cvalue === null) {
        this.fprintfStderr('authzid: control value expected\n');
        this.usage();
      }
      if (!crit) {
        this.fprintfStderr('authzid: must be marked critical\n');
        this.usage();
      } else if (crit > 1) {
        this.authzcrit = 0;
      }
      this.authzid = cvalue;
    } else if (is('proxydn')) {
      if (this.proxydn !== null) {
        this.fprintfStderr('proxydn control previously specified\n');
        this.exit(EXIT_FAILURE);
      }
      if (this.authzid !== null) {
        this.fprintfStderr('proxydn control incompatible with authzid\n');
        this.exit(EXIT_FAILURE);
      }
      if (cvalue === null) {
        this.fprintfStderr('proxydn: control value expected\n');
        this.usage();
      }
      if (!crit) {
        this.fprintfStderr('proxydn: must be marked critical\n');
        this.usage();
      } else if (crit > 1) {
        this.authzcrit = 0;
      }
      this.proxydn = cvalue;
    } else if (is('bauthzid')) {
      this.previouslySpecified(this.bauthzid, 'bauthzid');
      if (cvalue !== null) {
        this.fprintfStderr('bauthzid: no control value expected\n');
        this.usage();
      }
      this.bauthzid = 1 + crit;
    } else if (is('relax') || is('manageDIT')) {
      this.previouslySpecified(this.manageDIT, 'relax');
      if (cvalue !== null) {
        this.fprintfStderr('relax: no control value expected\n');
        this.usage();
      }
      this.manageDIT = 1 + crit;
    } else if (is('manageDSAit')) {
      this.previouslySpecified(this.manageDSAit, 'manageDSAit');
      if (cvalue !== null) {
        this.fprintfStderr('manageDSAit: no control value expected\n');
        this.usage();
      }
      this.manageDSAit = 1 + crit;
    } else if (is('noop')) {
      this.previouslySpecified(this.noop, 'noop');
      if (cvalue !== null) {
        this.fprintfStderr('noop: no control value expected\n');
        this.usage();
      }
      this.noop = 1 + crit;
    } else if (is('ppolicy')) {
      this.previouslySpecified(this.ppolicy, 'ppolicy');
      if (cvalue !== null) {
        this.fprintfStderr('ppolicy: no control value expected\n');
        this.usage();
      }
      if (crit) {
        this.fprintfStderr('ppolicy: critical flag not allowed\n');
        this.usage();
      }
      this.ppolicy = 1;
    } else if (is('preread')) {
      this.previouslySpecified(this.preread, 'preread');
      this.preread = 1 + crit;
      this.prereadAttrs = cvalue;
    } else if (is('postread')) {
      this.previouslySpecified(this.postread, 'postread');
      this.postread = 1 + crit;
      this.postreadAttrs = cvalue;
    } else if (is('chaining')) {
      if (this.chaining) {
        this.fprintfStderr('chaining control previously specified\n');
        this.exit(EXIT_FAILURE);
      }
      this.chaining = 1 + crit;
      if (cvalue !== null) {
        let resolveValue = cvalue;
        const slash = cvalue.indexOf('/');
        const behavior = (text: string): number => {
          switch (text.toLowerCase()) {
            case 'chainingpreferred': return C.ChainingBehavior.PREFERRED;
            case 'chainingrequired': return C.ChainingBehavior.REQUIRED;
            case 'referralspreferred': return C.ChainingBehavior.REFERRALS_PREFERRED;
            case 'referralsrequired': return C.ChainingBehavior.REFERRALS_REQUIRED;
            default: return -1;
          }
        };
        if (slash >= 0) {
          const continuation = cvalue.slice(slash + 1);
          resolveValue = cvalue.slice(0, slash);
          const parsed = behavior(continuation);
          if (parsed < 0) {
            this.fprintfStderr(`chaining behavior control continuation value "${continuation}" invalid\n`);
            this.exit(EXIT_FAILURE);
          }
          this.chainingContinuation = parsed;
        }
        const resolved = behavior(resolveValue);
        if (resolved < 0) {
          this.fprintfStderr(`chaining behavior control resolve value "${resolveValue}" invalid\n`);
          this.exit(EXIT_FAILURE);
        }
        this.chainingResolve = resolved;
      }
    } else if (is('sessiontracking')) {
      if (this.sessionTracking) {
        this.fprintfStderr(`${this.prog}: session tracking can be only specified once\n`);
        this.exit(EXIT_FAILURE);
      }
      this.sessionTracking = 1;
      if (crit) {
        this.fprintfStderr('sessiontracking: critical flag not allowed\n');
        this.usage();
      }
      if (cvalue !== null) this.sessionTrackingName = cvalue;
    } else if (is('abandon')) {
      this.abcan = 1;
      if (crit) this.gotintr = this.abcan;
    } else if (is('cancel')) {
      this.abcan = 2;
      if (crit) this.gotintr = this.abcan;
    } else if (is('ignore')) {
      this.abcan = 3;
      if (crit) this.gotintr = this.abcan;
    } else if (is('backlog')) {
      this.backlog = 1;
    } else if (this.toolIsOid(control)) {
      if (this.unknownControls.some(existing => existing.controlType === control)) {
        this.fprintfStderr(`${control} control previously specified\n`);
        this.exit(EXIT_FAILURE);
      }
      let value: Uint8Array | undefined;
      if (cvalue !== null) {
        const decoded = b64Pton(cvalue, b64DecodeLength(cvalue.length));
        if (decoded === null) {
          this.fprintfStderr(`Unable to parse value of general control ${control}\n`);
          this.usage();
        }
        value = decoded;
      }
      this.unknownControls.push({ controlType: control, criticality: crit > 0, controlValue: value });
    } else {
      this.fprintfStderr(`Invalid general control name: ${control}\n`);
      this.usage();
    }
  }

  private handlePrivateOption(option: string, optarg: string): boolean {
    switch (option) {
      case 'a':
        if (strcasecmp(optarg, 'never') === 0) this.deref = LdapDeref.NEVER;
        else if (startsWithIgnoreCase(optarg, 'search')) this.deref = LdapDeref.SEARCHING;
        else if (startsWithIgnoreCase(optarg, 'find')) this.deref = LdapDeref.FINDING;
        else if (strcasecmp(optarg, 'always') === 0) this.deref = LdapDeref.ALWAYS;
        else {
          this.fprintfStderr('alias deref should be never, search, find, or always\n');
          this.usage();
        }
        return true;
      case 'A': this.attrsonly++; return true;
      case 'b': this.base = optarg; return true;
      case 'E': this.handleSearchExtension(optarg); return true;
      case 'F': this.urlpre = optarg; return true;
      case 'l': {
        if (strcasecmp(optarg, 'none') === 0) {
          this.timelimit = 0;
        } else if (strcasecmp(optarg, 'max') === 0) {
          this.timelimit = LDAP_MAXINT;
        } else {
          const parsed = longOf(optarg);
          if (!parsed.ok) {
            this.fprintfStderr(`Unable to parse time limit "${optarg}"\n`);
            this.exit(EXIT_FAILURE);
          }
          this.timelimit = parsed.value;
        }
        if (this.timelimit < 0 || this.timelimit > LDAP_MAXINT) {
          this.fprintfStderr(`${this.prog}: invalid timelimit (${this.timelimit}) specified\n`);
          this.exit(EXIT_FAILURE);
        }
        return true;
      }
      case 'L': this.ldif++; return true;
      case 's':
        if (startsWithIgnoreCase(optarg, 'base')) this.scope = LdapScope.BASE;
        else if (startsWithIgnoreCase(optarg, 'one')) this.scope = LdapScope.ONELEVEL;
        else if (strcasecmp(optarg, 'subordinate') === 0 || strcasecmp(optarg, 'children') === 0) this.scope = LdapScope.SUBORDINATE;
        else if (startsWithIgnoreCase(optarg, 'sub')) this.scope = LdapScope.SUBTREE;
        else {
          this.fprintfStderr('scope should be base, one, or sub\n');
          this.usage();
        }
        return true;
      case 'S': this.sortattr = optarg; return true;
      case 't': this.vals2tmp++; return true;
      case 'T': this.tmpdir = optarg; return true;
      case 'u': this.includeufn++; return true;
      case 'z': {
        if (strcasecmp(optarg, 'none') === 0) {
          this.sizelimit = 0;
        } else if (strcasecmp(optarg, 'max') === 0) {
          this.sizelimit = LDAP_MAXINT;
        } else {
          const parsed = longOf(optarg);
          if (!parsed.ok) {
            this.fprintfStderr(`Unable to parse size limit "${optarg}"\n`);
            this.exit(EXIT_FAILURE);
          }
          this.sizelimit = parsed.value;
        }
        if (this.sizelimit < 0 || this.sizelimit > LDAP_MAXINT) {
          this.fprintfStderr(`${this.prog}: invalid sizelimit (${this.sizelimit}) specified\n`);
          this.exit(EXIT_FAILURE);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private handleSearchExtension(optarg: string): void {
    if (this.protocol === LdapVersion.V2) {
      this.fprintfStderr(`${this.prog}: -E incompatible with LDAPv${this.protocol}\n`);
      this.exit(EXIT_FAILURE);
    }
    let crit = 0;
    let argument = optarg;
    while (argument[0] === '!') {
      crit++;
      argument = argument.slice(1);
    }
    let control = argument;
    let cvalue: string | null = null;
    const equals = control.indexOf('=');
    if (equals >= 0) {
      cvalue = control.slice(equals + 1);
      control = control.slice(0, equals);
    }
    const is = (name: string): boolean => strcasecmp(control, name) === 0;
    const previously = (flag: number, label: string): void => {
      if (flag) {
        this.fprintfStderr(`${label}\n`);
        this.exit(EXIT_FAILURE);
      }
    };

    if (is('mv')) {
      previously(this.valuesReturnFilter, 'ValuesReturnFilter previously specified');
      this.valuesReturnFilter = 1 + crit;
      if (cvalue === null) {
        this.fprintfStderr('missing filter in ValuesReturnFilter control\n');
        this.exit(EXIT_FAILURE);
      }
      this.vrFilter = cvalue;
      this.protocol = LdapVersion.V3;
    } else if (is('pr')) {
      previously(this.pagedResults, 'PagedResultsControl previously specified');
      if (this.vlv !== 0) {
        this.fprintfStderr('PagedResultsControl incompatible with VLV\n');
        this.exit(EXIT_FAILURE);
      }
      let tmp = 0;
      if (cvalue !== null) {
        let sizeText = cvalue;
        const prompt = cvalue.indexOf('/');
        if (prompt >= 0) {
          const promptText = cvalue.slice(prompt + 1);
          sizeText = cvalue.slice(0, prompt);
          if (strcasecmp(promptText, 'prompt') === 0) this.pagePrompt = 1;
          else if (strcasecmp(promptText, 'noprompt') === 0) this.pagePrompt = 0;
          else {
            this.fprintfStderr(`Invalid value for PagedResultsControl, ${sizeText}/${promptText}.\n`);
            this.exit(EXIT_FAILURE);
          }
        }
        const scanned = sscanfInt(sizeText, false);
        if (scanned === null) {
          this.fprintfStderr(`Invalid value for PagedResultsControl, ${sizeText}.\n`);
          this.exit(EXIT_FAILURE);
        }
        tmp = scanned;
      } else {
        this.fprintfStderr('Invalid value for PagedResultsControl.\n');
        this.exit(EXIT_FAILURE);
      }
      this.pageSize = tmp;
      this.pagedResults = 1 + crit;
    } else if (is('ps')) {
      previously(this.psearch, 'PersistentSearch previously specified');
      if (cvalue !== null) {
        const match = /^\s*([+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*))\/\s*([+-]?\d+)\/\s*([+-]?\d+)/.exec(cvalue);
        if (match === null) {
          this.fprintfStderr(`Invalid value for PersistentSearch, ${cvalue}.\n`);
          this.exit(EXIT_FAILURE);
        }
        this.psChgtypes = strtol(match[1], 0).value;
        this.psChgsonly = Number.parseInt(match[2], 10);
        this.psEchgCtrls = Number.parseInt(match[3], 10);
      } else {
        this.fprintfStderr('Invalid value for PersistentSearch.\n');
        this.exit(EXIT_FAILURE);
      }
      this.psearch = 1 + crit;
    } else if (is('dontUseCopy')) {
      previously(this.dontUseCopy, 'dontUseCopy control previously specified');
      if (cvalue !== null) {
        this.fprintfStderr('dontUseCopy: no control value expected\n');
        this.usage();
      }
      if (!crit) {
        this.fprintfStderr('dontUseCopy: critical flag required\n');
        this.usage();
      }
      this.dontUseCopy = 1 + crit;
    } else if (is('domainScope')) {
      previously(this.domainScope, 'domainScope control previously specified');
      if (cvalue !== null) {
        this.fprintfStderr('domainScope: no control value expected\n');
        this.usage();
      }
      this.domainScope = 1 + crit;
    } else if (is('sss')) {
      previously(this.sss, 'server side sorting control previously specified');
      if (cvalue === null) {
        this.fprintfStderr('missing specification of sss control\n');
        this.exit(EXIT_FAILURE);
      }
      const keys = C.createSortKeyList(cvalue.replace(/\//g, ' '));
      if (keys === null) {
        this.fprintfStderr(`server side sorting control value "${cvalue.replace(/\//g, ' ')}" invalid\n`);
        this.exit(EXIT_FAILURE);
      }
      this.sssKeys = keys;
      this.sss = 1 + crit;
    } else if (is('subentries')) {
      previously(this.subentries, 'subentries control previously specified');
      if (cvalue === null || strcasecmp(cvalue, 'true') === 0) this.subentries = 2;
      else if (strcasecmp(cvalue, 'false') === 0) this.subentries = 1;
      else {
        this.fprintfStderr(`subentries control value "${cvalue}" invalid\n`);
        this.exit(EXIT_FAILURE);
      }
      if (crit) this.subentries *= -1;
    } else if (is('sync')) {
      previously(this.ldapsync, 'sync control previously specified');
      if (cvalue === null) {
        this.fprintfStderr('missing specification of sync control\n');
        this.exit(EXIT_FAILURE);
      }
      if (startsWithIgnoreCase(cvalue, 'ro')) {
        this.ldapsync = C.LdapSync.REFRESH_ONLY;
        const slash = cvalue.indexOf('/');
        if (slash >= 0) {
          const cookie = cvalue.slice(slash + 1);
          if (cookie !== '') this.syncCookie = utf8(cookie);
        }
      } else if (startsWithIgnoreCase(cvalue, 'rp')) {
        this.ldapsync = C.LdapSync.REFRESH_AND_PERSIST;
        let working = cvalue;
        let cookiep: string | null = null;
        const slash = working.indexOf('/');
        if (slash >= 0) {
          cookiep = working.slice(slash + 1);
          working = cookiep;
        }
        let slimitp: string | null = null;
        const second = working.indexOf('/');
        if (second >= 0) {
          slimitp = working.slice(second + 1);
          working = working.slice(0, second);
          if (cookiep !== null) cookiep = working;
        }
        if (cookiep !== null && cookiep !== '') this.syncCookie = utf8(cookiep);
        if (slimitp !== null && slimitp !== '') {
          const parsed = longOf(slimitp);
          if (!parsed.ok) {
            this.fprintfStderr(`Unable to parse sync control value "${slimitp}"\n`);
            this.exit(EXIT_FAILURE);
          }
          this.syncSlimit = parsed.value;
        }
      } else {
        this.fprintfStderr(`sync control value "${cvalue}" invalid\n`);
        this.exit(EXIT_FAILURE);
      }
      if (crit) this.ldapsync *= -1;
    } else if (is('vlv')) {
      previously(this.vlv, 'virtual list view control previously specified');
      if (this.pagedResults !== 0) {
        this.fprintfStderr('PagedResultsControl incompatible with VLV\n');
        this.exit(EXIT_FAILURE);
      }
      if (cvalue === null) {
        this.fprintfStderr('missing specification of vlv control\n');
        this.exit(EXIT_FAILURE);
      }
      if (this.parseVlv(cvalue)) this.exit(EXIT_FAILURE);
      this.vlv = 1 + crit;
    } else if (is('deref')) {
      const specs = (cvalue ?? '').split(';').filter(spec => spec !== '');
      if (specs.length === 0) {
        this.fprintfStderr(`deref specs "${cvalue ?? ''}" invalid\n`);
        this.exit(EXIT_FAILURE);
      }
      const parsed: C.DerefSpec[] = [];
      for (const spec of specs) {
        const colon = spec.indexOf(':');
        if (colon < 0) {
          this.fprintfStderr(`deref specs "${cvalue}" invalid\n`);
          this.exit(EXIT_FAILURE);
        }
        parsed.push({
          derefAttr: spec.slice(0, colon),
          attributes: spec.slice(colon + 1).split(',').filter(attr => attr !== ''),
        });
      }
      this.derefSpecs = parsed;
      this.derefcrit = 1 + crit;
    } else if (is('dirSync')) {
      previously(this.dirSync, 'dirSync control previously specified');
      if (cvalue === null) {
        this.fprintfStderr('missing specification of dirSync control\n');
        this.exit(EXIT_FAILURE);
      }
      if (!crit) {
        this.fprintfStderr('dirSync: critical flag required\n');
        this.usage();
      }
      const slash = cvalue.indexOf('/');
      if (slash < 0) {
        this.fprintfStderr(`dirSync control value "${cvalue}" invalid\n`);
        this.exit(EXIT_FAILURE);
      }
      const flagsText = cvalue.slice(0, slash);
      let maxattrp = cvalue.slice(slash + 1);
      const cookieSlash = maxattrp.indexOf('/');
      if (cookieSlash >= 0) {
        const cookieText = maxattrp.slice(cookieSlash + 1);
        maxattrp = maxattrp.slice(0, cookieSlash);
        if (cookieText !== '') {
          const decoded = b64Pton(cookieText, b64DecodeLength(cookieText.length));
          this.dirSyncCookie = decoded ?? new Uint8Array(0);
        }
      }
      const flags = sscanfInt(flagsText, true);
      if (flags === null) {
        this.fprintfStderr(`Invalid value for dirSync, ${flagsText}.\n`);
        this.exit(EXIT_FAILURE);
      }
      this.dirSyncFlags = flags;
      const maxAttr = sscanfInt(maxattrp, false);
      if (maxAttr === null) {
        this.fprintfStderr(`Invalid value for dirSync, ${maxattrp}.\n`);
        this.exit(EXIT_FAILURE);
      }
      this.dirSyncMaxAttrCount = maxAttr;
      this.dirSync = 1 + crit;
    } else if (is('extendedDn')) {
      previously(this.extendedDn, 'extendedDn control previously specified');
      if (cvalue === null) {
        this.fprintfStderr('missing specification of extendedDn control\n');
        this.exit(EXIT_FAILURE);
      }
      const flag = sscanfInt(cvalue, false);
      if (flag === null) {
        this.fprintfStderr(`Invalid value for extendedDn, ${cvalue}.\n`);
        this.exit(EXIT_FAILURE);
      }
      this.extendedDnFlag = flag;
      this.extendedDn = 1 + crit;
    } else if (is('showDeleted')) {
      previously(this.showDeleted, 'showDeleted control previously specified');
      if (cvalue !== null) {
        this.fprintfStderr('showDeleted: no control value expected\n');
        this.usage();
      }
      this.showDeleted = 1 + crit;
    } else if (is('serverNotif')) {
      previously(this.serverNotif, 'serverNotif control previously specified');
      if (cvalue !== null) {
        this.fprintfStderr('serverNotif: no control value expected\n');
        this.usage();
      }
      this.serverNotif = 1 + crit;
    } else if (is('accountUsability')) {
      previously(this.accountUsability, 'accountUsability control previously specified');
      if (cvalue !== null) {
        this.fprintfStderr('accountUsability: no control value expected\n');
        this.usage();
      }
      this.accountUsability = 1 + crit;
    } else if (this.toolIsOid(control)) {
      if (this.genericControls.some(existing => existing.controlType === control)) {
        this.fprintfStderr(`${control} control previously specified\n`);
        this.exit(EXIT_FAILURE);
      }
      let value: Uint8Array | undefined;
      if (cvalue === null) {
        value = undefined;
      } else if (cvalue[0] === ':') {
        value = this.parseGenericValue(cvalue.slice(1));
      } else {
        this.fprintfStderr(`unable to parse ${control} control value\n`);
        this.exit(EXIT_FAILURE);
      }
      this.genericControls.push({ controlType: control, criticality: crit > 0, controlValue: value });
    } else {
      this.fprintfStderr(`Invalid search extension name: ${control}\n`);
      this.usage();
    }
  }

  private parseGenericValue(afterColon: string): Uint8Array {
    if (afterColon.startsWith(':')) {
      const encoded = afterColon.slice(1).replace(/^\s+/, '');
      const decoded = b64Pton(encoded, b64DecodeLength(encoded.length));
      return decoded ?? new Uint8Array(0);
    }
    return utf8(afterColon.replace(/^\s+/, ''));
  }

  private async toolConnSetup(dont: boolean): Promise<LdapSession> {
    const options = this.globalOptions;
    this.log.level = this.debug;
    let uri = this.ldapuri;
    if (!dont) {
      if (uri !== null) {
        const parsed = ldapUrlParseListExt(uri, ', ', LdapUrlParse.HISTORIC, this.log);
        if (parsed.rc !== LdapUrlErr.SUCCESS) {
          this.fprintfStderr(`Could not parse LDAP URI(s)=${uri} (${parsed.rc})\n`);
          this.exit(EXIT_FAILURE);
        }
        const urls: string[] = [];
        for (const lud of parsed.list) {
          if (lud.dn !== null && lud.dn !== '' && (lud.host === null || lud.host === '')) {
            const domain = dnToDomain(lud.dn);
            if (domain === null) {
              this.fprintfStderr(`DNS SRV: Could not turn DN="${lud.dn}" into a domain\n`);
              continue;
            }
            const hostlist = this.host.lookupDomainHosts(domain);
            if (hostlist === null) {
              this.fprintfStderr(`DNS SRV: Could not turn domain=${domain} into a hostlist\n`);
              continue;
            }
            for (const hostEntry of hostlist.split(' ').filter(entry => entry !== '')) urls.push(`${lud.scheme}://${hostEntry}`);
          } else {
            const text = ldapUrlDesc2Str(lud);
            if (text === null) {
              this.fprintfStderr('DNS SRV: out of memory?\n');
              break;
            }
            urls.push(text);
          }
        }
        if (urls.length === 0) this.exit(EXIT_FAILURE);
        uri = urls.join(' ');
        this.ldapuri = uri;
      }
      if (this.verbose) this.fprintfStderr(`ldap_initialize( ${uri ?? '<DEFAULT>'} )\n`);
      const session = new LdapSession(options, this.host.transport, this.log, this.host.clock, this.host.sasl);
      session.reservedDescriptors = this.infile !== null && this.infile !== '-' ? 1 : 0;
      if (uri !== null) {
        const rc = session.setUri(uri);
        if (rc !== LdapRc.SUCCESS) {
          this.fprintfStderr(`Could not create LDAP session handle for URI=${uri} (${rc}): ${this.err2string(rc)}\n`);
          this.exit(EXIT_FAILURE);
        }
      }
      this.session = session;

      if (this.deref !== -1) session.options.deref = this.deref;
      session.options.referrals = this.referrals !== 0;
      if (this.nocanon) session.options.sasl.noCanon = true;
      session.options.version = this.protocol;

      if (this.useTls) {
        const rc = await session.startTlsSync({ serverName: this.firstHost(session), tls: session.options.tls });
        if (rc !== LdapRc.SUCCESS) {
          this.toolPerror('ldap_start_tls', rc, null, null, session.errorText, null);
          if (this.useTls > 1 || rc < 0) this.toolExit(EXIT_FAILURE);
        }
      }
      if (this.nettimeout > 0) session.options.networkTimeout = this.nettimeout;
      return session;
    }
    const session = new LdapSession(options, this.host.transport, this.log, this.host.clock, this.host.sasl);
    this.session = session;
    return session;
  }

  private firstHost(session: LdapSession): string {
    return session.options.urls[0]?.host ?? 'localhost';
  }

  private async toolBind(session: LdapSession): Promise<void> {
    const sctrls: LdapControl[] = [];
    let msgbuf = '';

    if (this.ppolicy) sctrls.push({ controlType: C.ControlOid.PASSWORDPOLICY, criticality: false });
    if (this.bauthzid) sctrls.push({ controlType: C.ControlOid.AUTHZID_REQUEST, criticality: this.bauthzid > 1 });
    if (this.sessionTracking) {
      if (this.stValue === null && !this.stValueCompute(session)) this.toolExit(EXIT_FAILURE);
      sctrls.push({ controlType: C.ControlOid.SESSION_TRACKING, criticality: false, controlValue: this.stValue ?? undefined });
    }
    const sctrlsp = sctrls.length > 0 ? sctrls : null;

    if (this.pwFile !== null || this.wantBindpw) {
      if (this.pwFile !== null) {
        const read = this.host.readFile(this.pwFile);
        if ('error' in read) {
          this.fprintfStderr(`${this.pwFile}: ${read.error}\n`);
          this.toolExit(EXIT_FAILURE);
        }
        const bytes = read.bytes;
        const mode = this.host.fileMode(this.pwFile);
        if (mode !== null && (mode & 0o006) !== 0) {
          this.fprintfStderr(`Warning: Password file ${this.pwFile} is publicly readable/writeable\n`);
        }
        this.passwd = bytes;
      } else {
        const prompted = this.lutilGetpass('Enter LDAP Password: ');
        if (prompted === null) this.toolExit(EXIT_FAILURE);
        this.passwd = utf8(prompted);
      }
    }

    let parsed: ParsedResult | null = null;
    if (this.authmethod === AUTH_SASL) {
      parsed = await this.saslBind(session, sctrlsp);
    } else {
      const sent = await session.saslBindSimple(this.binddn, this.passwd, sctrlsp);
      if (sent.messageId === -1) {
        this.toolPerror('ldap_sasl_bind(SIMPLE)', sent.rc, null, null, null, null);
        this.toolExit(sent.rc);
      }
      const batch = await session.result(sent.messageId, LdapMsg.ALL);
      if (batch === null) {
        this.toolPerror('ldap_result', -1, null, null, null, null);
        this.toolExit(LdapRc.LOCAL_ERROR);
      }
      parsed = session.parseResult(batch.messages[batch.messages.length - 1], true);
    }

    const ctrls = parsed.controls;
    if (ctrls !== null && this.ppolicy) {
      const control = ctrls.find(candidate => candidate.controlType === C.ControlOid.PASSWORDPOLICY);
      const response = control === undefined ? null : C.parsePasswordPolicyResponse(control.controlValue);
      if (response !== null) {
        let length = 0;
        if (response.error !== C.PasswordPolicyError.noError) {
          msgbuf = `; ${C.passwordPolicyErr2Txt(response.error)}`;
          length = msgbuf.length;
        }
        if (response.expire >= 0) msgbuf = `${msgbuf.slice(0, length)} (Password expires in ${response.expire} seconds)`;
        else if (response.grace >= 0) msgbuf = `${msgbuf.slice(0, length)} (Password expired, ${response.grace} grace logins remain)`;
      }
    }
    if (ctrls !== null && this.bauthzid) {
      const control = ctrls.find(candidate => candidate.controlType === C.ControlOid.AUTHZID_RESPONSE);
      if (control !== undefined) this.toolPrintCtrls([control]);
    }
    if (ctrls !== null) {
      const control = ctrls.find(candidate => candidate.controlType === C.ControlOid.PASSWORD_EXPIRED)
        ?? ctrls.find(candidate => candidate.controlType === C.ControlOid.PASSWORD_EXPIRING);
      if (control !== undefined) this.toolPrintCtrls([control]);
    }

    const err = parsed.code;
    if (err !== LdapRc.SUCCESS || msgbuf !== '' || (parsed.matchedDn !== '') || (parsed.text !== '') || parsed.referrals !== null) {
      this.toolPerror('ldap_bind', err, msgbuf, parsed.matchedDn, parsed.text, parsed.referrals);
      if (err !== LdapRc.SUCCESS) this.toolExit(err);
    }
  }

  private stValueCompute(session: LdapSession): boolean {
    const hostName = this.host.localHostName();
    const address = hostName === null ? null : this.host.localAddress();
    let identifier: Uint8Array | null = null;
    if (this.sessionTrackingName !== null) identifier = utf8(this.sessionTrackingName);
    else if (this.saslAuthzId !== null) identifier = utf8(this.saslAuthzId);
    else if (this.saslAuthcId !== null) identifier = utf8(this.saslAuthcId);
    else if (this.binddn !== null) identifier = utf8(this.binddn);
    void session;
    const value = C.createSessionTrackingValue(address, hostName, C.ControlOid.SESSION_TRACKING_USERNAME, identifier);
    if (value === null) {
      this.fprintfStderr('Session tracking control encoding error!\n');
      return false;
    }
    this.stValue = value;
    return true;
  }

  private async saslBind(session: LdapSession, sctrls: LdapControl[] | null): Promise<ParsedResult> {
    if (this.saslSecprops !== null && parseSecprops(this.saslSecprops, session.options.sasl.secprops) !== LdapRc.SUCCESS) {
      this.fprintfStderr(`Could not set LDAP_OPT_X_SASL_SECPROPS: ${this.saslSecprops}\n`);
      this.toolExit(LdapRc.LOCAL_ERROR);
    }
    const defaults = saslDefaults(
      session.options.sasl, this.saslMech, this.saslRealm, this.saslAuthcId, this.passwd, this.saslAuthzId,
    );
    const terminal: SaslTerminal = {
      stderr: (text) => this.fprintfStderr(text),
      readLine: () => this.host.readStdinLine(),
      getpass: (prompt) => this.lutilGetpass(prompt),
    };
    const rmech: { value: string | null } = { value: null };
    let result: LdapMessage | null = null;
    let rc: number;
    for (;;) {
      const step = await session.saslInteractiveBind({
        dn: this.binddn, mechs: this.saslMech, controls: sctrls, flags: this.saslFlags,
        interact: (flags, prompts) => saslInteract(flags, defaults, prompts, terminal),
        result, rmech,
      });
      rc = step.rc;
      if (rc !== LdapRc.SASL_BIND_IN_PROGRESS) break;
      this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
      const batch = await session.result(step.msgid, LdapMsg.ALL);
      if (batch === null) {
        this.toolPerror('ldap_sasl_interactive_bind', session.errno, null, null, session.errorText, null);
        this.toolExit(session.errno);
      }
      result = batch.messages[batch.messages.length - 1];
    }
    if (rc !== LdapRc.SUCCESS || result === null) {
      this.toolPerror('ldap_sasl_interactive_bind', rc, null, null, session.errorText, null);
      this.toolExit(rc);
    }
    return session.parseResult(result, true);
  }

  private toolServerControls(session: LdapSession, extra: readonly LdapControl[]): void {
    if (!(this.assertctl || this.authzid !== null || this.proxydn !== null || this.manageDIT || this.manageDSAit
      || this.noop || this.ppolicy || this.preread || this.postread || this.chaining || this.sessionTracking
      || extra.length > 0 || this.unknownControls.length > 0)) {
      return;
    }
    const controls: LdapControl[] = [];
    if (this.assertctl) {
      const filter = this.assertion === null || this.assertion === '' ? null : putFilter(this.assertion, (line) => this.log.debug(LdapDebug.TRACE, line));
      if (filter === null) {
        const code = this.assertion === '' ? LdapRc.PARAM_ERROR : LdapRc.ENCODING_ERROR;
        this.fprintfStderr(`Unable to create assertion value "${this.assertion}" (${code})\n`);
        controls.push({ controlType: C.ControlOid.ASSERT, criticality: this.assertctl > 1 });
      } else {
        controls.push({
          controlType: C.ControlOid.ASSERT, criticality: this.assertctl > 1,
          controlValue: C.createAssertionValue(filter),
        });
      }
    }
    if (this.authzid !== null) {
      controls.push({ controlType: C.ControlOid.PROXY_AUTHZ, criticality: this.authzcrit !== 0, controlValue: utf8(this.authzid) });
    }
    if (this.proxydn !== null) {
      const text = utf8(this.proxydn);
      const encoded = new Uint8Array(2 + text.length);
      encoded[0] = 0x04;
      encoded[1] = text.length;
      encoded.set(text, 2);
      controls.push({ controlType: C.ControlOid.OBSOLETE_PROXY_AUTHZ, criticality: this.authzcrit !== 0, controlValue: encoded });
    }
    if (this.manageDIT) controls.push({ controlType: C.ControlOid.RELAX, criticality: this.manageDIT > 1 });
    if (this.manageDSAit) controls.push({ controlType: C.ControlOid.MANAGEDSAIT, criticality: this.manageDSAit > 1 });
    if (this.noop) controls.push({ controlType: C.ControlOid.NOOP, criticality: this.noop > 1 });
    if (this.ppolicy) controls.push({ controlType: C.ControlOid.PASSWORDPOLICY, criticality: false });
    if (this.preread) {
      const attrs = this.prereadAttrs === null ? null : this.prereadAttrs.split(',').filter(attr => attr !== '');
      controls.push({ controlType: C.ControlOid.PRE_READ, criticality: this.preread > 1, controlValue: C.createPrePostReadValue(attrs) });
    }
    if (this.postread) {
      const attrs = this.postreadAttrs === null ? null : this.postreadAttrs.split(',').filter(attr => attr !== '');
      controls.push({ controlType: C.ControlOid.POST_READ, criticality: this.postread > 1, controlValue: C.createPrePostReadValue(attrs) });
    }
    if (this.chaining) {
      const value = this.chainingResolve > -1
        ? C.createChainingValue(this.chainingResolve, this.chainingContinuation > -1 ? this.chainingContinuation : null)
        : undefined;
      controls.push({ controlType: C.ControlOid.CHAINING_BEHAVIOR, criticality: this.chaining > 1, controlValue: value });
    }
    if (this.sessionTracking) {
      if (this.stValue === null && !this.stValueCompute(session)) this.toolExit(EXIT_FAILURE);
      controls.push({ controlType: C.ControlOid.SESSION_TRACKING, criticality: false, controlValue: this.stValue ?? undefined });
    }
    for (const control of extra) controls.push(control);
    for (const control of this.unknownControls) controls.push(control);
    session.serverControls = controls;
  }

  private generateSearchControls(session: LdapSession): LdapControl[] {
    const controls: LdapControl[] = [...this.genericControls];
    if (this.accountUsability) {
      controls.push({ controlType: C.ControlOid.ACCOUNT_USABILITY, criticality: this.accountUsability === 2 });
    }
    if (this.dontUseCopy) controls.push({ controlType: C.ControlOid.DONTUSECOPY, criticality: this.dontUseCopy === 2 });
    if (this.domainScope) controls.push({ controlType: C.ControlOid.DOMAIN_SCOPE, criticality: this.domainScope > 1 });
    if (this.subentries) {
      controls.push({
        controlType: C.ControlOid.SUBENTRIES, criticality: this.subentries < 1,
        controlValue: new Uint8Array([0x01, 0x01, Math.abs(this.subentries) === 1 ? 0x00 : 0xff]),
      });
    }
    if (this.ldapsync) {
      controls.push({
        controlType: C.ControlOid.SYNC, criticality: this.ldapsync < 0,
        controlValue: C.createSyncRequestValue(Math.abs(this.ldapsync), this.syncCookie),
      });
    }
    if (this.valuesReturnFilter) {
      const items = putVrFilter(this.vrFilter ?? '', (line) => this.log.debug(LdapDebug.TRACE, line));
      if (items === null) {
        this.fprintfStderr(`Bad ValuesReturnFilter: ${this.vrFilter}\n`);
        this.toolExit(EXIT_FAILURE);
      }
      controls.push({
        controlType: C.ControlOid.VALUESRETURNFILTER, criticality: this.valuesReturnFilter > 1,
        controlValue: C.createVrFilterValue(items),
      });
    }
    if (this.pagedResults) {
      const value = C.createPageControlValue(this.pageSize, this.prCookie);
      if (value === null) this.toolExit(EXIT_FAILURE);
      this.prCookie = new Uint8Array(0);
      controls.push({ controlType: C.ControlOid.PAGEDRESULTS, criticality: this.pagedResults > 1, controlValue: value });
    }
    if (this.psearch) {
      controls.push({
        controlType: C.ControlOid.PERSIST_REQUEST, criticality: this.psearch > 1,
        controlValue: C.createPersistentSearchValue(this.psChgtypes, this.psChgsonly !== 0, this.psEchgCtrls !== 0),
      });
    }
    if (this.sss) {
      controls.push({
        controlType: C.ControlOid.SORTREQUEST, criticality: this.sss > 1,
        controlValue: C.createSortControlValue(this.sssKeys!),
      });
    }
    if (this.vlv) {
      controls.push({
        controlType: C.ControlOid.VLVREQUEST, criticality: this.vlv > 1,
        controlValue: C.createVlvControlValue(this.vlvInfo),
      });
    }
    if (this.derefcrit) {
      controls.push({
        controlType: '1.3.6.1.4.1.4203.666.5.16', criticality: this.derefcrit > 1,
        controlValue: C.createDerefControlValue(this.derefSpecs!),
      });
    }
    if (this.dirSync) {
      controls.push({
        controlType: C.ControlOid.DIRSYNC, criticality: this.dirSync > 1,
        controlValue: C.createDirSyncValue(this.dirSyncFlags, this.dirSyncMaxAttrCount, this.dirSyncCookie),
      });
    }
    if (this.extendedDn) {
      controls.push({
        controlType: C.ControlOid.EXTENDED_DN, criticality: this.extendedDn > 1,
        controlValue: C.createExtendedDnValue(this.extendedDnFlag),
      });
    }
    if (this.showDeleted) controls.push({ controlType: C.ControlOid.SHOW_DELETED, criticality: this.showDeleted > 1 });
    if (this.serverNotif) controls.push({ controlType: C.ControlOid.SERVER_NOTIFICATION, criticality: this.serverNotif > 1 });
    void session;
    return controls;
  }

  private async searchPages(session: LdapSession, filtpattern: string, attrs: string[] | null): Promise<number> {
    let rc = 0;
    for (;;) {
      let fileLines: string[] | null = null;
      if (this.infile !== null) {
        fileLines = this.openInfile();
        if (fileLines === null) this.toolExit(EXIT_FAILURE);
      }
      const generated = this.generateSearchControls(session);
      this.toolServerControls(session, generated);

      if (this.verbose) {
        this.fprintfStderr(`filter${this.infile !== null ? ' pattern' : ''}: ${filtpattern}\nrequesting: `);
        if (attrs === null) this.fprintfStderr('All userApplication attributes');
        else for (const attr of attrs) this.fprintfStderr(`${attr} `);
        this.fprintfStderr('\n');
      }

      if (this.ldif === 0) this.printf('# extended LDIF\n');
      else if (this.ldif < 3) this.printf('version: 1\n\n');
      if (this.ldif < 2) this.printSearchHeader(session, filtpattern, attrs);

      if (this.infile === null) {
        rc = await this.dosearch(session, this.base, this.scope, null, filtpattern, attrs, this.attrsonly, this.sizelimit);
      } else {
        rc = 0;
        let first = true;
        for (const rawLine of fileLines!) {
          const line = rawLine.slice(0, BUFSIZ - 1).slice(0, -1);
          if (!first) this.printf('\n');
          else first = false;
          const rc1 = await this.dosearch(session, this.base, this.scope, filtpattern, line, attrs, this.attrsonly, this.sizelimit);
          if (rc1 !== 0) {
            rc = rc1;
            if (!this.contoper) break;
          }
        }
      }

      if (rc === LdapRc.SUCCESS && this.pageSize && this.morePagedResults) {
        if (this.pagePrompt !== 0) {
          if (this.entriesLeft > 0) this.printf(`Estimate entries: ${this.entriesLeft}\n`);
          this.printf(`Press [size] Enter for the next {${this.pageSize}|size} entries.\n`);
          const buffer = this.readLineFromStdin(11);
          if (buffer.length > 0 && isDigit(buffer[0])) {
            const size = sscanfInt(buffer, false);
            if (size === null) {
              this.fprintfStderr(`Invalid value for PagedResultsControl, ${buffer}.\n`);
              this.toolExit(EXIT_FAILURE);
            }
            this.pageSize = size;
          }
        }
        continue;
      }
      if (rc === LdapRc.SUCCESS && this.vlv) {
        this.printf('Press [before/after(/offset/count|:value)] Enter for the next window.\n');
        const buffer = this.readLineFromStdin(BUFSIZ - 1);
        if (buffer !== '') {
          if (this.parseVlv(buffer)) this.toolExit(EXIT_FAILURE);
        } else {
          this.vlvInfo.attrValue = null;
          this.vlvInfo.count = this.vlvCount;
          this.vlvInfo.offset += this.vlvInfo.afterCount;
        }
        this.vlvInfo.context = this.vlvContext;
        continue;
      }
      break;
    }
    this.toolExit(rc);
  }

  private readLineFromStdin(limit: number): string {
    let buffer = '';
    let character = this.host.readStdinCharacter();
    while (character !== null && character !== '\n') {
      if (buffer.length < limit) buffer += character;
      character = this.host.readStdinCharacter();
    }
    return buffer;
  }

  private printSearchHeader(session: LdapSession, filtpattern: string, attrs: string[] | null): void {
    const realbase = this.base ?? session.options.defBase;
    this.printf('#\n');
    this.printf(`# LDAPv${this.protocol}\n`);
    const scopeName = this.scope === LdapScope.BASE ? 'baseObject'
      : this.scope === LdapScope.ONELEVEL ? 'oneLevel'
      : this.scope === LdapScope.SUBORDINATE ? 'children' : 'subtree';
    this.printf(`# base <${realbase ?? ''}>${realbase === null || realbase !== this.base ? ' (default)' : ''} with scope ${scopeName}\n`);
    this.printf(`# filter${this.infile !== null ? ' pattern' : ''}: ${filtpattern}\n`);
    this.printf('# requesting: ');
    if (attrs === null) this.printf('ALL');
    else for (const attr of attrs) this.printf(`${attr} `);
    if (this.manageDSAit) this.printf(`\n# with manageDSAit ${this.manageDSAit > 1 ? 'critical ' : ''}control`);
    if (this.noop) this.printf(`\n# with noop ${this.noop > 1 ? 'critical ' : ''}control`);
    if (this.subentries) {
      this.printf(`\n# with subentries ${this.subentries < 0 ? 'critical ' : ''}control: ${Math.abs(this.subentries) === 1 ? 'false' : 'true'}`);
    }
    if (this.valuesReturnFilter) {
      this.printf(`\n# with valuesReturnFilter ${this.valuesReturnFilter > 1 ? 'critical ' : ''}control: ${this.vrFilter}`);
    }
    if (this.pagedResults) {
      this.printf(`\n# with pagedResults ${this.pagedResults > 1 ? 'critical ' : ''}control: size=${this.pageSize}`);
    }
    if (this.sss) this.printf(`\n# with server side sorting ${this.sss > 1 ? 'critical ' : ''}control`);
    if (this.vlv) {
      this.printf(`\n# with virtual list view ${this.vlv > 1 ? 'critical ' : ''}control: ${this.vlvInfo.beforeCount}/${this.vlvInfo.afterCount}`);
      if (this.vlvInfo.attrValue !== null) this.printf(`:${this.vlvInfo.attrValue}`);
      else this.printf(`/${this.vlvInfo.offset}/${this.vlvInfo.count}`);
    }
    if (this.derefcrit) this.printf(`\n# with dereference ${this.derefcrit > 1 ? 'critical ' : ''}control`);
    this.printf('\n#\n\n');
  }

  private lutilGetpass(prompt: string): string | null {
    this.fprintfStderr(prompt);
    let password = '';
    let character = this.host.readStdinCharacter();
    while (character !== null && character !== '\n' && character !== '\r') {
      if (password.length < PASSWORD_BUFFER_SIZE - 1) password += character;
      character = this.host.readStdinCharacter();
    }
    return character === null ? null : password;
  }

  private toolCheckAbandon(session: LdapSession, messageId: number): number {
    void session;
    void messageId;
    switch (this.gotintr) {
      case 2:
      case 1:
      case 3:
        return -1;
      default:
        return 0;
    }
  }

  private async dosearch(
    session: LdapSession, base: string | null, scope: number, filtpatt: string | null, value: string,
    attrs: string[] | null, attrsonly: number, sizelimit: number,
  ): Promise<number> {
    let filter: string;
    if (filtpatt !== null) {
      const maxSize = filtpatt.length + value.length + 1;
      filter = filtpatt.replace('%s', value);
      if (filter.length >= maxSize) {
        this.fprintfStderr(`Bad filter pattern: "${filtpatt}"\n`);
        return EXIT_FAILURE;
      }
      if (this.verbose) this.fprintfStderr(`filter: ${filter}\n`);
      if (this.ldif < 2) this.printf(`#\n# filter: ${filter}\n#\n`);
    } else {
      filter = value;
    }
    if (this.dont) return LdapRc.SUCCESS;

    let timeoutSeconds: number | null = null;
    if (this.timelimit > 0) timeoutSeconds = this.timelimit;

    const sent = await session.searchExt({
      base, scope, filter, attributes: attrs, attrsOnly: attrsonly !== 0,
      serverControls: null, timeoutSeconds, sizeLimit: sizelimit,
    });
    if (sent.rc !== LdapRc.SUCCESS) {
      this.toolPerror('ldap_search_ext', sent.rc, null, null, null, null);
      return sent.rc;
    }
    const msgid = sent.messageId;
    let nresponses = 0;
    let nentries = 0;
    let nreferences = 0;
    let nextended = 0;
    let npartial = 0;
    let rc2: number = LdapRc.OTHER;
    let nresponsesPsearch = -1;
    let cancelMsgid = -1;
    const timeoutBounded = this.timelimit > 0;

    let rc = 0;
    let finished = false;
    let lastBatch: ResultBatch | null = null;
    while (!finished) {
      const batch: ResultBatch | null = await session.result(
        LDAP_RES_ANY, this.sortattr !== null ? LdapMsg.ALL : LdapMsg.ONE,
        timeoutBounded ? { seconds: -1, microseconds: 0 } : null,
      );
      if (batch === null) {
        rc = -1;
        break;
      }
      rc = batch.type;
      if (this.toolCheckAbandon(session, msgid)) return -1;
      let messages = batch.messages;
      if (this.sortattr !== null) messages = this.sortEntries(messages, this.sortattr === '' ? null : this.sortattr);
      for (const message of messages) {
        if (nresponses++) this.printf('\n');
        if (nresponsesPsearch >= 0) nresponsesPsearch++;
        const kind = message.protocolOp.kind;
        if (kind === 'searchResultEntry') {
          nentries++;
          this.printEntry(message, attrsonly !== 0);
        } else if (kind === 'searchResultReference') {
          nreferences++;
          this.printReference(message);
        } else if (kind === 'extendedResponse') {
          nextended++;
          this.printExtended(message);
          if (message.messageID === 0) {
            finished = true;
            break;
          }
          if (cancelMsgid !== -1 && cancelMsgid === message.messageID) {
            this.printf('Cancelled \n');
            this.printf(`cancel_msgid = ${cancelMsgid}\n`);
            finished = true;
            break;
          }
        } else if (kind === 'searchResultDone') {
          rc2 = this.printResult(session, message, true);
          if (this.ldapsync === C.LdapSync.REFRESH_AND_PERSIST) continue;
          finished = true;
          break;
        } else if (kind === 'intermediateResponse') {
          npartial++;
          nresponsesPsearch = 0;
          const op = message.protocolOp;
          if (op.responseName === C.ControlOid.SYNC_INFO) {
            if (this.ldif < 1) this.printSyncInfo(op.responseValue);
            else if (this.ldif < 2) this.printf('# SyncInfo Received\n');
            continue;
          }
          this.printPartial(message);
          finished = true;
          break;
        }
        if (this.ldapsync && this.syncSlimit !== -1 && nresponsesPsearch >= this.syncSlimit) {
          const exchange = await session.extendedOperation(
            C.EXOP_CANCEL, new Uint8Array([0x30, 0x03, 0x02, 0x01, msgid & 0xff]),
          );
          cancelMsgid = exchange.messageId;
          nresponsesPsearch = -1;
        }
      }
      if (!finished) session.msgfree(batch);
      else lastBatch = batch;
    }
    if (!timeoutBounded && rc !== LdapRes.SEARCH_RESULT) rc2 = session.errno;
    session.msgfree(lastBatch);

    if (this.pagedResults) {
      this.npagedresponses += nresponses;
      this.npagedentries += nentries;
      this.npagedextended += nextended;
      this.npagedpartial += npartial;
      this.npagedreferences += nreferences;
      if (this.morePagedResults === 0 && this.ldif < 2) {
        this.printf(`\n# numResponses: ${this.npagedresponses}\n`);
        if (this.npagedentries) this.printf(`# numEntries: ${this.npagedentries}\n`);
        if (this.npagedextended) this.printf(`# numExtended: ${this.npagedextended}\n`);
        if (this.npagedpartial) this.printf(`# numPartial: ${this.npagedpartial}\n`);
        if (this.npagedreferences) this.printf(`# numReferences: ${this.npagedreferences}\n`);
      }
    } else if (this.ldif < 2) {
      this.printf(`\n# numResponses: ${nresponses}\n`);
      if (nentries) this.printf(`# numEntries: ${nentries}\n`);
      if (nextended) this.printf(`# numExtended: ${nextended}\n`);
      if (npartial) this.printf(`# numPartial: ${npartial}\n`);
      if (nreferences) this.printf(`# numReferences: ${nreferences}\n`);
    }
    if (rc !== LdapRes.SEARCH_RESULT) this.toolPerror('ldap_result', rc2, null, null, null, null);
    return rc2;
  }

  private sortEntries(messages: LdapMessage[], attribute: string | null): LdapMessage[] {
    const entries = messages.filter(message => message.protocolOp.kind === 'searchResultEntry');
    const others = messages.filter(message => message.protocolOp.kind !== 'searchResultEntry');
    if (entries.length < 2) return [...entries, ...others];
    const keyed = entries.map((message, index) => {
      const op = message.protocolOp;
      let values: string[] | null;
      const session = this.session as LdapSession;
      if (attribute === null) {
        session.traceGetDn(message);
        values = op.kind === 'searchResultEntry' ? explodeDnWithoutTypes(op.objectName, this.log) : null;
      } else {
        session.traceGetValues(message, attribute, entryAttributes(message).map(candidate => candidate.name));
        const found = entryAttributes(message).find(candidate => candidate.name.toLowerCase() === attribute.toLowerCase());
        values = found === undefined ? null : found.values.map(fromUtf8);
      }
      return { message, values, index };
    });
    keyed.sort((left, right) => {
      if (left.values === null && right.values === null) return left.index - right.index;
      if (left.values === null) return -1;
      if (right.values === null) return 1;
      let i = 0;
      for (; i < left.values.length && i < right.values.length; i++) {
        const comparison = strcasecmp(left.values[i], right.values[i]);
        if (comparison !== 0) return comparison;
      }
      if (left.values.length === right.values.length) return left.index - right.index;
      return i >= left.values.length ? -1 : 1;
    });
    return [...keyed.map(item => item.message), ...others];
  }

  private printEntry(entry: LdapMessage, attrsonly: boolean): void {
    const op = entry.protocolOp;
    if (op.kind !== 'searchResultEntry') return;
    const session = this.session as LdapSession;
    const dn = op.objectName;
    const ber = session.getDnBer(entry);
    let ufn: string | null = null;
    if (this.ldif < 2) {
      ufn = dnToUfn(dn, this.log);
      this.toolWriteLdif(LdifPut.COMMENT, null, ufn === null ? null : utf8(ufn));
    }
    this.toolWriteLdif(LdifPut.VALUE, 'dn', utf8(dn));
    const controlsRc = session.getEntryControls(entry);
    if (controlsRc !== LdapRc.SUCCESS) {
      this.fprintfStderr(`print_entry: ${controlsRc}\n`);
      this.toolPerror('ldap_get_entry_controls', controlsRc, null, null, null, null);
      this.toolExit(EXIT_FAILURE);
    }
    if (entry.controls !== undefined && entry.controls.length > 0) this.toolPrintCtrls(entry.controls);
    if (this.includeufn) {
      if (ufn === null) ufn = dnToUfn(dn, this.log);
      this.toolWriteLdif(LdifPut.VALUE, 'ufn', ufn === null ? null : utf8(ufn));
    }
    for (const attribute of entryAttributes(entry)) {
      session.getAttributeBer(ber, !attrsonly);
      if (attrsonly) {
        this.toolWriteLdif(LdifPut.NOVALUE, attribute.name, null);
        continue;
      }
      for (const value of attribute.values) {
        if (this.vals2tmp > 1 || (this.vals2tmp && ldifIsNotPrintable(value))) {
          const template = `${this.tmpdir}/ldapsearch-${attribute.name}-XXXXXX`;
          const created = this.host.createTemporaryFile(template, value);
          if ('error' in created) {
            this.fprintfStderr(`${template}: ${created.error}\n`);
            continue;
          }
          const url = `${this.urlpre}${created.path.slice((this.tmpdir as string).length + 1)}`;
          this.toolWriteLdif(LdifPut.URL, attribute.name, utf8(url));
        } else {
          this.toolWriteLdif(LdifPut.VALUE, attribute.name, value);
        }
      }
    }
    session.getAttributeBer(ber, !attrsonly);
  }

  private printReference(message: LdapMessage): void {
    const op = message.protocolOp;
    if (op.kind !== 'searchResultReference') return;
    if (this.ldif < 2) this.printf('# search reference\n');
    const parseRc = (this.session as LdapSession).parseReference(message);
    if (parseRc !== LdapRc.SUCCESS) {
      this.toolPerror('ldap_parse_reference', parseRc, null, null, null, null);
      this.toolExit(EXIT_FAILURE);
    }
    for (const ref of op.uris) this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.VALUE, 'ref', utf8(ref));
    if (message.controls !== undefined && message.controls.length > 0) this.toolPrintCtrls(message.controls);
  }

  private printExtended(message: LdapMessage): void {
    const op = message.protocolOp;
    if (op.kind !== 'extendedResponse') return;
    if (this.ldif < 2) this.printf('# extended result response\n');
    if (this.ldif < 2) {
      this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.VALUE, 'extended', op.responseName === undefined ? null : utf8(op.responseName));
    }
    if (op.responseValue !== undefined && this.ldif < 2) {
      this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.BINARY, 'data', op.responseValue);
    }
    this.printResult(this.session as LdapSession, message, false);
  }

  private cookieLines(cookie: Uint8Array): string {
    if (ldifIsNotPrintable(cookie)) return `# cookie:: ${b64Ntop(cookie)}\n`;
    return `# cookie: ${fromUtf8(cookie)}\n`;
  }

  private printSyncInfo(data: Uint8Array | undefined): void {
    this.printf('# SyncInfo Received: ');
    if (data === undefined || data.length === 0) {
      this.printf('empty SyncInfoValue\n');
      this.printf('SyncInfoValue unknown\n');
      return;
    }
    const tag = data[0];
    const unknown = (): void => this.printf('SyncInfoValue unknown\n');
    if (tag === 0x80) {
      this.printf('new cookie\n');
      const length = data[1];
      this.printf(this.cookieLines(data.slice(2, 2 + length)));
    } else if (tag === 0xa1 || tag === 0xa2) {
      this.printf(tag === 0xa1 ? 'refresh delete\n' : 'refresh present\n');
      let done = true;
      let at = 2;
      if (data[at] === 0x04) {
        const length = data[at + 1];
        this.printf(this.cookieLines(data.slice(at + 2, at + 2 + length)));
        at += 2 + length;
      }
      if (data[at] === 0x01) done = data[at + 2] !== 0;
      if (done) this.printf('# refresh done, switching to persist stage\n');
    } else if (tag === 0xa3) {
      this.printf('ID Set\n');
      let at = 2;
      if (data[at] === 0x04) {
        const length = data[at + 1];
        this.printf(this.cookieLines(data.slice(at + 2, at + 2 + length)));
        at += 2 + length;
      }
      let refreshDeletes = false;
      if (data[at] === 0x01) {
        refreshDeletes = data[at + 2] !== 0;
        at += 3;
      }
      if (refreshDeletes) this.printf('# following UUIDs no longer match the search\n');
      this.printf('# syncUUIDs:\n');
      if (data[at] === 0x31) {
        const end = at + 2 + data[at + 1];
        let cursor = at + 2;
        while (cursor < end) {
          const length = data[cursor + 1];
          const uuid = C.formatUuid(data.slice(cursor + 2, cursor + 2 + length));
          this.printf(uuid === null ? '#\t(UUID malformed)\n' : `#\t${uuid}\n`);
          cursor += 2 + length;
        }
      }
    } else {
      unknown();
    }
  }

  private printPartial(message: LdapMessage): void {
    const op = message.protocolOp;
    if (op.kind !== 'intermediateResponse') return;
    if (this.ldif < 2) this.printf('# extended partial response\n');
    if (this.ldif < 2) {
      this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.VALUE, 'partial', op.responseName === undefined ? null : utf8(op.responseName));
    }
    if (op.responseValue !== undefined && this.ldif < 2) {
      this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.BINARY, 'data', op.responseValue);
    }
    if (message.controls !== undefined && message.controls.length > 0) this.toolPrintCtrls(message.controls);
  }

  private printResult(session: LdapSession, message: LdapMessage, search: boolean): number {
    if (search) {
      if (this.ldif < 2) this.printf('# search result\n');
      if (this.ldif < 1) this.printf(`search: ${message.messageID}\n`);
    }
    const parsed = session.parseResult(message);
    const err = parsed.code;
    if (!this.ldif) {
      this.printf(`result: ${err} ${this.err2string(err)}\n`);
    } else if (err !== LdapRc.SUCCESS) {
      this.fprintfStderr(`${this.err2string(err)} (${err})\n`);
    }
    if (parsed.matchedDn !== '') {
      if (!this.ldif) this.toolWriteLdif(LdifPut.VALUE, 'matchedDN', utf8(parsed.matchedDn));
      else this.fprintfStderr(`Matched DN: ${parsed.matchedDn}\n`);
    }
    if (parsed.text !== '') {
      if (!this.ldif) {
        if (err === LdapRc.PARTIAL_RESULTS) {
          for (const line of parsed.text.split('\n')) this.toolWriteLdif(LdifPut.TEXT, 'text', utf8(line));
        } else {
          this.toolWriteLdif(LdifPut.TEXT, 'text', utf8(parsed.text));
        }
      } else {
        this.fprintfStderr(`Additional information: ${parsed.text}\n`);
      }
    }
    if (parsed.referrals !== null) {
      for (const ref of parsed.referrals) {
        if (!this.ldif) this.toolWriteLdif(LdifPut.VALUE, 'ref', utf8(ref));
        else this.fprintfStderr(`Referral: ${ref}\n`);
      }
    }
    this.morePagedResults = 0;
    if (parsed.controls !== null && parsed.controls.length > 0) this.toolPrintCtrls(parsed.controls);
    return err;
  }

  private toolPrintCtrls(controls: readonly LdapControl[]): void {
    for (const control of controls) {
      const value = control.controlValue;
      let text = this.ldif ? ': ' : '';
      text += control.controlType;
      text += control.criticality ? ' true' : ' false';
      if (value !== undefined && value.length > 0) text += ` ${b64Ntop(value)}`;
      if (this.ldif < 2) this.toolWriteLdif(this.ldif ? LdifPut.COMMENT : LdifPut.VALUE, 'control', utf8(text));
      this.printKnownControl(control);
    }
  }

  private commentOrValue(label: string, text: string): void {
    this.toolWriteLdif(
      this.ldif ? LdifPut.COMMENT : LdifPut.VALUE,
      this.ldif ? `${label}: ` : label,
      utf8(text),
    );
  }

  private printKnownControl(control: LdapControl): void {
    const value = control.controlValue;
    if (value !== undefined) traceControlParse(control.controlType, (this.session as LdapSession).berOf(value), this.ldif);
    switch (control.controlType) {
      case C.ControlOid.PRE_READ: this.printPrePostRead(value, 'preread'); break;
      case C.ControlOid.POST_READ: this.printPrePostRead(value, 'postread'); break;
      case C.ControlOid.PAGEDRESULTS: {
        const response = C.parsePageResponse(value);
        if (response === null) break;
        this.prCookie = response.cookie;
        let text = response.estimate > 0 ? `estimate=${response.estimate} cookie=` : 'cookie=';
        if (response.cookie.length > 0) {
          text += b64Ntop(response.cookie);
          this.morePagedResults = 1;
        }
        this.commentOrValue('pagedresults', text);
        break;
      }
      case C.ControlOid.PERSIST_ENTRY_CHANGE_NOTICE: {
        const change = C.parseEntryChange(value);
        if (change === null) break;
        let text = '';
        switch (change.changeType) {
          case C.PersistEntryChange.ADD: text = 'add'; break;
          case C.PersistEntryChange.DELETE: text = 'delete'; break;
          case C.PersistEntryChange.MODIFY: text = 'modify'; break;
          case C.PersistEntryChange.RENAME:
            text = 'moddn';
            if (change.previousDn !== null) text += ` prevdn ${change.previousDn}`;
            break;
        }
        if (change.changeNumber !== null) text += ` changeNumber ${change.changeNumber}`;
        this.commentOrValue('persistentSearch', text);
        break;
      }
      case C.ControlOid.AUTHZID_RESPONSE:
        this.commentOrValue('authzid', value !== undefined && value.length > 0 ? fromUtf8(value) : 'anonymous');
        break;
      case C.ControlOid.PASSWORDPOLICY: {
        const response = C.parsePasswordPolicyResponse(value);
        if (response === null) break;
        let text = '';
        if (response.expire !== -1) text += `expire=${response.expire}`;
        if (response.grace !== -1) text += `${text === '' ? '' : ' '}grace=${response.grace}`;
        if (response.error !== C.PasswordPolicyError.noError) {
          text += `${text === '' ? '' : ' '}error=${response.error} (${C.passwordPolicyErr2Txt(response.error)})`;
        }
        this.commentOrValue('ppolicy', text);
        break;
      }
      case C.ControlOid.SORTRESPONSE: {
        const response = C.parseSortResponse(value);
        if (response === null) break;
        const text = `(${response.result}) ${this.err2string(response.result)}${response.attribute !== null ? ` ${response.attribute}` : ''}`;
        this.commentOrValue('sortResult', text);
        break;
      }
      case C.ControlOid.VLVRESPONSE: {
        const response = C.parseVlvResponse(value);
        if (response === null) break;
        this.vlvPos = response.position;
        this.vlvCount = response.count;
        this.vlvContext = response.context;
        const context = response.context !== null && response.context.length > 0 ? b64Ntop(response.context) : '';
        const text = `pos=${response.position} count=${response.count} context=${context} (${response.result}) ${this.err2string(response.result)}`;
        this.commentOrValue('vlvResult', text);
        break;
      }
      case '1.3.6.1.4.1.4203.666.5.16': this.printDeref(value); break;
      case '1.3.6.1.4.1.4203.666.5.17': this.printWhatFailed(value); break;
      case C.ControlOid.SYNC_STATE: this.printSyncState(value); break;
      case C.ControlOid.SYNC_DONE: this.printSyncDone(value); break;
      case C.ControlOid.DIRSYNC: {
        const response = C.parseDirSyncResponse(value);
        if (response === null) break;
        this.printf(`# DirSync control continueFlag=${response.continueFlag}\n`);
        if (response.cookie.length > 0) this.printf(this.cookieLines(response.cookie));
        break;
      }
      case C.ControlOid.ACCOUNT_USABILITY: this.printAccountUsability(value); break;
      case C.ControlOid.PASSWORD_EXPIRED: this.printf('# PasswordExpired control\n'); break;
      case C.ControlOid.PASSWORD_EXPIRING: {
        const seconds = C.parsePasswordExpiring(value);
        if (seconds !== null) this.printf(`# PasswordExpiring control seconds=${seconds}\n`);
        break;
      }
      default:
        break;
    }
  }

  private printPrePostRead(value: Uint8Array | undefined, what: string): void {
    this.toolWriteLdif(LdifPut.COMMENT, '==> ', utf8(what));
    const parsed = C.parsePrePostRead(value);
    if (parsed !== 'malformed') {
      this.toolWriteLdif(LdifPut.VALUE, 'dn', utf8(parsed.dn));
      for (const attribute of parsed.attributes) {
        for (const item of attribute.values) {
          this.toolWriteLdif(
            this.ldif ? LdifPut.COMMENT : LdifPut.VALUE,
            this.ldif ? `${attribute.type}: ` : attribute.type,
            item,
          );
        }
      }
    }
    this.toolWriteLdif(LdifPut.COMMENT, '<== ', utf8(what));
  }

  private printDeref(value: Uint8Array | undefined): void {
    const results = C.parseDerefResponse(value);
    if (results === null) return;
    for (const result of results) {
      let text = `${result.derefAttr}: `;
      for (const entry of result.attrVals) {
        for (const item of entry.values) {
          const encoded = ldifIsNotPrintable(item);
          text += `<${entry.type}${encoded ? ':' : ''}=${encoded ? b64Ntop(item) : fromUtf8(item)}>;`;
        }
      }
      text += fromUtf8(result.derefValue);
      this.toolWriteLdif(LdifPut.COMMENT, null, utf8(text));
    }
  }

  private printWhatFailed(value: Uint8Array | undefined): void {
    if (value === undefined) return;
    this.toolWriteLdif(LdifPut.COMMENT, ' what failed:', null);
  }

  private printSyncState(value: Uint8Array | undefined): void {
    if (this.ldif) return;
    const state = C.parseSyncState(value);
    if (state === null) return;
    const uuid = C.formatUuid(state.uuid) ?? '(UUID malformed)';
    switch (state.state) {
      case C.LdapSync.PRESENT: this.printf(`# SyncState control, UUID ${uuid} present\n`); break;
      case C.LdapSync.ADD: this.printf(`# SyncState control, UUID ${uuid} added\n`); break;
      case C.LdapSync.MODIFY: this.printf(`# SyncState control, UUID ${uuid} modified\n`); break;
      case C.LdapSync.DELETE: this.printf(`# SyncState control, UUID ${uuid} deleted\n`); break;
      default: return;
    }
    if (state.cookie !== null) this.printf(this.cookieLines(state.cookie));
  }

  private printSyncDone(value: Uint8Array | undefined): void {
    if (this.ldif) return;
    const done = C.parseSyncDone(value);
    if (done === null) return;
    this.printf(`# SyncDone control refreshDeletes=${done.refreshDeletes ? 1 : 0}\n`);
    if (done.cookie !== null) this.printf(this.cookieLines(done.cookie));
  }

  private printAccountUsability(value: Uint8Array | undefined): void {
    const usability = C.parseAccountUsability(value);
    if (usability === null) return;
    let text = `${usability.available ? '' : 'not '}available`;
    if (usability.available) {
      text += usability.secondsRemaining === -1 ? ' and does not expire' : ` expire=${usability.secondsRemaining}`;
    } else {
      let added = 0;
      text += ' (';
      if (usability.inactive) { text += 'inactive '; added++; }
      if (usability.reset) { text += 'reset '; added++; }
      if (usability.expired) { text += 'expired '; added++; }
      if (added) {
        text = `${text.slice(0, -1)}) `;
      } else {
        text = text.slice(0, -1);
      }
      if (usability.remainingGrace !== -1) text += `grace=${usability.remainingGrace} `;
      if (usability.secondsBeforeUnlock !== -1) text += `seconds_before_unlock=${usability.secondsBeforeUnlock} `;
      text = text.slice(0, -1);
    }
    this.commentOrValue('accountUsability', text);
  }
}
