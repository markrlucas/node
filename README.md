# node (COB Heatmap + WebSocket tools)

Live demo: https://realm.sanixlab.com

Short description

- Lightweight Express server that serves a public front-end for consolidated order book (COB) heatmaps and related widgets.
- Includes a high-performance chart plugin at `public/charts/pluginChartCOB.js` which renders order-book heatmaps and an optional VWAP/price line using ECharts.

Key files

- `node.js` — main Express server (serves `public/` and `includes/`).
- `public/` — static frontend: HTML pages, charts, images and client JS.
- `public/charts/pluginChartCOB.js` — main heatmap plugin used by the demo pages.
- `includes/` — small helper scripts used by some pages.
- `services/` — backend utilities and websocket helpers.

06/09/2025 Note: service/trade-engine/plugins - contains ports of popular pinescript scripts and plugins I will get working on the live demo over the next few weeks.

Quick start (local)

1. Install dependencies

   ```powershell
   npm install
   ```

2. Start the server

   ```powershell
   node node.js
   ```

3. Open the demo in a browser: `http://localhost:3000` (or the configured `PORT`).

Notes and configuration

- The server serves everything in `public/` via `express.static` and exposes `includes/` at `/includes`.
- To change the port, set the `PORT` environment variable.
- The demo running at `https://realm.sanixlab.com` is the live instance — use it to compare behavior when testing locally.

Troubleshooting

- "Cannot GET /" — ensure your server is running and that `node.js` has an index route (some pages live directly under `public/` such as `graphs-COB.html`).
- 404s for static assets (e.g. `charts/pluginChartCOB.js` or `img/pencil-icon.svg`) indicate either missing files in `public/` or an overly-restrictive server route. The server in this repo serves `public/` recursively; make sure requested filenames exist under `public/`.
- MIME-type errors for `.js` often mean a server returned an HTML error page (404) instead of the JS file — check the network panel to see the response body.
- If ECharts throws `getRawIndex` errors during rapid updates, try increasing the chart update debounce or make sure `setOption` merges options instead of replacing series models. The repo already uses safer merge semantics.

Development notes (charts)

- `public/charts/pluginChartCOB.js` contains runtime options near the top of the file. Example options you can tweak in the constructor:
  - `priceRange`, `pricePrecision`, `priceGrouping` — controls Y-axis buckets.
  - `maxHistory`, `maxHeatmapHistory` — control display vs. stored history.
  - `percentageThresholdForLabel`, `distantWallThreshold` — control label and distant- wall visibility.
  - `debug` — set to `true` to enable console debug logs (the plugin logs heatmap percentage-floor hits when enabled).

- The plugin now enforces a minimum percentage floor (0.1%) to avoid exact-zero artifacts that could cause rendering seams.

Contributing

- Pull requests are welcome. Keep changes small and focused.
- When changing the chart visuals, include before/after screenshots and keep default colors configurable.

License

None.

Contact

- See the live demo at https://realm.sanixlab.com for reference. For local debugging, enable `debug: true` in the chart options to print helpful diagnostics to the browser console.

WebSocket COB server (configuration)

This project expects a Consolidated Order Book (COB) WebSocket server to stream order book snapshots/updates to the frontend. You can run the bundled manager with PM2 for production use.

Example PM2 start (use this exact command to keep logs timestamped):

```powershell
pm2 start websocketManager.js --name BinanceCOB --log-date-format "HH:mm DD-MM-YYYY Z"
```

Recommended environment variables / configuration options for the COB WebSocket process:

- COB_WEBSOCKET_PORT — port the websocket server listens on (default: 8080)
- COB_WEBSOCKET_HOST — host/interface to bind (default: 0.0.0.0)
- COB_SOURCE — (optional) upstream market data source identifier (exchange name or URL)
- COB_SYMBOLS — (optional) comma-separated list of symbols to subscribe to (e.g. BTCUSDT,ETHUSDT,XRPUSDT)
- LOG_LEVEL — debug/info/warn/error

How it ties into the frontend

- The front-end pages expect a COB websocket endpoint (for example `wss://realm.sanixlab.com` or `ws://localhost:8080`) and the chart plugin accepts a `cobWebSocketUrl` option when constructed. Example:

```js
const chart = new PluginChartCOB({
   containerId: 'chart-container',
   cobWebSocketUrl: 'ws://localhost:8080',
   symbol: 'BTCUSDT'
});
```

PM2 tips

- Check running processes: `pm2 list`
- View live logs: `pm2 logs BinanceCOB`
- Restart: `pm2 restart BinanceCOB`
- Stop: `pm2 stop BinanceCOB`
- To persist process list across reboots, use `pm2 save` and configure your system's startup script with `pm2 startup`.

If you'd like, I can add a sample `.env.example` and a minimal `websocketManager.js` config guide into the repo so new users can get the COB server running quickly.

COB WebSocket server (configuration)

This project expects a Consolidated Order Book (COB) WebSocket server that provides an initial full snapshot and then incremental depth updates. Configure and run a COB server that meets the following expectations so the front-end (`public/charts/pluginChartCOB.js`) can consume it directly.

- URL: any WebSocket URL (ws:// or wss://). The front-end will append `?symbol=SYMBOL` if the URL doesn't include a symbol query param. Example: `ws://localhost:8080` or `wss://cob.example.com/stream?symbol=BTCUSDT`.
- Initial snapshot message (sent once on connect): JSON with `bids` and `asks` arrays of [price, qty] tuples. Example:

```json
{
   "bids": [[4272.5, 28.63], [4272.4, 10.0]],
   "asks": [[4272.6, 5.0], [4272.7, 2.5]]
}
```

- Incremental updates (repeated): JSON with `b` and `a` arrays of [priceStr, qtyStr] tuples (strings are accepted and parsed). Example:

```json
{ "b": [["4272.5","30.12"]], "a": [["4273.0","0"]] }
```

- Message semantics expected by the client plugin:
   - Snapshot replaces the whole order book on the client.
   - Incremental updates represent per-price deltas: quantity `0` typically means remove the level; positive numbers set the new quantity.

Minimal Node.js example (very small toy server)

```js
// Minimal WebSocket server to test the front-end. Do NOT use as production.
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', ws => {
   // Send initial snapshot
   ws.send(JSON.stringify({ bids: [[4272.5, 28.63]], asks: [[4272.6, 5.0]] }));
   // Send periodic mock updates
   setInterval(() => {
      ws.send(JSON.stringify({ b: [["4272.5", (Math.random()*50).toFixed(2)]] }));
   }, 1000);
});
```

Integration notes

- Set the `cobWebSocketUrl` option when creating `PluginChartCOB` to point at your COB server. If your server supports secure websocket (wss) use that for production.
- The plugin will attempt to use the snapshot format above; if your existing COB service emits a different format, add an adapter layer (a small proxy) that translates the live messages into the expected snapshot/update shape.
- For production, run the COB server behind a reverse proxy (nginx/Caddy) and enable TLS (wss) to serve the frontend securely.

Debugging tips

- If the chart shows 404/MIME errors for `pluginChartCOB.js`, verify the server serves static assets and the paths are correct.
- Use the plugin's `debug: true` option to log percentage-floor hits and other diagnostics in the browser console.

