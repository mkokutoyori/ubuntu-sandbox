export const PORT_TACACS = 49;

export type TacacsPacketType = 'authen' | 'author' | 'acct';

export const TACACS_TYPE: Record<TacacsPacketType, number> = {
  authen: 1, author: 2, acct: 3,
};

export type TacacsAuthenAction = 'login' | 'chpass' | 'sendauth';
export const TACACS_AUTHEN_ACTION: Record<TacacsAuthenAction, number> = {
  login: 1, chpass: 2, sendauth: 4,
};

export type TacacsAuthenType =
  | 'ascii' | 'pap' | 'chap' | 'arap' | 'mschap' | 'mschapv2';
export const TACACS_AUTHEN_TYPE: Record<TacacsAuthenType, number> = {
  ascii: 1, pap: 2, chap: 3, arap: 4, mschap: 5, mschapv2: 6,
};

export type TacacsAuthenService =
  | 'none' | 'login' | 'enable' | 'ppp' | 'arap' | 'pt' | 'rcmd' | 'x25' | 'nasi' | 'fwproxy';
export const TACACS_AUTHEN_SERVICE: Record<TacacsAuthenService, number> = {
  none: 0, login: 1, enable: 2, ppp: 3, arap: 4, pt: 5, rcmd: 6, x25: 7, nasi: 8, fwproxy: 9,
};

export type TacacsAuthenStatus =
  | 'pass' | 'fail' | 'getdata' | 'getuser' | 'getpass' | 'restart' | 'error' | 'follow';
export const TACACS_AUTHEN_STATUS: Record<TacacsAuthenStatus, number> = {
  pass: 1, fail: 2, getdata: 3, getuser: 4, getpass: 5, restart: 6, error: 7, follow: 0x21,
};

export type TacacsAuthorStatus =
  | 'pass-add' | 'pass-repl' | 'fail' | 'error' | 'follow';
export const TACACS_AUTHOR_STATUS: Record<TacacsAuthorStatus, number> = {
  'pass-add': 1, 'pass-repl': 2, fail: 0x10, error: 0x11, follow: 0x21,
};

export type TacacsAcctStatus = 'success' | 'error' | 'follow';
export const TACACS_ACCT_STATUS: Record<TacacsAcctStatus, number> = {
  success: 1, error: 2, follow: 0x21,
};

export type TacacsAcctFlag = 'start' | 'stop' | 'watchdog';
export const TACACS_ACCT_FLAG: Record<TacacsAcctFlag, number> = {
  start: 0x02, stop: 0x04, watchdog: 0x08,
};

export interface TacacsHeader {
  version: 0xc1;
  type: number;
  seqNo: number;
  flags: number;
  sessionId: number;
  length: number;
}

export interface TacacsAuthenStart {
  type: 'tacacs-authen-start';
  action: TacacsAuthenAction;
  privLvl: number;
  authenType: TacacsAuthenType;
  service: TacacsAuthenService;
  user: string;
  port: string;
  remoteAddress: string;
  data: string;
}

export interface TacacsAuthenContinue {
  type: 'tacacs-authen-continue';
  flags: number;
  userMsg: string;
  data: string;
}

export interface TacacsAuthenReply {
  type: 'tacacs-authen-reply';
  status: TacacsAuthenStatus;
  flags: number;
  serverMsg: string;
  data: string;
}

export interface TacacsAuthorRequest {
  type: 'tacacs-author-request';
  authenMethod: number;
  privLvl: number;
  authenType: TacacsAuthenType;
  service: TacacsAuthenService;
  user: string;
  port: string;
  remoteAddress: string;
  args: string[];
}

export interface TacacsAuthorReply {
  type: 'tacacs-author-reply';
  status: TacacsAuthorStatus;
  args: string[];
  serverMsg: string;
  data: string;
}

export interface TacacsAcctRequest {
  type: 'tacacs-acct-request';
  flags: TacacsAcctFlag[];
  authenMethod: number;
  privLvl: number;
  authenType: TacacsAuthenType;
  service: TacacsAuthenService;
  user: string;
  port: string;
  remoteAddress: string;
  args: string[];
}

export interface TacacsAcctReply {
  type: 'tacacs-acct-reply';
  status: TacacsAcctStatus;
  serverMsg: string;
  data: string;
}

export type TacacsBody =
  | TacacsAuthenStart
  | TacacsAuthenContinue
  | TacacsAuthenReply
  | TacacsAuthorRequest
  | TacacsAuthorReply
  | TacacsAcctRequest
  | TacacsAcctReply;

export interface TacacsPacket {
  type: 'tacacs';
  header: TacacsHeader;
  body: TacacsBody;
}

export interface TacacsServerConfig {
  ip: string;
  port: number;
  sharedSecret: string;
  timeoutMs: number;
}

export interface TacacsUser {
  username: string;
  password: string;
  privLvl: number;
  permittedCommands: Set<string>;
}

export interface TacacsClientConfig {
  enabled: boolean;
  servers: TacacsServerConfig[];
  nasIdentifier: string | null;
  sourceInterface: string | null;
}

export interface TacacsServerAgentConfig {
  enabled: boolean;
  port: number;
  sharedSecret: string;
  users: Map<string, TacacsUser>;
  acctLog: Array<{ user: string; cmd: string; flags: TacacsAcctFlag[]; ts: number }>;
}

export function createDefaultClientConfig(): TacacsClientConfig {
  return { enabled: true, servers: [], nasIdentifier: null, sourceInterface: null };
}

export function createDefaultServerConfig(secret = 'shared'): TacacsServerAgentConfig {
  return {
    enabled: true, port: PORT_TACACS, sharedSecret: secret,
    users: new Map(), acctLog: [],
  };
}

export function defaultServerEntry(ip: string, sharedSecret: string): TacacsServerConfig {
  return { ip, port: PORT_TACACS, sharedSecret, timeoutMs: 5000 };
}

export function defaultUser(username: string, password: string, privLvl = 1): TacacsUser {
  return { username, password, privLvl, permittedCommands: new Set() };
}
