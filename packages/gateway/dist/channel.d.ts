/** A single message delivered from a chat channel into the gateway (§83). */
export interface ChannelMessage {
    channelId: string;
    from: string;
    text: string;
    messageId: string;
    ts: number;
}
/**
 * Transport-agnostic chat-channel adapter (§83). Implementations bind to a
 * concrete service (Telegram/Discord/Slack/Web/HTTP); the gateway only talks
 * to this surface, so channel-specific logic never reaches Core.
 */
export interface ChannelAdapter {
    readonly id: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(recipient: string, payload: unknown): Promise<void>;
    onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void;
}
//# sourceMappingURL=channel.d.ts.map