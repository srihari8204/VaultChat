// lib/vaultlensQueue.js — BullMQ queue + shared ioredis connection for VaultLens.
//
// One place both the API (enqueue + QueueEvents) and the worker import, so the
// Redis connection details live in exactly one spot. Reuses the same REDIS_*
// env the rest of the stack already sets (Socket.IO adapter / rate limiter).

const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_PASS = process.env.REDIS_PASS || undefined;

// BullMQ REQUIRES maxRetriesPerRequest: null on the connection (blocking cmds).
function makeConnection() {
  return new IORedis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASS || undefined, maxRetriesPerRequest: null });
}

const QUEUE_NAME = 'vaultlens';

let _queue = null;
function queue() {
  if (!_queue) _queue = new Queue(QUEUE_NAME, { connection: makeConnection() });
  return _queue;
}

let _events = null;
function events() {
  if (!_events) _events = new QueueEvents(QUEUE_NAME, { connection: makeConnection() });
  return _events;
}

module.exports = { QUEUE_NAME, makeConnection, queue, events };
