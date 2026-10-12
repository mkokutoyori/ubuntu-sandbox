export const UTMPX_SIZE = 384;

export const UT = {
  EMPTY: 0,
  RUN_LVL: 1,
  BOOT_TIME: 2,
  NEW_TIME: 3,
  OLD_TIME: 4,
  INIT_PROCESS: 5,
  LOGIN_PROCESS: 6,
  USER_PROCESS: 7,
  DEAD_PROCESS: 8,
  ACCOUNTING: 9,
  SHUTDOWN_TIME: 254,
} as const;

const OFFSET = {
  type: 0,
  pid: 4,
  line: 8,
  id: 40,
  user: 44,
  host: 76,
  exitTermination: 332,
  exitStatus: 334,
  session: 336,
  seconds: 340,
  microseconds: 344,
  address: 348,
} as const;

export const LINE_SIZE = 32;
export const ID_SIZE = 4;
export const USER_SIZE = 32;
export const HOST_SIZE = 256;

export class Utmpx {
  readonly bytes: Uint8Array;

  constructor(bytes?: Uint8Array) {
    this.bytes = bytes ? Uint8Array.from(bytes) : new Uint8Array(UTMPX_SIZE);
  }

  private get view(): DataView {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get type(): number { return this.view.getInt16(OFFSET.type, true); }
  set type(value: number) { this.view.setInt16(OFFSET.type, value, true); }
  get pid(): number { return this.view.getInt32(OFFSET.pid, true); }
  set pid(value: number) { this.view.setInt32(OFFSET.pid, value, true); }
  get session(): number { return this.view.getInt32(OFFSET.session, true); }
  set session(value: number) { this.view.setInt32(OFFSET.session, value, true); }
  get seconds(): number { return this.view.getInt32(OFFSET.seconds, true); }
  set seconds(value: number) { this.view.setInt32(OFFSET.seconds, value | 0, true); }
  get microseconds(): number { return this.view.getInt32(OFFSET.microseconds, true); }
  set microseconds(value: number) { this.view.setInt32(OFFSET.microseconds, value | 0, true); }
  get exitTermination(): number { return this.view.getInt16(OFFSET.exitTermination, true); }
  set exitTermination(value: number) { this.view.setInt16(OFFSET.exitTermination, value, true); }
  get exitStatus(): number { return this.view.getInt16(OFFSET.exitStatus, true); }
  set exitStatus(value: number) { this.view.setInt16(OFFSET.exitStatus, value, true); }

  field(name: 'line' | 'id' | 'user' | 'host'): Uint8Array {
    const size = { line: LINE_SIZE, id: ID_SIZE, user: USER_SIZE, host: HOST_SIZE }[name];
    return this.bytes.subarray(OFFSET[name], OFFSET[name] + size);
  }

  setField(name: 'line' | 'id' | 'user' | 'host', value: string): void {
    const target = this.field(name);
    target.fill(0);
    const encoded = new TextEncoder().encode(value);
    target.set(encoded.subarray(0, target.length));
  }

  setLineBytes(value: Uint8Array): void {
    const target = this.field('line');
    target.fill(0);
    target.set(value.subarray(0, target.length));
  }

  text(name: 'line' | 'id' | 'user' | 'host'): string {
    const raw = this.field(name);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end));
  }

  get address(): Uint8Array { return this.bytes.subarray(OFFSET.address, OFFSET.address + 16); }

  setAddress(value: Uint8Array): void {
    this.bytes.fill(0, OFFSET.address, OFFSET.address + 16);
    this.bytes.set(value.subarray(0, 16), OFFSET.address);
  }
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

export function binaryStringToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
