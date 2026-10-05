#!/usr/bin/env bash
# test/fixtures/site-ca/make.sh: the test-only site CA fixtures (cam-proxy
# spec 2026-10-05 §10.1), committed. Never used outside tests. Run from the
# repo root: bash test/fixtures/site-ca/make.sh (OpenSSL 3).
set -euo pipefail
cd "$(dirname "$0")"
DAYS=7300
cnf() { printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=%s\n[ext]\n%s\n' "$1" "$2"; }
CA_EXT=$'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nnameConstraints=critical,permitted;DNS:.test.internal,permitted;IP:127.0.0.0/255.0.0.0'
ca() { # name
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days $DAYS -keyout "$1.key" -out "$1.pem" \
    -config <(cnf "cam-proxy site CA test" "$CA_EXT") -extensions ext
}
leaf() { # name ca cn san
  openssl req -new -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -config <(cnf "$3" "")
  openssl x509 -req -in "$1.csr" -CA "$2.pem" -CAkey "$2.key" -CAcreateserial -sha256 -days $DAYS -out "$1.pem" \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$4")
  rm -f "$1.csr"
}
ca ca-a
ca ca-b
leaf proxy-a ca-a proxy.test.internal 'DNS:proxy.test.internal,IP:127.0.0.1'
leaf proxy-b ca-b proxy.test.internal 'DNS:proxy.test.internal,IP:127.0.0.1'
leaf cam-a ca-a cam3.test.internal 'DNS:cam3.test.internal,IP:127.0.0.1'
leaf outside-a ca-a evil.example 'DNS:evil.example,IP:127.0.0.1'
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days $DAYS -keyout selfsigned.key -out selfsigned.pem -config <(cnf CERTIFICATE "")
rm -f ./*.srl
