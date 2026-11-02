import { nullPaddedText } from './TcpdumpHex';
import { unsignedRelativeTime } from './TcpdumpTime';

type AddressName = (address: string) => string;

const TRUNCATED = ' [|hsrp]';
const AUTH_BYTES = 8;
const OPCODES: readonly string[] = ['hello', 'coup', 'resign'];
const STATES: Readonly<Record<number, string>> = { 0: 'initial', 1: 'learn', 2: 'listen', 4: 'speak', 8: 'standby', 16: 'active' };

class Truncated extends Error {}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function print(bytes: readonly number[], length: number, verbose: number, name: AddressName, emit: (text: string) => void): void {
  const version = u8(bytes, 0);
  emit(`HSRPv${version}`);
  if (version !== 0) return;
  const opcode = u8(bytes, 1);
  emit(`-${OPCODES[opcode] ?? `unknown (${opcode})`} ${length}: `);
  const state = u8(bytes, 2);
  emit(`state=${STATES[state] ?? `Unknown (${state})`} `);
  emit(`group=${u8(bytes, 6)} `);
  const reserved = u8(bytes, 7);
  if (reserved !== 0) emit(`[reserved=${reserved}!] `);
  u8(bytes, 19);
  emit(`addr=${name(`${bytes[16]}.${bytes[17]}.${bytes[18]}.${bytes[19]}`)}`);
  if (verbose < 1) return;
  emit(` hellotime=${unsignedRelativeTime(u8(bytes, 3))}`);
  emit(` holdtime=${unsignedRelativeTime(u8(bytes, 4))}`);
  emit(` priority=${u8(bytes, 5)}`);
  emit(` auth="${nullPaddedText(bytes.slice(8, 8 + AUTH_BYTES))}"`);
}

export function hsrpText(bytes: readonly number[], length: number, verbose: number, name: AddressName): string {
  let text = '';
  try {
    print(bytes, length, verbose, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return text + TRUNCATED;
    throw error;
  }
  return text;
}
