src/bytes.js formats sizes with a decimal divisor and never leaves the KB unit: formatBytes(2048) must be "2.0 KB" and formatBytes(1048576) must be "1.0 MB". Fix src/bytes.js.
