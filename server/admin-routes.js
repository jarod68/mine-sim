// Admin HTTP surface: a Basic-auth guard, the dashboard page, the read-only
// session/activity API, and the credit-grant action. Returns an express Router.

const express = require('express');
const path = require('path');
const { checkAuth, buildAdminData, sessionSummary } = require('../admin');
const { roomBroadcast } = require('./transport');

function adminRouter({ rooms, adminUser, adminPass, graceMs }) {
  const router = express.Router();

  const guard = (req, res, next) => {
    if (checkAuth(req.headers.authorization, adminUser, adminPass)) return next();
    res.set('WWW-Authenticate', 'Basic realm="mine-sim admin", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };

  router.get('/admin', guard, (req, res) => res.sendFile(path.join(__dirname, '..', 'admin.html')));

  router.get('/admin/api/sessions', guard, (req, res) =>
    res.json(buildAdminData({ rooms: rooms.rooms, sessionLog: rooms.sessionLog, eventLog: rooms.eventLog, graceMs })));

  router.post('/admin/api/credit', guard, express.json({ limit: '4kb' }), (req, res) => {
    const { code, amount } = req.body || {};
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'bad amount' });
    const credit = room.world.addCredit(amt);
    roomBroadcast(room, { t: 'live', vehicles: [], blocks: [], credit });
    rooms.logEvent('credit', room.code, { amount: amt, credit });
    res.json({ ok: true, code: room.code, credit });
  });

  return router;
}

module.exports = { adminRouter, sessionSummary };
