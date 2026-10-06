src/buffer.js caps the write buffer too low. spec/buffer-policy.txt states the cap in rows; read it and make src/buffer.js export that value.
