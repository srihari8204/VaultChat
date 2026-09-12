FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# WHAT IS ACTUALLY RUNNING IN PRODUCTION?
#
# Until this existed the answer was unobtainable. The box builds from a working
# tree that is hundreds of commits behind its own git HEAD with hundreds of
# modified files copied over it, so a git SHA baked in here would be a
# confident lie — it would name a commit that is not what compiled.
#
# So the identifier is a fingerprint of the SOURCE THAT WAS COMPILED: sha256
# over every .go file plus go.mod/go.sum. Two builds of the same source produce
# the same fingerprint on any machine, and `scripts/fingerprint-go.sh`
# recomputes it from any checkout — so "is prod running this code?" becomes one
# string comparison instead of an archaeology exercise.
#
# Tests are excluded: they do not affect the binary, and including them would
# make the fingerprint change when only a test did.
#
# CR is stripped and the sort is LC_ALL=C before hashing. This is not cosmetic:
# the dev machine is Windows and parts of this tree are checked out CRLF, so
# without normalisation every file hashes differently on the box than in the
# checkout, and the fingerprint would compare "which OS wrote this file"
# instead of "which code is this" — the one question it exists to answer.
#
# The file NAME is hashed alongside its content, so adding an empty file or
# renaming one changes the fingerprint too.
RUN SRC_HASH=$(LC_ALL=C; export LC_ALL; \
      find . -type f \( -name '*.go' -not -name '*_test.go' \) -o -name 'go.mod' -o -name 'go.sum' \
      | sort \
      | while read -r f; do tr -d '\r' < "$f" | sha256sum | cut -d' ' -f1; echo "$f"; done \
      | sha256sum | cut -c1-16) && \
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) && \
    echo "source fingerprint: $SRC_HASH" && \
    CGO_ENABLED=0 go build \
      -ldflags "-X main.buildSource=$SRC_HASH -X main.buildTime=$BUILD_TIME" \
      -o /bin/api ./cmd/api

FROM alpine:3.20
RUN adduser -D app
USER app
COPY --from=build /bin/api /bin/api
EXPOSE 4000
ENTRYPOINT ["/bin/api"]
