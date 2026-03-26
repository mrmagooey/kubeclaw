# Intent: Add HTTP channel import

Add `import './http.js';` to the channel barrel file so the HTTP module
self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
