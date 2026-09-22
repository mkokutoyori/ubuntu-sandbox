const CORPS = { encode: new TextEncoder(), decode: new TextDecoder() };

export enum OracleNetCallId {
  Logon = 1,
  Execute = 2,
  Logoff = 3,
  ExecuteStatement = 4,
  /** LNS -> RFS : le primaire expedie un journal archive a la standby. */
  ShipRedo = 5,
}

export enum OracleNetCallStatus {
  Ok = 0,
  Error = 1,
}

export interface OracleNetClientIdentity {
  readonly osUser: string;
  readonly osGroup: string;
  readonly hostname: string;
  readonly terminal: string;
  readonly program: string;
}

export interface OracleNetLogonRequest {
  readonly username: string;
  readonly password: string;
  readonly asSysdba: boolean;
  readonly identity: OracleNetClientIdentity;
  readonly proxyUser?: string;
}

export interface OracleNetExecuteRequest {
  readonly sql: string;
}

export interface OracleNetStatementRequest {
  readonly statement: unknown;
}

/**
 * L'en-tete NS porte sa longueur sur 16 bits : un journal archive entier
 * ne tient pas dans un paquet. Un envoi se DECOUPE, comme Oracle Net
 * decoupe toute donnee plus grande que la SDU negociee, et le RFS
 * rassemble.
 */
export const REDO_CHUNK_BYTES = 4000;

export interface OracleNetShipRedoRequest {
  readonly thread: number;
  readonly sequence: number;
  readonly name: string;
  readonly scn: number;
  readonly body: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly fromDbUniqueName: string;
}

export interface OracleNetColumn {
  readonly name: string;
  readonly dataType: string;
}

export interface OracleNetResult {
  readonly columns: OracleNetColumn[];
  readonly rows: unknown[][];
  readonly affectedRows?: number;
  readonly isQuery: boolean;
  readonly message?: string;
}

export type OracleNetRequest =
  | { readonly call: OracleNetCallId.Logon; readonly body: OracleNetLogonRequest }
  | { readonly call: OracleNetCallId.Execute; readonly body: OracleNetExecuteRequest }
  | { readonly call: OracleNetCallId.ExecuteStatement; readonly body: OracleNetStatementRequest }
  | { readonly call: OracleNetCallId.ShipRedo; readonly body: OracleNetShipRedoRequest }
  | { readonly call: OracleNetCallId.Logoff; readonly body: Record<string, never> };

export type OracleNetResponse =
  | { readonly status: OracleNetCallStatus.Ok; readonly result: OracleNetResult | null }
  | { readonly status: OracleNetCallStatus.Error; readonly error: string };

export function encodeRequest(request: OracleNetRequest): Uint8Array {
  const body = CORPS.encode.encode(JSON.stringify(request.body));
  const out = new Uint8Array(1 + body.length);
  out[0] = request.call;
  out.set(body, 1);
  return out;
}

export function decodeRequest(payload: Uint8Array): OracleNetRequest | null {
  if (payload.length < 1) return null;
  const call = payload[0] as OracleNetCallId;
  let body: unknown;
  try {
    body = JSON.parse(CORPS.decode.decode(payload.subarray(1)) || '{}');
  } catch {
    return null;
  }
  if (call === OracleNetCallId.Logon) {
    return { call, body: body as OracleNetLogonRequest };
  }
  if (call === OracleNetCallId.Execute) {
    return { call, body: body as OracleNetExecuteRequest };
  }
  if (call === OracleNetCallId.ExecuteStatement) {
    return { call, body: body as OracleNetStatementRequest };
  }
  if (call === OracleNetCallId.ShipRedo) {
    return { call, body: body as OracleNetShipRedoRequest };
  }
  if (call === OracleNetCallId.Logoff) {
    return { call, body: {} };
  }
  return null;
}

export function encodeResponse(response: OracleNetResponse): Uint8Array {
  const payload = response.status === OracleNetCallStatus.Ok
    ? JSON.stringify(response.result)
    : JSON.stringify({ error: response.error });
  const body = CORPS.encode.encode(payload);
  const out = new Uint8Array(1 + body.length);
  out[0] = response.status;
  out.set(body, 1);
  return out;
}

export function decodeResponse(payload: Uint8Array): OracleNetResponse | null {
  if (payload.length < 1) return null;
  const status = payload[0] as OracleNetCallStatus;
  let parsed: unknown;
  try {
    parsed = JSON.parse(CORPS.decode.decode(payload.subarray(1)) || 'null');
  } catch {
    return null;
  }
  if (status === OracleNetCallStatus.Ok) {
    return { status, result: parsed as OracleNetResult | null };
  }
  if (status === OracleNetCallStatus.Error) {
    const error = (parsed as { error?: string } | null)?.error;
    return { status, error: error ?? 'ORA-03113: end-of-file on communication channel' };
  }
  return null;
}
