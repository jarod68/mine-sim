// Entry point. With WORKERS>1, run the multi-core cluster (gateway + workers);
// otherwise a single-process server.
const PORT = process.env.PORT || 3200;

if (+process.env.WORKERS > 1) {
  require('./server/cluster').start();
  return;
}

const { createServer } = require('./server/app');
const instance = createServer();
const { server, rooms, dbFile, testMode, adminUser, adminPass, adminPassSource, envFile } = instance;

// A fatal error leaves the authoritative state possibly corrupt — log it and exit
// so the process manager / container restarts on a clean slate (rather than
// serving from an undefined state). Shut down gracefully first.
function fatal(kind, err) {
  console.error(`[${kind}]`, err);
  try { instance.stop(() => process.exit(1)); } catch { process.exit(1); }
  setTimeout(() => process.exit(1), 3000).unref();   // hard backstop
}
process.on('uncaughtException', (e) => fatal('uncaughtException', e));
process.on('unhandledRejection', (e) => fatal('unhandledRejection', e));

// Graceful shutdown on orchestrator signals.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[${sig}] shutting down`);
    instance.stop(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, () => {
  console.log(`mine-sim running on http://localhost:${PORT}`);
  console.log(`[admin] http://localhost:${PORT}/admin  user=${adminUser}  pass=${adminPass}  (${adminPassSource}: ${envFile})`);
  console.log(`[store] ${dbFile || 'disabled'}  (restored ${rooms.size} room(s))`);
  if (testMode) console.warn('[TEST_MODE] per-IP / rate-limit protections DISABLED — do not leave on in production');
});
