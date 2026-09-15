#!/bin/sh
set -eu
scratch=vc-events-db-selftest-20260915
binary=/home/srihari/vaultchat-checkpoints/ccwire-events-20260915/routes-events-check-linux.test
if docker inspect "$scratch" >/dev/null 2>&1; then
  echo "Refusing to reuse existing scratch container: $scratch" >&2
  exit 1
fi
docker run -d --name "$scratch" --network none --memory 256m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,size=192m \
  -e POSTGRES_PASSWORD=disposable-test-only -e POSTGRES_DB=vc_scratch \
  postgres:16-alpine -c shared_buffers=16MB -c max_connections=12
trap 'docker rm -f -v "$scratch" >/dev/null' EXIT HUP INT TERM
attempt=0
until docker exec "$scratch" pg_isready -U postgres -d vc_scratch >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then docker logs "$scratch"; exit 1; fi
  sleep 1
done
sha256sum "$binary"
docker cp "$binary" "$scratch":/tmp/routes-db-check.test
docker exec "$scratch" chmod 755 /tmp/routes-db-check.test
docker exec -e SYNC_TEST_DSN=postgres://postgres:disposable-test-only@127.0.0.1:5432/vc_scratch?sslmode=disable \
  "$scratch" /tmp/routes-db-check.test -test.run '^Test(SyncPaginationScratchDB|DeliveryCursorScratchDB)$' -test.v -test.timeout 60s
