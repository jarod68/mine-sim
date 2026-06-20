# Load test

`loadtest.js` is a standalone client load generator: it opens many WebSocket
connections across several rooms, drives commands (drill, etc.), and reports
throughput / latency (drill RTT p50/p95) and connection-cap hits — to find how
many parallel games and players a deployed server sustains.

```bash
npm run test:load -- --url ws://localhost:3200 --max-games 30 --players 40
```

It only needs `ws` (already a dependency). It connects to a RUNNING server — it
starts nothing itself.

## Flags
- `--url <ws://host:port>` — target server (default `ws://localhost:3200`).
- `--max-games <n>` — number of parallel rooms to ramp to.
- `--players <n>` — players per room.
- `--add-every <ms>` — interval between ramp-up steps.

## Notes
- Set `TEST_MODE=1` on the server (env or its `.env`) to lift the per-IP
  connection cap / rate limiter while load testing.
- Monitor server RAM/CPU separately (e.g. `docker stats`).
