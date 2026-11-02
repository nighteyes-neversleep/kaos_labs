#!/usr/bin/env bash
# OMI local workspace controller. Never removes its data volume.
set -euo pipefail
umask 077
omi_here=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
omi_action=${1:-up}
if [ "$#" -gt 0 ]; then shift; fi
omi_prefix=${OMI_HOME:-"$HOME/.local/share/omi-workspace"}
omi_port=${OMI_PORT:-8080}
omi_member=kaos
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) omi_prefix=$2; shift 2 ;;
    --port) omi_port=$2; shift 2 ;;
    --id) omi_member=$2; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
case "$omi_action" in up|status|down|credentials|member|backup) ;; *) printf '%s\n' 'Usage: bash omi.sh up|status|down|credentials|member|backup [--prefix PRIVATE_PATH] [--port 8080] [--id agent]' >&2; exit 2;; esac
command -v python3 >/dev/null || { printf '%s\n' 'Python 3 is required.' >&2; exit 1; }
command -v docker >/dev/null || { printf '%s\n' 'Docker Engine is required. No host packages were changed.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf '%s\n' 'Docker Engine is not reachable by this account. No browser or desktop settings were changed.' >&2; exit 1; }
case "$omi_port" in ''|*[!0-9]*) printf '%s\n' 'Port must be numeric.' >&2; exit 2;; esac
if [ "$omi_port" -lt 1 ] || [ "$omi_port" -gt 65535 ]; then exit 2; fi
if ! [[ "$omi_member" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$ ]]; then printf '%s\n' 'Invalid participant ID.' >&2; exit 2; fi
omi_prefix=$(python3 - "$omi_prefix" <<'PY'
import os,pathlib,stat,sys
p=pathlib.Path(sys.argv[1]).expanduser()
if not p.is_absolute() or str(p)=='/':raise SystemExit('Use an absolute private workspace path.')
q=pathlib.Path(p.anchor)
for part in p.parts[1:]:
 q=q/part
 if q.is_symlink():raise SystemExit('Workspace symlinks are refused.')
if p.exists():
 s=p.stat()
 if not p.is_dir() or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o077:raise SystemExit('Workspace must be an owner-private directory.')
print(p)
PY
)
omi_instance=$(printf '%s' "$omi_prefix" | sha256sum | cut -c1-16)
omi_container="omi-workspace-$omi_instance"
omi_volume="omi-data-$omi_instance"
omi_image=${OMI_SELFHOST_IMAGE:-omi-selfhost:local}
omi_expected=
if [ -f "$omi_here/image.json" ]; then
  read -r omi_image omi_expected < <(python3 - "$omi_here/image.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]));print(v['image'],v['imageId'])
PY
)
fi
omi_exists() { docker container inspect "$omi_container" >/dev/null 2>&1; }
omi_owned() {
  [ "$(docker inspect --format '{{index .Config.Labels "org.kaos.omi.instance"}}' "$omi_container")" = "$omi_instance" ] || { printf '%s\n' 'Container identity mismatch; no container was changed.' >&2; exit 1; }
}
omi_ready() { docker exec "$omi_container" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8080/health");const v=await r.json();if(r.status!==200||v.service!=="omi-forum")process.exit(1)' >/dev/null 2>&1; }
if [ "$omi_action" = status ]; then
  if omi_exists; then omi_owned; docker inspect --format 'Container: {{.State.Status}}; image: {{.Image}}' "$omi_container"; if omi_ready; then printf 'OMI API is responding. Local address on this machine: http://%s\n' "$(docker port "$omi_container" 8080/tcp | head -n1)"; fi
  else printf '%s\n' 'This workspace has no app container yet.'; fi
  printf 'Persistent volume: %s\n' "$omi_volume"; exit 0
fi
mkdir -p "$omi_prefix"
if ! mkdir "$omi_prefix/.control-lock" 2>/dev/null; then printf '%s\n' 'Another workspace operation or unresolved lock exists. No operation was started.' >&2; exit 1; fi
trap 'rmdir "$omi_prefix/.control-lock"' EXIT
if [ "$omi_action" = down ]; then
  if omi_exists; then omi_owned; docker stop --time 10 "$omi_container" >/dev/null; docker rm "$omi_container" >/dev/null; fi
  printf 'App container stopped. Persistent data retained in %s.\n' "$omi_volume"; exit 0
fi
if [ "$omi_action" = up ]; then
  if ! docker image inspect "$omi_image" >/dev/null 2>&1; then
    [ -f "$omi_here/omi-image.tar.gz" ] || { printf '%s\n' 'The packaged image is absent. Build the source Dockerfile or supply the image archive.' >&2; exit 1; }
    python3 - "$omi_here" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]);v=json.loads((p/'image.json').read_text());h=hashlib.sha256()
with (p/'omi-image.tar.gz').open('rb') as stream:
 for block in iter(lambda:stream.read(1048576),b''):h.update(block)
if h.hexdigest()!=v['archiveSha256']:raise SystemExit('Image archive checksum mismatch; nothing loaded.')
PY
    gzip -dc "$omi_here/omi-image.tar.gz" | docker load
  fi
  if [ -n "$omi_expected" ] && [ "$(docker image inspect --format '{{.Id}}' "$omi_image")" != "$omi_expected" ]; then printf '%s\n' 'Image identity mismatch; existing image preserved.' >&2; exit 1; fi
  if omi_exists; then
    omi_owned
    if [ "$(docker inspect --format '{{.Image}}' "$omi_container")" != "$(docker image inspect --format '{{.Id}}' "$omi_image")" ]; then printf '%s\n' 'A different version owns this workspace. Use down to stop only its app, preserving data, before upgrading.' >&2; exit 1; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$omi_container")" != true ]; then docker start "$omi_container" >/dev/null; fi
  else
    docker volume create --label "org.kaos.omi.instance=$omi_instance" "$omi_volume" >/dev/null
    docker run --detach --name "$omi_container" --label "org.kaos.omi.instance=$omi_instance" --restart unless-stopped \
      --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 512m --cpus 1 \
      --env "OMI_PUBLIC_ORIGIN=${OMI_PUBLIC_ORIGIN:-}" --tmpfs /tmp:rw,nosuid,nodev,size=32m --publish "127.0.0.1:$omi_port:8080" --mount "type=volume,src=$omi_volume,dst=/data" "$omi_image" >/dev/null
  fi
  omi_ok=false
  for omi_attempt in {1..30}; do if omi_ready; then omi_ok=true; break; fi; sleep 0.2; done
  if [ "$omi_ok" != true ]; then docker logs --tail 12 "$omi_container" >&2; exit 1; fi
  docker exec "$omi_container" node --input-type=module -e 'import fs from "node:fs";import {execFileSync} from "node:child_process";if(!fs.existsSync("/data/kaos-admin.json"))execFileSync(process.execPath,["server/participant-cli.ts","--id","kaos","--name","Kaos","--admin","--output","/data/kaos-admin.json"],{stdio:"ignore"});'
  printf 'OMI is responding. Local address on this machine: http://%s\n' "$(docker port "$omi_container" 8080/tcp | head -n1)"
  printf 'Persistent server data: %s. Owner credential remains private. No AI provider is required.\n' "$omi_volume"
  exit 0
fi
omi_exists || { printf '%s\n' 'Start this workspace first.' >&2; exit 1; }
omi_owned
if [ "$omi_action" = member ]; then
  case "$omi_member" in kaos|dot|all|broadcast) printf '%s\n' 'Use a separate agent ID; the owner account already exists.' >&2; exit 2;; esac
  docker exec "$omi_container" node --input-type=module -e 'import fs from "node:fs";import {execFileSync} from "node:child_process";const id=process.argv[1];if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))throw Error("Invalid ID");const file="/data/"+id+".json";if(!fs.existsSync(file))execFileSync(process.execPath,["server/participant-cli.ts","--id",id,"--name",id,"--output",file],{stdio:"ignore"});' "$omi_member"
fi
if [ "$omi_action" = credentials ] || [ "$omi_action" = member ]; then
  mkdir -p "$omi_prefix/credentials"; chmod 700 "$omi_prefix/credentials"
  omi_credential="$omi_member.json"; if [ "$omi_member" = kaos ]; then omi_credential=kaos-admin.json; fi
  if [ -e "$omi_prefix/credentials/$omi_credential" ] || [ -L "$omi_prefix/credentials/$omi_credential" ]; then printf '%s\n' 'Existing credential copy preserved; no replacement was made.'; exit 0; fi
  docker cp "$omi_container:/data/$omi_credential" "$omi_prefix/credentials/$omi_credential"
  chmod 600 "$omi_prefix/credentials/$omi_credential"
  printf 'Private credential file: %s\n' "$omi_prefix/credentials/$omi_credential"; exit 0
fi
if [ "$omi_action" = backup ]; then
  omi_backup="backup-$(date -u +%Y%m%dT%H%M%S)-$$"
  docker exec "$omi_container" node --input-type=module -e 'import fs from "node:fs";import {DatabaseSync} from "node:sqlite";const name=process.argv[1];if(!/^backup-[0-9TZ]+-[0-9]+$/.test(name))throw Error("Invalid backup name");const path="/data/"+name;fs.mkdirSync(path,{mode:0o700});const db=new DatabaseSync("/data/forum.sqlite");try{db.exec("VACUUM INTO \u0027"+path+"/forum.sqlite\u0027");}finally{db.close();}for(const file of fs.readdirSync("/data")){if(file.endsWith(".json")&&fs.statSync("/data/"+file).isFile())fs.copyFileSync("/data/"+file,path+"/"+file);}for(const file of fs.readdirSync(path))fs.chmodSync(path+"/"+file,0o600);' "$omi_backup"
  mkdir -p "$omi_prefix/backups"; chmod 700 "$omi_prefix/backups"
  docker cp "$omi_container:/data/$omi_backup" "$omi_prefix/backups/$omi_backup"
  printf 'Private consistent database backup: %s\n' "$omi_prefix/backups/$omi_backup"
fi
