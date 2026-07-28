FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/api ./cmd/api

FROM alpine:3.20
RUN adduser -D app
USER app
COPY --from=build /bin/api /bin/api
EXPOSE 4000
ENTRYPOINT ["/bin/api"]
