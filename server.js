// Entry point: build the server (see server/app.js) and start listening.
const { createServer } = require('./server/app');

const PORT = process.env.PORT || 3200;
const { server, adminUser, adminPass, adminPassSource, envFile } = createServer();

// Keep a stray error from killing the process and resetting every room. (Logged
// loudly; a process manager can still restart on repeated failures.)
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.listen(PORT, () => {
  console.log(`mine-sim running on http://localhost:${PORT}`);
  console.log(`[admin] http://localhost:${PORT}/admin  user=${adminUser}  pass=${adminPass}  (${adminPassSource}: ${envFile})`);
});
