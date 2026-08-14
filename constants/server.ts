// constants/server.ts
// Single source of truth for backend URL
// Change this ONE value to switch between local dev and production

// LOCAL DEV — use your machine's IP (not localhost — phone can't reach it)
// export const SERVER_URL = 'http://10.42.49.151:3002';

// PRODUCTION — restore this line for any real build
export const SERVER_URL = 'https://api.corefinite.com';

// TEMPORARY BENCH BUILD — DO NOT COMMIT, DO NOT RELEASE.
//
// Points at the isolated local Docker bench (go-api :14000) for Gate 1 device
// testing. Production is deliberately NOT reachable from such a build: the
// network-security-config permits cleartext ONLY to that host, so the APK
// cannot fall back to any other endpoint.
//
// export const SERVER_URL = 'http://192.168.1.15:14000';
