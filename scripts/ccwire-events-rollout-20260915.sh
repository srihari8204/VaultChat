#!/usr/bin/env bash
# Reviewed, explicit one-time server rollout. Does not build or migrate databases.
set -Eeuo pipefail
umask 077
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/ccwire-events-rollback-20260915.sh"
CANDIDATE_SOURCE=/home/srihari/vaultchat-checkpoints/ccwire-events-20260915/source
CANDIDATE_IMAGE=vaultchat-go-api:ccwire-events-20260915
OLD_TAG=vaultchat-go-api:pre-migration-20260915
EXPECTED=${1:-}
[[ "$EXPECTED" =~ ^[0-9a-f]{16}$ ]] || die "Usage: bash $0 <reviewed-source-fingerprint>"
BASELINE_IMAGE=sha256:89ace3408b270ab825350d77c45d1d1c87f45e33f64d90244dfe3fe340700226
BASELINE_SOURCE=859b143426237b6b

fingerprint() (
  cd "$1"
  LC_ALL=C; export LC_ALL
  find . -type f \( -name '*.go' -not -name '*_test.go' \) -o -name 'go.mod' -o -name 'go.sum' \
    | sort | while read -r f; do tr -d '\r' < "$f" | sha256sum | cut -d' ' -f1; echo "$f"; done \
    | sha256sum | cut -c1-16
)

for tool in docker curl python3 sha256sum flock; do command -v "$tool" >/dev/null || die "Missing $tool"; done
[[ -d "$ROOT" && -f "$CANDIDATE_SOURCE/go.mod" ]] || die 'Canonical root or candidate Go context missing.'
[[ ! -e "$OVERRIDE" && ! -L "$OVERRIDE" ]] || die 'Release override already exists; review it instead of overwriting it.'
[[ ! -e "$RELEASE" && ! -L "$RELEASE" ]] || die 'Release state already exists; review the previous attempt first.'
for file in docker-compose.yml docker-compose.prod.yml docker-compose.box.yml docker-compose.ccwire.yml docker-compose.transport-20260915.yml docker-compose.webtransport.yml; do
  [[ -f "$ROOT/$file" ]] || die "Missing $file"
done
mkdir -p /home/srihari/vaultchat-releases
exec 9> /home/srihari/vaultchat-releases/.transport-rollout.lock
flock -n 9 || die 'Another transport rollout or rollback is active.'
"${COMPOSE[@]}" config --quiet
[[ "$(fingerprint "$CANDIDATE_SOURCE")" == "$EXPECTED" ]] || die 'Candidate source fingerprint differs from reviewed build.'
candidate_id=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")
old_id=$(docker image inspect --format '{{.Id}}' "$OLD_TAG")
[[ "$old_id" == "$BASELINE_IMAGE" ]] || die 'Rollback tag differs from reviewed baseline.'
current=$("${COMPOSE[@]}" ps -q go-api)
[[ -n "$current" && "$(docker inspect --format '{{.Image}}' "$current")" == "$old_id" ]] || die 'Live API no longer matches the retained rollback image.'
[[ "$candidate_id" != "$old_id" ]] || die 'Candidate and rollback image IDs are identical.'
expected_files="$ROOT/docker-compose.yml,$ROOT/docker-compose.prod.yml,$ROOT/docker-compose.box.yml,$ROOT/docker-compose.ccwire.yml,$ROOT/docker-compose.transport-20260915.yml,$ROOT/docker-compose.webtransport.yml"
actual_files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$current")
[[ "$actual_files" == "$expected_files" ]] || die 'Live overlay list changed; review before rollout.'

old_build=$(build_source "$DIRECT")
[[ "$old_build" == "$BASELINE_SOURCE" ]] || die 'Live source differs from reviewed baseline.'
healthy "$DIRECT" && healthy "$PUBLIC" && auth_required "$DIRECT" && auth_required "$PUBLIC" || die 'Baseline health, readiness, or authentication check failed.'
[[ "$(build_source "$PUBLIC")" == "$old_build" ]] || die 'Public route does not reach the expected current API.'

mkdir -m 700 "$RELEASE"
mkdir "$RELEASE/source" "$RELEASE/rollback"
# Snapshot the complete build context, including hidden files; never overwrite
# vaultchat-clean/vaultchat-backend-go or copy anything back into that checkout.
cp -a "$CANDIDATE_SOURCE/." "$RELEASE/source/"
[[ "$(fingerprint "$RELEASE/source")" == "$EXPECTED" ]] || die 'Durable source copy failed fingerprint verification.'
printf '%s\n' "$old_id" > "$RELEASE/rollback/old-image"
printf '%s\n' "$old_build" > "$RELEASE/rollback/old-build"
printf '%s\n' "$candidate_id" > "$RELEASE/candidate-image"
printf '%s\n' "$EXPECTED" > "$RELEASE/source-fingerprint"
cp "$SCRIPT_DIR/ccwire-events-rollback-20260915.sh" "$RELEASE/rollback.sh"
cp "${BASH_SOURCE[0]}" "$RELEASE/rollout.sh"
for file in docker-compose.yml docker-compose.prod.yml docker-compose.box.yml docker-compose.ccwire.yml docker-compose.transport-20260915.yml docker-compose.webtransport.yml; do
  cp -a "$ROOT/$file" "$RELEASE/rollback/$file"
done
# Record the original build context without emitting resolved environment secrets.
"${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["go-api"]["build"]["context"])' > "$RELEASE/rollback/original-context"
original_context=$(cat "$RELEASE/rollback/original-context")
[[ -d "$original_context" ]] || die 'Original build context is unavailable.'
fingerprint "$original_context" > "$RELEASE/rollback/canonical-source-fingerprint"
# The canonical source may differ from the running image: keep both fingerprints.
python3 - "$RELEASE" "$candidate_id" "$old_id" "$original_context" <<'PY'
import json, pathlib, sys
r, candidate, old, old_context = sys.argv[1:]
r = pathlib.Path(r)
def override(image, context, events):
    return 'services:\n  go-api:\n    image: '+json.dumps(image)+'\n    build:\n      context: '+json.dumps(context)+'\n    environment:\n      CCWIRE_WS: "1"\n      CCWIRE_WEBTRANSPORT: "1"\n      REDIS_ADAPTER: "1"\n      CCWIRE_APP_EVENTS: "'+events+'"\n'
(r/'compose.yml').write_text(override(candidate, str(r/'source'), '1'))
(r/'rollback'/'compose.yml').write_text(override(old, old_context, '0'))
PY
printf '%q ' "${COMPOSE[@]}" -f "$OVERRIDE" > "$RELEASE/compose-command"
printf '\n' >> "$RELEASE/compose-command"

changed=0
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 && changed )); then
    printf 'Rollout failed; restoring the retained API image.\n' >&2
    rollback || printf 'ROLLBACK FAILED: manual go-api recovery is required.\n' >&2
  fi
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
# EXIT catches signals as well as commands failing under errexit.
trap on_exit EXIT
changed=1
cp "$RELEASE/compose.yml" "$OVERRIDE.tmp"
mv "$OVERRIDE.tmp" "$OVERRIDE"
"${COMPOSE[@]}" -f "$OVERRIDE" config --quiet
# Resolve privately and verify that adding this overlay changes only this API's
# image, build context and four transport flags; ports, secrets and peers stay.
"${COMPOSE[@]}" config --format json > "$RELEASE/base-config.json"
"${COMPOSE[@]}" -f "$OVERRIDE" config --format json > "$RELEASE/candidate-config.json"
python3 - "$RELEASE" <<'PY'
import json, pathlib, sys
r = pathlib.Path(sys.argv[1])
base = json.loads((r/'base-config.json').read_text())
candidate = json.loads((r/'candidate-config.json').read_text())
for config in (base, candidate):
    api = config['services']['go-api']
    api.pop('image', None)
    api.get('build', {}).pop('context', None)
    for key in ('CCWIRE_WS', 'CCWIRE_WEBTRANSPORT', 'CCWIRE_APP_EVENTS', 'REDIS_ADAPTER'):
        api.get('environment', {}).pop(key, None)
if base != candidate:
    raise SystemExit('Unexpected Compose changes outside the approved API fields')
PY
# Resolved environment can contain credentials: retain only the original
# source overlays in private rollback storage, never these expanded copies.
rm -- "$RELEASE/base-config.json" "$RELEASE/candidate-config.json"
"${COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --no-build --pull never go-api
current=$("${COMPOSE[@]}" -f "$OVERRIDE" ps -q go-api)
[[ -n "$current" && "$(docker inspect --format '{{.Image}}' "$current")" == "$candidate_id" ]]
verify_release "$EXPECTED"
date -u +%FT%TZ > "$RELEASE/verified-at"
changed=0
trap - ERR INT TERM EXIT
printf 'API rollout verified (%s). Include %s in subsequent Compose commands.\n' "$EXPECTED" "$OVERRIDE"
printf 'Rollback: bash %s/rollback.sh\n' "$RELEASE"
