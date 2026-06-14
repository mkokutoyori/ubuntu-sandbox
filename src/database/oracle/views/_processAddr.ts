export function processAddr(pid: number): string {
  return `00000000${(0x7f000000 + pid * 0x40).toString(16).padStart(8, '0').toUpperCase()}`;
}
