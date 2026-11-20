# CLAUDE.md

Context for continuing work on this project. See README.md for user-facing docs.

## What this is

A web UI for the owner's self-hosted Docker Registry v2 (CNCF distribution, `registry:2`).
It browses, searches and deletes images, and can delete empty repositories.

Requirements from the owner (keep them):
- **No auth in the app.** A reverse proxy in front does auth. Proxy config is out of scope.
- Registry URL, user and password come from **environment variables only**.
- **Dark theme** (default; a light toggle exists).
- Runs as a **Docker** container and is **PWA**-installable.
- The owner communicates in Hungarian. The UI, code, comments and README are in English.

## Architecture

- `app/main.py`: one-file FastAPI backend.
  - `Registry` class: async httpx client with basic auth, a global semaphore (`REGISTRY_CONCURRENCY`),
    and LRU caches for **content-addressed data only** (manifests by digest, config blobs).
    Tag→digest lookups are never cached.
  - `resolve()`: tag → manifest. For an index (multi-arch), it picks `linux/amd64`, else the first
    entry, skipping buildx attestation entries (`unknown/unknown`). It then loads the image config.
  - Endpoints: `/api/info`, `/api/repos`, `/api/tags`, `/api/tag`, `/api/delete`,
    `/api/delete-repo`, `/healthz`. The static files are mounted last, at `/`.
  - Inputs are validated with OCI regexes (`REPO_RE`, `TAG_RE`, `DIGEST_RE`, `PLATFORM_RE`) before
    they go into registry URLs or filesystem paths. Keep doing this for any new endpoint.
  - Registry 401/403 are mapped to 502, so the browser never sees a 401 that looks like the proxy's.
  - Empty-repo deletion (`remove_repo_dir`): filesystem only. It removes the `_manifests`, `_layers`
    and `_uploads` dirs (never the whole dir, because nested repos live inside), then prunes empty
    parents. It refuses if tags exist (checked via the API and on disk) or if there was an upload in
    the last 15 minutes.
- `app/static/`: vanilla JS, no build step, no dependencies.
  - `app.js`: one global `state` object; `render()` rebuilds the view with innerHTML. Hash routes are
    `#/`, `#/?q=…` and `#/r/<encoded repo>?q=…`. Event handling is delegated on `document` via
    `data-*` attributes (`data-copy`, `data-copy-pre`, `data-details`, `data-sort`).
  - **Always `esc()`** any registry-derived string you put into HTML.
  - The selected tags in the repo view are a `Set` of tag names. Deletion groups them by digest and
    shows "collateral" tags.
  - Persisted UI prefs in `localStorage`: `theme`, `repoSort`, `hideEmpty`.
  - `sw.js`: network-first for the app shell; `/api/*` is never intercepted. Bump `CACHE` when the
    shell file list changes.
  - `index.html` loads the manifest with `crossorigin="use-credentials"` (needed behind the auth proxy).
- `tools/gen_icons.py`: renders the PNG icons from the same design as `icons/icon.svg` (pure stdlib).

## Gotchas learned the hard way

- The registry API **cannot delete a repository**. The `_catalog` walks storage, so empty repos remain.
- With the default `storage.cache.blobdescriptor: inmemory`, deleting a repo dir out-of-band and then
  re-pushing the same name before a registry restart leaves the layer links missing (404 after the
  next restart). Mitigation: restart the registry, or set `REGISTRY_STORAGE_CACHE_BLOBDESCRIPTOR=disabled`.
  This is documented in the UI confirm dialog and in the README.
- Deleting a manifest via the API removes **every tag** pointing to that digest.
- The service worker only registers in a secure context (HTTPS or `localhost`). A
  `http://<container-name>` URL in tests will not register it; that is expected.
- In async click handlers, capture `e.currentTarget` **before** any `await` (it becomes null afterwards).
- Inside a closed `<details>`, elements are not visible. In Playwright use `waitForSelector(…, {state: 'attached'})`.
- `httpx` logs every request at INFO; it is set to WARNING in `main.py`.

## Testing / verifying changes

There is no unit test suite. Verify against a real registry:

```sh
docker compose -f dev/compose.yml up -d --build   # registry :5055, app :8099 (storage mounted, deletes on)
dev/seed.sh                                       # test data: shared digests, nested repos, multi-arch
dev/smoke.sh                                      # Playwright smoke test, screenshots in dev/e2e/out/
docker compose -f dev/compose.yml down -v
```

- After editing `app.js`: `docker run --rm -v $PWD/app/static:/w -w /w node:22-alpine node --check app.js`
  (there is no local node). After editing `main.py`: `python3 -c "import ast;ast.parse(open('app/main.py').read())"`
  (FastAPI is not installed on the host; it runs in Docker).
- Rebuild the app image after any change: `docker compose -f dev/compose.yml up -d --build app`.
- Extend `dev/e2e/smoke.mjs` when adding UI features. Look at the screenshots to check the visuals.
- Use the scratchpad for ad-hoc test scripts. Clean up test containers, networks and volumes afterwards.

## Deployment / secrets

- The real deployment config is in `.env` (gitignored, mode 600) and read by `docker-compose.yml`
  (`env_file`). **Never commit `.env` and never put credentials in tracked files.** `.env.example`
  is the template.
- The deployment publishes on host port 38080.

## Possible next steps (not requested yet)

- "Delete all empty repositories" bulk action on the home screen.
- Streaming or progressive tag loading for repos with very many tags (currently one request
  resolves all tags concurrently).
- Show the total size per repository on the home cards (needs manifest fetches per tag).
