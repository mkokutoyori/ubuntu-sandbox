export type BlockMode = 'ecb' | 'cbc' | 'cfb' | 'ofb' | 'ctr';

export interface BlockPrimitive {
  readonly blockSize: number;
  encrypt(block: Uint8Array): Uint8Array;
  decrypt(block: Uint8Array): Uint8Array;
}

export type Direction = 'encrypt' | 'decrypt';

export interface ModeTransform {
  update(data: Uint8Array): Uint8Array;
}

export class ModeLengthError extends Error {
  constructor(readonly mode: BlockMode, readonly blockSize: number) {
    super(`${mode.toUpperCase()}: data must be a multiple of ${blockSize} bytes`);
  }
}

function xorInto(target: Uint8Array, mask: Uint8Array): void {
  for (let index = 0; index < target.length; index++) target[index] ^= mask[index];
}

function incrementBigEndian(counter: Uint8Array): void {
  for (let index = counter.length - 1; index >= 0; index--) {
    counter[index] = (counter[index] + 1) & 0xff;
    if (counter[index] !== 0) return;
  }
}

class ChainedBlocks implements ModeTransform {
  private chain: Uint8Array;

  constructor(
    private readonly mode: 'ecb' | 'cbc',
    private readonly primitive: BlockPrimitive,
    private readonly direction: Direction,
    iv: Uint8Array,
  ) {
    this.chain = Uint8Array.from(iv.subarray(0, primitive.blockSize));
  }

  update(data: Uint8Array): Uint8Array {
    const size = this.primitive.blockSize;
    if (data.length % size !== 0) throw new ModeLengthError(this.mode, size);
    const out = new Uint8Array(data.length);
    for (let at = 0; at < data.length; at += size) {
      const block = data.slice(at, at + size);
      if (this.mode === 'ecb') {
        out.set(this.direction === 'encrypt' ? this.primitive.encrypt(block) : this.primitive.decrypt(block), at);
      } else if (this.direction === 'encrypt') {
        xorInto(block, this.chain);
        this.chain = this.primitive.encrypt(block);
        out.set(this.chain, at);
      } else {
        const plain = this.primitive.decrypt(block);
        xorInto(plain, this.chain);
        out.set(plain, at);
        this.chain = block;
      }
    }
    return out;
  }
}

class KeystreamBlocks implements ModeTransform {
  private register: Uint8Array;
  private keystream: Uint8Array;
  private position: number;

  constructor(
    private readonly mode: 'cfb' | 'ofb' | 'ctr',
    private readonly primitive: BlockPrimitive,
    private readonly direction: Direction,
    iv: Uint8Array,
  ) {
    this.register = Uint8Array.from(iv.subarray(0, primitive.blockSize));
    this.keystream = new Uint8Array(primitive.blockSize);
    this.position = primitive.blockSize;
  }

  private refill(): void {
    this.keystream = this.primitive.encrypt(this.register);
    this.position = 0;
    if (this.mode === 'ofb') this.register = Uint8Array.from(this.keystream);
    else if (this.mode === 'ctr') incrementBigEndian(this.register);
  }

  update(data: Uint8Array): Uint8Array {
    const size = this.primitive.blockSize;
    const out = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) {
      if (this.position === size) this.refill();
      const input = data[index];
      const output = input ^ this.keystream[this.position];
      out[index] = output;
      if (this.mode === 'cfb') this.register[this.position] = this.direction === 'encrypt' ? output : input;
      this.position++;
    }
    return out;
  }
}

export function createModeTransform(mode: BlockMode, primitive: BlockPrimitive, direction: Direction, iv: Uint8Array): ModeTransform {
  return mode === 'ecb' || mode === 'cbc' ? new ChainedBlocks(mode, primitive, direction, iv) : new KeystreamBlocks(mode, primitive, direction, iv);
}

export function pkcs7Pad(data: Uint8Array, blockSize: number): Uint8Array {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}

export function pkcs7Unpad(data: Uint8Array, blockSize: number): Uint8Array {
  const pad = data[data.length - 1];
  if (data.length === 0 || data.length % blockSize !== 0 || pad === 0 || pad > blockSize) throw new Error('bad padding');
  for (let index = data.length - pad; index < data.length; index++) if (data[index] !== pad) throw new Error('bad padding');
  return data.subarray(0, data.length - pad);
}
