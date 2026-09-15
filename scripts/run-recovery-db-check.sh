#!/bin/sh
set -eu

scratch=vc-recovery-db-selftest-20260915
source_dir=/home/srihari/vaultchat-checkpoints/ccwire-recovery-20260915/source
binary=/home/srihari/vaultchat-checkpoints/ccwire-recovery-20260915/routes-recovery-check-linux.test

if docker inspect "$scratch" >/dev/null 2>&1; then
  echo "Refusing to reuse existing scratch container: $scratch" >&2
  exit 1
fi

# Compile in an isolated Go builder so the binary exactly matches the uploaded
# candidate source. The production API and database are never attached.
docker run --rm --network none \
  -v "$source_dir:/workspace:ro" \
  -v "$(dirname "$binary"):/out" \
  -w /workspace --entrypoint go \
  vaultchat-go-api:ccwire-events-validation-20260915 \
  test -c -o /out/$(basename "$binary") ./internal/routes

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
docker cp "$binary" "$scratch":/tmp/routes-recovery-check.test
docker exec "$scratch" chmod 755 /tmp/routes-recovery-check.test
docker exec -e SYNC_TEST_DSN=postgres://postgres:disposable-test-only@127.0.0.1:5432/vc_scratch?sslmode=disable \
  "$scratch" /tmp/routes-recovery-check.test \
  -test.run '^Test(CursorRecoveryScratchDB|SyncPaginationScratchDB|DeliveryCursorScratchDB)$' \
  -test.v -test.timeout 90s
