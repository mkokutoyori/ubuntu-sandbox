export class HeapSim {
  private next: number;

  constructor(base = 0x55d3b1c4e000) {
    this.next = base;
  }

  allocate(size: number): number {
    const address = this.next;
    this.next += Math.ceil((size + 24) / 16) * 16;
    return address;
  }
}
