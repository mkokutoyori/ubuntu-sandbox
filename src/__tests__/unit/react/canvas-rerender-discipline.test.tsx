/**
 * @vitest-environment jsdom
 *
 * Canvas re-render discipline (rapport 09 audit, item #52).
 *
 * Two specific wasteful-re-render sources the audit flagged:
 *  - NetworkCanvas.tsx updated `mousePos` state on every mousemove even
 *    when idle (not connecting), re-rendering the whole canvas subtree
 *    for a value only the elastic connection-drawing line ever reads.
 *  - ConnectionLine/PacketAnimation were not memoized, so a parent
 *    re-render for an unrelated reason (e.g. the packet-animation loop)
 *    re-rendered every connection line even when its own props hadn't
 *    changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Profiler, useState } from 'react';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkCanvas } from '@/components/network/NetworkCanvas';
import { ConnectionLine } from '@/components/network/ConnectionLine';
import * as connectionLineLogic from '@/components/network/connection-line-logic';

beforeEach(() => {
  useNetworkStore.getState().clearAll();
});

afterEach(() => {
  useNetworkStore.getState().clearAll();
});

describe('NetworkCanvas — mousePos only tracked while connecting', () => {
  it('idle mouse movement (not connecting) does not trigger a re-render', () => {
    let renders = 0;
    render(
      <Profiler id="canvas" onRender={() => { renders++; }}>
        <NetworkCanvas />
      </Profiler>,
    );
    const canvas = document.getElementById('network-canvas')!;
    renders = 0; // ignore the mount commit
    fireEvent.mouseMove(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 20, clientY: 30 });
    fireEvent.mouseMove(canvas, { clientX: 50, clientY: 60 });
    expect(renders).toBe(0);
  });

  it('mouse movement DOES re-render while a connection is being drawn', () => {
    const a = useNetworkStore.getState().addDevice('linux-pc', 10, 10);
    const ifaceId = useNetworkStore.getState().getDevices()
      .find(d => d.id === a.id)!.interfaces[0].id;
    useNetworkStore.getState().startConnecting(a.id, ifaceId);

    let renders = 0;
    render(
      <Profiler id="canvas" onRender={() => { renders++; }}>
        <NetworkCanvas />
      </Profiler>,
    );
    const canvas = document.getElementById('network-canvas')!;
    renders = 0;
    fireEvent.mouseMove(canvas, { clientX: 10, clientY: 10 });
    expect(renders).toBeGreaterThan(0);
  });
});

describe('ConnectionLine — memoized against unrelated parent re-renders', () => {
  it('does not re-render when the parent re-renders with the same connection/devices props', () => {
    const a = useNetworkStore.getState().addDevice('linux-pc', 10, 10);
    const b = useNetworkStore.getState().addDevice('linux-pc', 200, 10);
    const devicesBefore = useNetworkStore.getState().getDevices();
    const ifaceA = devicesBefore.find(d => d.id === a.id)!.interfaces[0].id;
    const ifaceB = devicesBefore.find(d => d.id === b.id)!.interfaces[0].id;
    useNetworkStore.getState().addConnection(a.id, ifaceA, b.id, ifaceB);

    const connection = useNetworkStore.getState().connections[0];
    const devices = useNetworkStore.getState().getDevices();

    // computeConnectionPath only runs when ConnectionLineImpl's body
    // actually executes — a direct signal that memo() bailed out (or
    // didn't), unlike React.Profiler, which still fires once per commit
    // even for a subtree that bailed out below it.
    const pathSpy = vi.spyOn(connectionLineLogic, 'computeConnectionPath');

    function Harness() {
      const [, setTick] = useState(0);
      return (
        <>
          <svg>
            <ConnectionLine connection={connection} devices={devices} />
          </svg>
          <button onClick={() => setTick(t => t + 1)}>bump</button>
        </>
      );
    }
    const { getByText } = render(<Harness />);
    pathSpy.mockClear();
    // Re-renders Harness (and re-passes the SAME connection/devices refs)
    // for a reason entirely unrelated to this connection — exactly what
    // the 60x/sec packet-animation loop does to every ConnectionLine.
    fireEvent.click(getByText('bump'));
    expect(pathSpy).not.toHaveBeenCalled();
  });

  it('still re-renders when its own connection prop actually changes', () => {
    const a = useNetworkStore.getState().addDevice('linux-pc', 10, 10);
    const b = useNetworkStore.getState().addDevice('linux-pc', 200, 10);
    const devicesBefore = useNetworkStore.getState().getDevices();
    const ifaceA = devicesBefore.find(d => d.id === a.id)!.interfaces[0].id;
    const ifaceB = devicesBefore.find(d => d.id === b.id)!.interfaces[0].id;
    useNetworkStore.getState().addConnection(a.id, ifaceA, b.id, ifaceB);
    const devices = useNetworkStore.getState().getDevices();

    const pathSpy = vi.spyOn(connectionLineLogic, 'computeConnectionPath');
    function Harness({ connection }: { connection: ReturnType<typeof useNetworkStore.getState>['connections'][number] }) {
      return (
        <svg>
          <ConnectionLine connection={connection} devices={devices} />
        </svg>
      );
    }
    const first = useNetworkStore.getState().connections[0];
    const { rerender } = render(<Harness connection={first} />);
    pathSpy.mockClear();
    // A genuinely different connection object (e.g. status/type changed)
    // must still get through.
    rerender(<Harness connection={{ ...first, type: 'serial' }} />);
    expect(pathSpy).toHaveBeenCalled();
  });
});
