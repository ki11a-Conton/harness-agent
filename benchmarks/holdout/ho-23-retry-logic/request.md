src/retry.js has an exponential backoff retry. Make the backoff configurable via options {maxRetries, baseDelayMs} and default to {3, 100}.
