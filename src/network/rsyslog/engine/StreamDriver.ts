import { RS_RET } from './Log';
import type { ModuleContext, RuntimeLog } from './Modules';
import { numberParam, stringParam, arrayParam, type ParamValues } from '../config/Params';
import { parseAuthMode, parsePermitExpired, validatePermittedPeers, type NetstreamAuthMode, type PermitExpiredCerts } from './PeerAuth';

export const RS_RET_INVALID_DRVR_MODE = -2081;

const BUILT_IN_OPENSSL_ENGINES = new Set(['dynamic', 'rdrand']);

export interface StreamTlsExtras {
  permitExpired: string | null;
  permittedPeers: string[];
  checkExtendedKeyPurpose: boolean;
  prioritizeSan: boolean;
  verifyDepth: number | null;
  revocationCheck: boolean;
  caFile: string | null;
  caExtraFiles: string | null;
  crlFile: string | null;
  certFile: string | null;
  keyFile: string | null;
  remoteSni: string | null;
  priorityString: string | null;
}

export interface StreamTlsOptions {
  readonly driver: string;
  readonly role: 'client' | 'server';
  readonly authMode: NetstreamAuthMode;
  readonly permitExpired: PermitExpiredCerts;
  readonly permittedPeers: readonly string[];
  readonly checkExtendedKeyPurpose: boolean;
  readonly prioritizeSan: boolean;
  readonly verifyDepth: number | null;
  readonly revocationCheck: boolean;
  readonly caFile: string | null;
  readonly caExtraFiles: string | null;
  readonly crlFile: string | null;
  readonly certFile: string | null;
  readonly keyFile: string | null;
  readonly remoteSni: string | null;
  readonly priorityString: string | null;
  readonly connectHost: string | null;
  readonly runtime: RuntimeLog;
}

export function emptyTlsExtras(): StreamTlsExtras {
  return {
    permitExpired: null, permittedPeers: [], checkExtendedKeyPurpose: false, prioritizeSan: false, verifyDepth: null, revocationCheck: false,
    caFile: null, caExtraFiles: null, crlFile: null, certFile: null, keyFile: null, remoteSni: null, priorityString: null,
  };
}

export function copyTlsExtras(source: StreamTlsExtras): StreamTlsExtras {
  return { ...source, permittedPeers: [...source.permittedPeers] };
}

function flag(values: ParamValues, key: string): boolean | undefined {
  const value = values.get(key);
  return value?.kind === 'N' ? value.n !== 0 : undefined;
}

export function readTlsExtras(target: StreamTlsExtras, values: ParamValues): void {
  target.permitExpired = stringParam(values, 'streamdriver.permitexpiredcerts') ?? target.permitExpired;
  const peers = arrayParam(values, 'permittedpeer') ?? arrayParam(values, 'streamdriver.permittedpeers');
  if (peers !== undefined) target.permittedPeers = [...peers];
  const legacyPeers = stringParam(values, 'streamdriverpermittedpeers');
  if (legacyPeers !== undefined) target.permittedPeers = legacyPeers.split(',').map((peer) => peer.trim()).filter((peer) => peer !== '');
  target.checkExtendedKeyPurpose = flag(values, 'streamdriver.checkextendedkeypurpose') ?? target.checkExtendedKeyPurpose;
  target.prioritizeSan = flag(values, 'streamdriver.prioritizesan') ?? target.prioritizeSan;
  target.verifyDepth = numberParam(values, 'streamdriver.tlsverifydepth') ?? target.verifyDepth;
  target.revocationCheck = flag(values, 'streamdriver.tlsrevocationcheck') ?? target.revocationCheck;
  target.caFile = stringParam(values, 'streamdriver.cafile') ?? target.caFile;
  target.caExtraFiles = stringParam(values, 'streamdriver.caextrafiles') ?? target.caExtraFiles;
  target.crlFile = stringParam(values, 'streamdriver.crlfile') ?? target.crlFile;
  target.certFile = stringParam(values, 'streamdriver.certfile') ?? target.certFile;
  target.keyFile = stringParam(values, 'streamdriver.keyfile') ?? target.keyFile;
  target.remoteSni = stringParam(values, 'streamdriverremotesni') ?? stringParam(values, 'streamdriver.remotesni') ?? target.remoteSni;
  target.priorityString = stringParam(values, 'gnutlsprioritystring') ?? target.priorityString;
}

export interface StreamDriverChoice {
  readonly mode: number;
  readonly driver: string | null;
  readonly authMode: string | null;
}

export function resolveStreamTls(
  choice: StreamDriverChoice, extras: StreamTlsExtras, context: ModuleContext, label: string, role: 'client' | 'server',
): StreamTlsOptions | null | false {
  const driver = (choice.driver ?? context.settings.defaultNetstreamDriver ?? 'ptcp').toLowerCase();
  const settings = context.settings;
  if (driver === 'ptcp') {
    if (choice.mode !== 0) {
      context.runtime.error(`error: driver mode ${choice.mode} not supported by ptcp netstream driver`, RS_RET_INVALID_DRVR_MODE);
      return false;
    }
    return null;
  }
  if (!context.netstreamDriverAvailable(driver)) {
    const path = `${context.moduleDirectory().replace(/\/?$/, '/')}lmnsd_${driver}.so`;
    context.runtime.error(`${label}: could not load netstream driver '${driver}', errors: trying to load module ${path}: ${path}: cannot open shared object file: No such file or directory`, RS_RET.MODULE_LOAD_ERR_DLOPEN);
    return false;
  }
  if (choice.mode !== 0 && choice.mode !== 1) {
    context.runtime.error(`error: driver mode ${choice.mode} not supported by ${driver} netstream driver`, RS_RET_INVALID_DRVR_MODE);
    return false;
  }
  if (choice.mode === 0) return null;
  const authMode = parseAuthMode(choice.authMode);
  if (authMode === null) {
    context.runtime.error(`error: authentication mode '${choice.authMode}' not supported by ${driver} netstream driver`, RS_RET.VALUE_NOT_SUPPORTED);
    return false;
  }
  const permitExpired = parsePermitExpired(extras.permitExpired);
  if (permitExpired === null) {
    context.runtime.error(`error: permitexpiredcerts mode '${extras.permitExpired}' not supported by ${driver} netstream driver`, RS_RET.VALUE_NOT_SUPPORTED);
    return false;
  }
  if (!validatePermittedPeers(extras.permittedPeers, context.runtime)) return false;
  const engine = settings.defaultOpensslEngine;
  if (driver === 'ossl' && engine !== null && !BUILT_IN_OPENSSL_ENGINES.has(engine)) {
    context.runtime.error(`error: ENGINE_init failed to load Engine '${engine}'ossl netstream driver`, RS_RET.VALUE_NOT_SUPPORTED);
  }
  return {
    driver, role, authMode, permitExpired, permittedPeers: [...extras.permittedPeers], checkExtendedKeyPurpose: extras.checkExtendedKeyPurpose,
    prioritizeSan: extras.prioritizeSan, verifyDepth: extras.verifyDepth, revocationCheck: extras.revocationCheck,
    caFile: extras.caFile ?? settings.defaultNetstreamDriverCaFile, caExtraFiles: extras.caExtraFiles ?? settings.netstreamDriverCaExtraFiles,
    crlFile: extras.crlFile ?? settings.defaultNetstreamDriverCrlFile, certFile: extras.certFile ?? settings.defaultNetstreamDriverCertFile,
    keyFile: extras.keyFile ?? settings.defaultNetstreamDriverKeyFile, remoteSni: extras.remoteSni, priorityString: extras.priorityString,
    connectHost: null, runtime: context.runtime,
  };
}
