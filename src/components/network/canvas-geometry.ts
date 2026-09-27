export interface CanvasView {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export function screenToWorld(
  clientX: number, clientY: number, canvas: Pick<DOMRect, 'left' | 'top'>, view: CanvasView,
): CanvasPoint {
  return {
    x: (clientX - canvas.left - view.panX) / view.zoom,
    y: (clientY - canvas.top - view.panY) / view.zoom,
  };
}

export const NETWORK_CANVAS_ID = 'network-canvas';
