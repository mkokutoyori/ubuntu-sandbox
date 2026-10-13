import { useCallback, useEffect, useState } from 'react';
import type { EditorScreen } from '@/network/devices/linux/editors/screen/EditorScreen';

export function useHeldScreen(engine: { readonly screen: EditorScreen }): {
  readonly advance: () => void;
  readonly shown: (live: EditorScreen) => EditorScreen;
} {
  const [epoch, setEpoch] = useState(0);
  const [settledEpoch, setSettledEpoch] = useState(-1);

  useEffect(() => {
    const hold = engine.screen.hold;
    if (hold === undefined) return undefined;
    const timer = setTimeout(() => setSettledEpoch(epoch), hold.millis);
    return () => clearTimeout(timer);
  }, [engine, epoch]);

  const advance = useCallback(() => setEpoch((n) => n + 1), []);
  const shown = useCallback(
    (live: EditorScreen) => (live.hold !== undefined && settledEpoch === epoch ? live.hold.then : live),
    [epoch, settledEpoch],
  );
  return { advance, shown };
}
