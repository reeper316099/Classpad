import { EventEmitter } from 'node:events';

export interface ActivityEvent {
  id: number;
  at: string;
  kind: 'created' | 'updated' | 'deleted' | 'external' | 'invalid-edit';
  collection: string;
  entityId?: string;
  /** Never includes content, only metadata. */
  message?: string;
}

/** In-process event bus with a small ring buffer for /activity and SSE. */
export class Bus extends EventEmitter {
  private seq = 0;
  private ring: ActivityEvent[] = [];

  publish(e: Omit<ActivityEvent, 'id' | 'at'>): ActivityEvent {
    const ev = { ...e, id: ++this.seq, at: new Date().toISOString() };
    this.ring.push(ev);
    if (this.ring.length > 200) this.ring.shift();
    this.emit('event', ev);
    return ev;
  }

  recent(limit = 50): ActivityEvent[] {
    return this.ring.slice(-limit).reverse();
  }
}
