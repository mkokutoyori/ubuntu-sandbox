/**
 * A machine's own bus is a `ForwardingEventBus`: it republishes every event
 * one-way onto the observer bus, and it republishes the SAME object. Code
 * that must hear an event whichever bus carried it therefore subscribes to
 * both — and then handles each event twice.
 *
 * Identity is the exact answer, and the only exact one: two genuinely
 * distinct messages are two objects, a forwarded message is one. Keying on
 * content and a timestamp instead would drop a real repetition — a router
 * logging `%LINEPROTO-5-UPDOWN` for two interfaces in the same millisecond
 * writes the same text twice, and both lines are true.
 *
 * The set holds no strong reference, so an event is forgotten as soon as
 * the bus itself is done with it.
 */
export class DuplicateEventFilter {
  private readonly seen = new WeakSet<object>();

  firstSight(event: object): boolean {
    if (this.seen.has(event)) return false;
    this.seen.add(event);
    return true;
  }
}
