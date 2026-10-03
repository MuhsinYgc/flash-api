# flash-api

Show sync server for the flash frontend (`../flah-web`). Distributes timeline cues and clock sync over WebSocket and HTTP.

```bash
npm run dev
```

- WebSocket: ws://localhost:3202
- HTTP: http://localhost:3202/snapshot, /command, etc.

The frontend proxies `/show-http/*` to this server.
