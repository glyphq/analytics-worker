# glyphq analytics

Small Cloudflare Worker for Glyph download analytics.

`GET /downloads` returns the current wallet installer download total. `POST /downloads`
increments it. The counter lives in a Durable Object, so it is strongly consistent.

`GET /support?ttl=120` returns the current development-window progress and normalized
donations. The Worker calculates the percentage and caches the response in the edge cache;
`ttl` is clamped to 60–900 seconds. The navbar uses `ttl=300`; support components use
`ttl=120`.

On first use the counter seeds itself with the historical installer counts from
`glyphq/wallet` releases (`.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb`, `.rpm`). Updater
manifests (`latest.json`), signatures, checksums, and update archives are excluded.
After seeding, new downloads are counted by the Worker. Each IP is limited to 10 tracked
downloads per 10 minutes so the counter cannot be spammed.

The Worker is served at `https://analytics.glyphq.org` and on `https://glyphq.org/api/*`.
The landing uses the same-origin route. CORS allows all origins because the endpoints expose
no private data.

```sh
bun install
bun run check
bun run dev
bun run deploy # cf deploy
```
