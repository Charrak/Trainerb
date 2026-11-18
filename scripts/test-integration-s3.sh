#!/usr/bin/env bash
# Run the normal integration suite with a disposable, private HTTPS S3 store.
set -euo pipefail
certs=$(mktemp -d)
container=''
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$certs"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=trainerb-test' \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$certs/private.key" -out "$certs/public.crt" 2>/dev/null
export MINIO_ROOT_USER=trainerb-integration MINIO_ROOT_PASSWORD="$(openssl rand -hex 24)"
image=minio/minio:RELEASE.2025-04-22T22-12-26Z
if ! docker pull "$image" >"$certs/pull.log" 2>&1; then
  echo "::error::Cannot pull the fixture image: $(tail -1 "$certs/pull.log")" >&2
  exit 1
fi
container=$(docker run -d --rm -p 127.0.0.1::9000 --tmpfs /data:rw,mode=1777 \
  -v "$certs:/certs:ro" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  "$image" server --certs-dir /certs /data)
export TRAINERB_TEST_S3_ORIGIN="https://$(docker port "$container" 9000/tcp)"
export NODE_EXTRA_CA_CERTS="$certs/public.crt"
curl --silent --show-error --fail --retry 20 --retry-delay 1 --retry-connrefused --max-time 3 \
  --cacert "$certs/public.crt" "$TRAINERB_TEST_S3_ORIGIN/minio/health/ready" >/dev/null
npm run test:integration
