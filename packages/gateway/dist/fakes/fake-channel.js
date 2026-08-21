/** In-memory ChannelAdapter for tests: programmable send queue + deliver(). */
export class FakeChannel {
    id;
    sent = [];
    connected = false;
    connectCount = 0;
    disconnectCount = 0;
    handler;
    nextMessageId = 1;
    constructor(id = "fake-channel") {
        this.id = id;
    }
    async connect() {
        this.connected = true;
        this.connectCount += 1;
    }
    async disconnect() {
        this.connected = false;
        this.disconnectCount += 1;
    }
    async send(recipient, payload) {
        this.sent.push({ recipient, payload });
    }
    onMessage(handler) {
        this.handler = handler;
    }
    /** Test driver: inject a message as if a real user sent it. */
    deliver(text, from = "user-1", ts = Date.now()) {
        const handler = this.handler;
        if (handler === undefined) {
            throw new Error(`FakeChannel ${this.id} has no message handler (gateway not started)`);
        }
        const msg = {
            channelId: this.id,
            from,
            text,
            messageId: `msg_${this.nextMessageId}`,
            ts,
        };
        this.nextMessageId += 1;
        return Promise.resolve(handler(msg));
    }
    sentTexts() {
        return this.sent.map((s) => String(s.payload));
    }
}
//# sourceMappingURL=fake-channel.js.map