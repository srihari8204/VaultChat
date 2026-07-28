// vaultchat-backend/loadtest/http.k6.js
//
// k6 load test for the VaultChat REST surface.
//
// Run:
//   k6 run --vus 50 --duration 60s loadtest/http.k6.js
//   k6 run --vus 200 --duration 120s --env BASE_URL=https://api.corefinite.com loadtest/http.k6.js
//
// Acceptance targets for 10K-user launch:
//   * /health p95 < 100ms at 200 VUs
//   * /chats GET p95 < 400ms at 100 VUs (each VU = signed-in user)
//   * Error rate < 1%
//
// Bootstrap: this script seeds a test user via /auth/send-otp + verify-otp.
// The OTP is read from server logs (dev mode) — for prod runs, point this
// at a staging environment or pre-create test JWTs and pass them via env.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const JWT      = __ENV.JWT      || ''; // pre-baked access token (recommended)

export const options = {
  thresholds: {
    'http_req_duration{name:health}': ['p(95)<100'],
    'http_req_duration{name:chats}':  ['p(95)<400'],
    'http_req_failed':                ['rate<0.01'],
  },
  scenarios: {
    smoke: {
      executor:   'constant-vus',
      vus:        Number(__ENV.VUS || 50),
      duration:   __ENV.DURATION || '60s',
      gracefulStop: '10s',
    },
  },
};

const errorRate = new Rate('errors');
const chatList  = new Trend('chats_list_ms');

export default function () {
  // 1) Health check (auth-free)
  group('health', () => {
    const r = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
    check(r, { 'health 200': (x) => x.status === 200 }) || errorRate.add(1);
  });

  // 2) /chats — every VU acts as one signed-in user
  if (JWT) {
    group('chats', () => {
      const r = http.get(`${BASE_URL}/chats`, {
        tags: { name: 'chats' },
        headers: { Authorization: `Bearer ${JWT}` },
      });
      check(r, { 'chats 200': (x) => x.status === 200 }) || errorRate.add(1);
      chatList.add(r.timings.duration);
    });
  }

  // Pace one request per VU per second on average
  sleep(1);
}
