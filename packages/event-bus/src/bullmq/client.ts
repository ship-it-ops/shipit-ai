import type { CanonicalEntity, EventBusClient, EventHandler } from '@shipit-ai/shared';
import type { EventBusConfig } from '../config.js';
import { resolveConfig } from '../config.js';
import { EventBusProducer } from './producer.js';
import { EventBusConsumer } from './consumer.js';
import { EventBusReplay } from './replay.js';

export class BullMQEventBusClient implements EventBusClient {
  private readonly producer: EventBusProducer;
  private readonly consumer: EventBusConsumer;
  private readonly replay_: EventBusReplay;

  constructor(config: EventBusConfig) {
    const resolved = resolveConfig(config);
    this.producer = new EventBusProducer(resolved);
    this.consumer = new EventBusConsumer(resolved);
    this.replay_ = new EventBusReplay(resolved);
  }

  async publish(events: CanonicalEntity[], connectorId: string): Promise<void> {
    await this.producer.publish(events, connectorId);
  }

  async subscribe(handler: EventHandler): Promise<void> {
    await this.consumer.subscribe(handler);
  }

  async replay(fromTimestamp: string): Promise<void> {
    await this.replay_.replay(fromTimestamp);
  }

  async close(): Promise<void> {
    await Promise.all([this.producer.close(), this.consumer.close(), this.replay_.close()]);
  }
}
