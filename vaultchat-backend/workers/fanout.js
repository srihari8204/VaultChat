// workers/fanout.js — Kafka fan-out worker.
//
// Consumes `message.created` and delivers each message over Socket.IO to the
// chat's members. It runs a Socket.IO server bound ONLY to the Redis adapter
// (no HTTP listener), so its io.to(room).emit() publishes through Redis and
// reaches clients connected to the gateway (api) nodes.
//
// Decouples delivery from the message-write request: the API just produces the
// event and returns immediately. Run as its own container:
//   command: ["node", "workers/fanout.js"]
//
// Requires KAFKA_BROKERS + REDIS_HOST + DB_* in the environment.

require('dotenv').config();
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const kafka = require('../lib/kafka');
const { createDelivery } = require('../lib/delivery');

async function main() {
  if (!kafka.enabled()) {
    console.error('[fanout] KAFKA_BROKERS not set — nothing to consume. Exiting.');
    process.exit(1);
  }

  const redisOpts = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASS || undefined,
  };
  const pubClient = new Redis(redisOpts);
  const subClient = pubClient.duplicate();

  // Adapter-only Socket.IO server (no httpServer) — used purely to emit.
  const io = new Server();
  io.adapter(createAdapter(pubClient, subClient));

  const { fanOutToChat } = createDelivery(io);

  // Ensure the topic exists before subscribing — avoids a cold-start race where
  // the broker hasn't auto-created it yet (UNKNOWN_TOPIC_OR_PARTITION).
  const admin = kafka.client().admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: kafka.TOPICS.MESSAGE_CREATED, numPartitions: 3 }],
      waitForLeaders: true,
    });
  } catch { /* already exists / raced — fine */ }
  finally { await admin.disconnect().catch(() => {}); }

  const consumer = kafka.createConsumer(process.env.KAFKA_GROUP_ID || 'fanout-workers');
  await consumer.connect();
  await consumer.subscribe({ topic: kafka.TOPICS.MESSAGE_CREATED, fromBeginning: false });
  console.log(`[fanout] ready — consuming ${kafka.TOPICS.MESSAGE_CREATED}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const evt = JSON.parse(message.value.toString());
        if (evt.event === 'new_message') {
          await fanOutToChat(evt.chatId, 'new_message', evt.payload, evt.senderId ?? null);
        }
      } catch (err) {
        console.error('[fanout] handle failed:', err.message);
      }
    },
  });

  const stop = async () => {
    try { await consumer.disconnect(); } catch {}
    try { await kafka.shutdown(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => { console.error('[fanout] fatal:', err); process.exit(1); });
