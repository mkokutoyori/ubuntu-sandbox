import { VirtualTimeScheduler, getDefaultScheduler } from '@/events/Scheduler';

export async function simulatedWait(seconds: number): Promise<void> {
  const scheduler = getDefaultScheduler();
  if (scheduler instanceof VirtualTimeScheduler) {
    scheduler.advance(seconds * 1000);
    return;
  }
  await new Promise<void>((resolve) => { setTimeout(resolve, seconds * 1000); });
}
