export interface IcmpUnreachableReport {
  from: string;
  code: number | undefined;
  mtu: number | undefined;
}

const UNREACHABLE_MARKERS = ['Destination unreachable', 'Network is unreachable'];

export function readIcmpUnreachable(error: string | undefined): IcmpUnreachableReport | null {
  if (!error) return null;
  if (!UNREACHABLE_MARKERS.some(marker => error.includes(marker))) return null;
  const from = /from ([\d.]+)/.exec(error);
  const code = /code (\d+)/.exec(error);
  const mtu = /mtu (\d+)/.exec(error);
  return {
    from: from ? from[1] : '',
    code: code ? parseInt(code[1], 10) : undefined,
    mtu: mtu ? parseInt(mtu[1], 10) : undefined,
  };
}
