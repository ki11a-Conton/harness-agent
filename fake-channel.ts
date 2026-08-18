import type { ChannelAdapter, ChannelMessage } from "../channel.js";

/** In-memory ChannelAdapter for tests: programmable send queue + deliver(). */
export class FakeChannel implements ChannelAdapter {
  readonly id: string;
  readonly sent: Array<{ recipient: string; payload: unknown }> = [];
  connected = false;
  connectCount = 0;
  disconnectCount = 0;
  private handler?: (msg: ChannelMessage) => void | Promise<void>;
  private nextMessageId = 1;

  constructor(id = "fake-channel") {
    this.id = id;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCount += 1;
  }

  async send(recipient: string, payload: unknown): Promise<void> {
    this.sent.push({ recipient, payload });
  }

  onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Test driver: inject a message as if a real user sent it. */
  deliver(text: string, from = "user-1", ts = Date.now()): Promise<void> {
    const handler = this.handler;
    if (handler === undefined) {
      throw new Error(`FakeChannel ${this.id} has no message handler (gateway not started)`);
    }
    const msg: ChannelMessage = {
      channelId: this.id,
      from,
      text,
      messageId: `msg_${this.nextMessageId}`,
      ts,
    };
    this.nextMessageId += 1;
    return Promise.resolve(handler(msg));
  }

  sentTexts(): string[] {
    return this.sent.map((s) => String(s.payload));
  }
}
