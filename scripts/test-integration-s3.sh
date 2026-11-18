#!/usr/bin/env bash
# Isolated HTTPS object store: no writes to an operator's S3 endpoint.
set -euo pipefail
command -v versitygw >/dev/null || { echo 'Install versitygw v1.11.0 first.' >&2; exit 1; }
work=$(mktemp -d)
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/data"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=trainerb-test' \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$work/private.key" -out "$work/public.crt" 2>/dev/null
export TRAINERB_TEST_S3_SECRET="$(openssl rand -hex 24)"
export TRAINERB_TEST_S3_ORIGIN=https://127.0.0.1:19754
export NODE_EXTRA_CA_CERTS="$work/public.crt"
env -i PATH="$PATH" HOME="$work" ROOT_ACCESS_KEY=trainerb-integration ROOT_SECRET_KEY="$TRAINERB_TEST_S3_SECRET" \
  versitygw --port 127.0.0.1:19754 --cert "$work/public.crt" --key "$work/private.key" --health /health \
  posix "$work/data" >"$work/gateway.log" 2>&1 &
pid=$!
curl --silent --show-error --fail --retry 10 --retry-delay 1 --retry-connrefused --max-time 3 \
  --cacert "$work/public.crt" "$TRAINERB_TEST_S3_ORIGIN/health" >/dev/null
npm run test:integration
