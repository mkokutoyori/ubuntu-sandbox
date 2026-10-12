import { useEffect, useRef, type RefObject } from 'react';

const PROBE_LENGTH = 40;

export interface GridSize {
  readonly rows: number;
  readonly cols: number;
}

function pixels(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function measureCell(element: HTMLElement): number {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none';
  probe.textContent = 'M'.repeat(PROBE_LENGTH);
  element.appendChild(probe);
  const cell = probe.getBoundingClientRect().width / PROBE_LENGTH;
  element.removeChild(probe);
  return cell;
}

export function measureGrid(element: HTMLElement, fixedLineHeight?: number): GridSize | null {
  const style = getComputedStyle(element);
  const cell = measureCell(element);
  const lineHeight = fixedLineHeight ?? (pixels(style.lineHeight) || pixels(style.fontSize) * 1.35);
  const width = element.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  const height = element.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
  if (!(cell > 0) || !(lineHeight > 0) || width <= 0 || height <= 0) return null;
  return { rows: Math.max(1, Math.floor(height / lineHeight)), cols: Math.max(1, Math.floor(width / cell)) };
}

export function useGridGeometry(
  ref: RefObject<HTMLElement | null>,
  owner: unknown,
  onSize: (size: GridSize) => void,
  fixedLineHeight?: number,
): void {
  const handler = useRef(onSize);
  handler.current = onSize;
  const observed = useRef<HTMLElement | null>(null);
  const observedOwner = useRef<unknown>(owner);
  const observer = useRef<ResizeObserver | null>(null);
  const reported = useRef<GridSize | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === observed.current && owner === observedOwner.current) return;
    observer.current?.disconnect();
    observer.current = null;
    observed.current = element;
    observedOwner.current = owner;
    reported.current = null;
    if (!element) return;
    const measure = () => {
      const size = measureGrid(element, fixedLineHeight);
      const last = reported.current;
      if (size === null || (last !== null && last.rows === size.rows && last.cols === size.cols)) return;
      reported.current = size;
      handler.current(size);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  });

  useEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
    observed.current = null;
  }, []);
}
