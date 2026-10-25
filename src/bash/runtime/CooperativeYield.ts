const SLICE_MS = 12;

let sliceStartedMs = performance.now();

function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof globalThis.MessageChannel === 'function') {
      const channel = new globalThis.MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    } else {
      globalThis.setTimeout(resolve, 0);
    }
  });
}

export async function yieldWhenSliceIsSpent(): Promise<void> {
  if (performance.now() - sliceStartedMs < SLICE_MS) return;
  await nextMacrotask();
  sliceStartedMs = performance.now();
}
