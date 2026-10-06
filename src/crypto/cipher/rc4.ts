export class Rc4 {
  private readonly state = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new Error('RC4: key must not be empty');
    for (let index = 0; index < 256; index++) this.state[index] = index;
    let j = 0;
    for (let index = 0; index < 256; index++) {
      j = (j + this.state[index] + key[index % key.length]) & 0xff;
      const swap = this.state[index];
      this.state[index] = this.state[j];
      this.state[j] = swap;
    }
  }

  process(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + this.state[this.i]) & 0xff;
      const swap = this.state[this.i];
      this.state[this.i] = this.state[this.j];
      this.state[this.j] = swap;
      out[index] = data[index] ^ this.state[(this.state[this.i] + this.state[this.j]) & 0xff];
    }
    return out;
  }
}
