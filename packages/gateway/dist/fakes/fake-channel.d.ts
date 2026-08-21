import type { ChannelAdapter, ChannelMessage } from "../channel.js";
/** In-memory ChannelAdapter for tests: programmable send queue + deliver(). */
export declare class FakeChannel implements ChannelAdapter {
    readonly id: string;
    readonly sent: Array<{
        recipient: string;
        payload: unknown;
    }>;
    connected: boolean;
    connectCount: number;
    disconnectCount: number;
    private handler?;
    private nextMessageId;
    constructor(id?: string);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(recipient: string, payload: unknown): Promise<void>;
    onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void;
    /** Test driver: inject a message as if a real user sent it. */
    deliver(text: string, from?: string, ts?: number): Promise<void>;
    sentTexts(): string[];
}
//# sourceMappingURL=fake-channel.d.ts.map