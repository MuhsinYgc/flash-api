# flash-api

Show sync server for `../flah-web`. Timeline, clock sync, YouTube audio analysis.

```bash
npm run dev
```

- HTTP: `http://localhost:3202` (`/snapshot`, `/sync`, `/command`, `/login`, `/youtube/*`)
- WebSocket: `ws://localhost:3202`

## Maç öncesi

- Port 3202 açık, frontend 3200 HTTPS
- Operator komutları `/login` token ister. Kullanıcı/şifre: `SHOW_OPERATOR_USER` / `SHOW_OPERATOR_PASS`
- yt-dlp: `npm install` sonrası macOS/Linux’ta standalone binary otomatik indirilir; diğer platformlarda Python **3.10+** gerekir
- Cache: OS temp `flash-youtube-audio` (30 dk sonra prune)

Taraftar snapshot/join auth’suzdur. `/command` auth zorunlu.
