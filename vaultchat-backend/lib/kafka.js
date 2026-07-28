// lib/kafka.js — Kafka client (producer + consumer factory).
//
// Gated on KAFKA_BROKERS: when unset, enabled() is false and publish() no-ops,
// so the app runs exactly as before (synchronous in-process fan-out). When set
// (e.g. KAFKA_BROKERS=kafka:9092) and EVENT_BUS=kafka, the message path produces
// `message.created` events that the fan-out worker consumes and delivers.

const { Kafka, logLevel } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const TOPICS = { MESSAGE_CREATED: 'message.created' };

let kafka = null;
let producer = null;
let producerReady = null;

function enabled() { return brokers.length > 0; }

function client() {
  if (!enabled()) return null;
  if (!kafka) {
    kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'vaultchat',
      brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 8 },
    });
  }
  return kafka;
}

// Lazily connect a single shared producer. Connection failures are logged and
// retried on the next publish (so a Kafka blip never throws into the request).
async function getProducer() {
  if (!enabled()) return null;
  if (!producerReady) {
    producer = client().producer();
    producerReady = producer.connect().then(() => producer).catch((err) => {
      console.error('[kafka] producer connect failed:', err.message);
      producer = null;
      producerReady = null;
      return null;
    });
  }
  return producerReady;
}

async function publish(topic, key, value) {
  const p = await getProducer();
  if (!p) return false;
  try {
    await p.send({ topic, messages: [{ key: String(key), value: JSON.stringify(value) }] });
    return true;
  } catch (err) {
    console.error('[kafka] publish failed:', err.message);
    return false;
  }
}

function createConsumer(groupId) {
  const c = client();
  return c ? c.consumer({ groupId }) : null;
}

async function shutdown() {
  try { if (producer) await producer.disconnect(); } catch {}
}

module.exports = { enabled, client, getProducer, publish, createConsumer, shutdown, TOPICS };
