#!/usr/bin/env bash
# Creates (or resets) the dedicated `cams` admin user on the camera and writes
# the cams-cameras Secret the app reads. Never prints credentials.
#   usage: scripts/create-camera-user.sh [env-file]   (default ~/Development/reolink/.env)
# Needs REOLINK_IP and REOLINK_PASSWORD (the camera's own admin) in the env file.
set -euo pipefail
ENV_FILE="${1:-$HOME/Development/reolink/.env}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
set -a; . "$ENV_FILE"; set +a
: "${REOLINK_IP:?missing}"; : "${REOLINK_PASSWORD:?missing}"
CAMS_CAMERA_PASSWORD=$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))')
export REOLINK_IP REOLINK_PASSWORD CAMS_CAMERA_PASSWORD
python3 - <<'PY'
import json, os, ssl, urllib.request
ip = os.environ["REOLINK_IP"]; ctx = ssl._create_unverified_context()
def call(cmd, param, token=None):
    url = f"https://{ip}/cgi-bin/api.cgi?cmd={cmd}" + (f"&token={token}" if token else "")
    body = json.dumps([{"cmd": cmd, "action": 0, "param": param}]).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=20))[0]
def login(user, pw):
    r = call("Login", {"User": {"Version": "0", "userName": user, "password": pw}})
    if r.get("code") != 0: raise SystemExit(f"login as {user} failed: rspCode {r.get('error',{}).get('rspCode')}")
    return r["value"]["Token"]["name"]
admin = login("admin", os.environ["REOLINK_PASSWORD"])
try:
    users = [u["userName"] for u in call("GetUser", {}, admin)["value"]["User"]]
    if "cams" in users:
        r = call("DelUser", {"User": {"userName": "cams"}}, admin)
        print("removed existing cams user:", r.get("code"))
    r = call("AddUser", {"User": {"userName": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"], "level": "admin"}}, admin)
    if r.get("code") != 0: raise SystemExit(f"AddUser failed: {r.get('error')}")
    print("created cams user (level admin)")
finally:
    call("Logout", {}, admin)
t = login("cams", os.environ["CAMS_CAMERA_PASSWORD"])
info = call("GetDevInfo", {}, t)["value"]["DevInfo"]
print("verified: cams can read", info["model"], info["firmVer"])
call("Logout", {}, t)
PY
python3 - <<'PY' | kubectl -n cams create secret generic cams-cameras --from-file=cameras.json=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
import json, os
print(json.dumps([{"id": "cam1", "name": "Den", "host": os.environ["REOLINK_IP"], "protocol": "https",
                   "tlsServername": "cam1.skylar.technology", "user": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"]}]))
PY
kubectl -n cams describe secret cams-cameras | sed -n '/^Data/,$p'
