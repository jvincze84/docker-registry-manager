# Registry Manager

A small web UI for a self-hosted Docker Registry v2: browse, search and delete images.
Dark theme (switchable to light), installable as a PWA, ships as a single Docker container.

## Screens

<img width="1485" height="677" alt="opera_2by1wgpddx" src="https://github.com/user-attachments/assets/ba1088af-dd43-4347-82ec-5040f902e4db" />

<img width="1331" height="301" alt="opera_QLiWg4Nx2Z" src="https://github.com/user-attachments/assets/416f333c-839c-47d6-adfd-5fa14115061d" />


<img width="984" height="616" alt="opera_F28X5xEXnG" src="https://github.com/user-attachments/assets/c25619ec-77fe-4a9f-b485-02311bf39ac8" />


## Features

- **Search** across all repositories and tags at once: `nginx`, `1.2`, or `repo:tag` (e.g. `busybox:1.`).
- **Repository list** sortable by name or tag count, with an option to hide empty repositories.
- **Tag list** per repository with creation date, size, platform(s) and digest; sortable and filterable.
  Tags pointing to the same image share a coloured dot and an `×N` badge.
- **Details**: `docker pull` commands (by tag and by digest), user, entrypoint, cmd, env, labels,
  layers, raw manifest / config with copy buttons. Platform switcher for multi-arch images.
- **Delete** one or more tags. Before deleting, the UI lists the *other* tags that will disappear too,
  because the registry deletes by digest, not by tag. "Keep newest N" selects all older tags in one
  click, except those that share an image with a kept tag.
- **Delete empty repositories** (optional, filesystem storage only, see below).
- **PWA**: installable, and the app shell loads offline. Registry data is never served from cache.

## Quick start

```sh
cp .env.example .env      # then edit .env
docker compose up -d --build
# → http://localhost:38080
```

Or without compose:

```sh
docker build -t registry-manager .
docker run -d -p 8080:8080 \
  -e REGISTRY_URL=https://registry.example.com \
  -e REGISTRY_USER=admin \
  -e REGISTRY_PASSWORD=secret \
  registry-manager
```

## Configuration

All configuration is done with environment variables:

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_URL` | **required** | Base URL of the registry, e.g. `https://registry.example.com` |
| `REGISTRY_USER` | – | Basic-auth user for the registry |
| `REGISTRY_PASSWORD` | – | Basic-auth password |
| `REGISTRY_PUBLIC_HOST` | host of `REGISTRY_URL` | Host used in `docker pull` commands, if the internal URL differs from the public one |
| `REGISTRY_VERIFY_TLS` | `true` | Set to `false` to skip verifying the registry's TLS certificate |
| `REGISTRY_CONCURRENCY` | `16` | Max parallel requests to the registry |
| `DELETE_ENABLED` | `true` | Set to `false` for a read-only UI |
| `REGISTRY_STORAGE_PATH` | – | The registry's filesystem storage root, mounted into the container. Enables deleting empty repositories |
| `PORT` | `8080` | Port the container listens on |
| `LOG_LEVEL` | `INFO` | Python log level |

The registry credentials stay in the backend; the browser never sees them.

## Important

- **The app has no authentication of its own.** Put it behind a reverse proxy that does
  authentication. Without one, anyone who can reach it can delete images.
- Deleting requires `REGISTRY_STORAGE_DELETE_ENABLED=true` on the registry.
- Disk space is only reclaimed after running garbage collection on the registry host:
  `registry garbage-collect --delete-untagged /etc/docker/registry/config.yml`
- PWA installation (and the service worker) needs HTTPS, or `localhost`.
- The web manifest is loaded with `crossorigin="use-credentials"`, so the proxy's auth
  (cookie or basic auth) is also sent with the manifest request.

## Deleting empty repositories

The registry API has no "delete repository" operation. Once all tags are deleted, the repository
directory remains and keeps showing up with 0 tags. The options are:

- **Hide empty**: a toggle on the home screen hides repositories with 0 tags.
- **Delete from the UI** (filesystem storage driver only): mount the registry's storage into the
  container and set `REGISTRY_STORAGE_PATH`. Repositories with 0 tags then get a
  **Delete repository** button. It removes `_manifests`, `_layers` and `_uploads` under
  `docker/registry/v2/repositories/<repo>`. Nested repositories (e.g. `a` and `a/b`) are left intact.
  It refuses to delete if the repository still has tags, or if it received an upload in the last 15 minutes.

  ```yaml
  registry-manager:
    user: "0:0"            # owner of the storage (the registry:2 image writes as root)
    volumes:
      - registry-data:/var/lib/registry
    environment:
      REGISTRY_STORAGE_PATH: /var/lib/registry
  ```

  **Caveat:** by default the registry keeps an in-memory cache of which blobs belong to which
  repository. If a deleted repository name is pushed again *before the registry is restarted*, the
  layer links will be missing, and pulls fail with 404 after the registry's next restart. So either
  **restart the registry after deleting repositories** (recommended after garbage collection anyway),
  or run the registry with `REGISTRY_STORAGE_CACHE_BLOBDESCRIPTOR=disabled`.
- **By hand** on the registry host: `rm -rf <rootdirectory>/docker/registry/v2/repositories/<repo>`
  (the same caveat applies).

## API

| Endpoint | Description |
|---|---|
| `GET /api/info` | Registry host, reachability, which delete features are enabled |
| `GET /api/repos` | All repositories with their tag names |
| `GET /api/tags?repo=` | Tags of a repository with details (date, size, digest, platforms) |
| `GET /api/tag?repo=&tag=[&platform=]` | Full details of one tag |
| `POST /api/delete` `{"repo": "...", "digests": ["sha256:..."]}` | Delete manifests |
| `POST /api/delete-repo` `{"repo": "..."}` | Delete an empty repository from storage (needs `REGISTRY_STORAGE_PATH`) |
| `GET /healthz` | Container health check |

## Development

A throwaway registry plus the app, wired together:

```sh
docker compose -f dev/compose.yml up -d --build
dev/seed.sh                      # push test images (shared digests, nested repos, multi-arch)
# → http://localhost:8099
dev/smoke.sh                     # headless browser smoke test (Playwright in Docker)
docker compose -f dev/compose.yml down -v
```

To run the backend without Docker:

```sh
pip install -r requirements.txt
REGISTRY_URL=http://127.0.0.1:5055 uvicorn app.main:app --reload --port 8080
```

Regenerate the PNG icons (stdlib only): `python3 tools/gen_icons.py`

## Project layout

```
app/main.py            FastAPI backend (registry client, JSON API, static files)
app/static/            Frontend: index.html, app.js, style.css, sw.js, manifest, icons
dev/                   Local test environment, seed script, smoke test
tools/gen_icons.py     PNG icon generator
Dockerfile             Production image (python:3.13-slim, non-root)
docker-compose.yml     Deployment example (reads .env)
```
