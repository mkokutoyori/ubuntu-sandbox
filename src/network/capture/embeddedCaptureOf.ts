import type { FrameSource } from '@/network/hardware/PortTap';
import { simulationDate } from '@/network/core/SystemClock';
import { EmbeddedCaptureService } from './EmbeddedCapture';

const services = new WeakMap<object, EmbeddedCaptureService>();

export function embeddedCaptureOf(device: FrameSource): EmbeddedCaptureService {
  let service = services.get(device);
  if (service === undefined) {
    service = new EmbeddedCaptureService(device, () => simulationDate());
    services.set(device, service);
  }
  return service;
}
