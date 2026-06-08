---
name: docker
description: Build, run, and debug containers and push images to registries (GCP Artifact Registry / GCR) for GKE.
---
# Docker / containers

## Build & run
- Build: `docker build -t <name>:<tag> .` — on Apple Silicon building for x86 GKE nodes, add `--platform linux/amd64`.
- Run: `docker run --rm -p 8080:8080 -e KEY=val <name>:<tag>`; interactive shell: `docker run --rm -it <name> sh`.
- Inspect: `docker ps`, `docker logs <id>`, `docker exec -it <id> sh`.

## Debug
- Build failing: read the failing layer; rebuild with `docker build --progress=plain --no-cache .`.
- Image too big: use multi-stage builds; inspect with `docker history <img>` (or `dive` if installed).

## Push to GCP Artifact Registry (for GKE)
- Auth once: `gcloud auth configure-docker <region>-docker.pkg.dev`
- Tag: `docker tag <img> <region>-docker.pkg.dev/<proj>/<repo>/<img>:<tag>`
- Push: `docker push <region>-docker.pkg.dev/<proj>/<repo>/<img>:<tag>`
- Or build+push server-side: `gcloud builds submit --tag <region>-docker.pkg.dev/<proj>/<repo>/<img>:<tag>`
Then reference the image in your k8s/Helm manifests (kubernetes/helm skills).

## Compose (local multi-service)
- `docker compose up -d` / `docker compose logs -f` / `docker compose down`.

Verify the image runs locally before pushing. Build `--platform linux/amd64` for x86 clusters.
