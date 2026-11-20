"""Registry Manager — a small web UI for a Docker Registry v2.

The backend talks to the registry (with credentials from the environment) and
exposes a tiny JSON API to the browser. The browser never sees the registry
credentials. Authentication of *users* is expected to be done by a reverse
proxy in front of this app.

Environment:
  REGISTRY_URL          base URL of the registry, e.g. https://registry.example.com (required)
  REGISTRY_USER         basic-auth user for the registry (optional)
  REGISTRY_PASSWORD     basic-auth password for the registry (optional)
  REGISTRY_PUBLIC_HOST  host shown in `docker pull` commands (default: host of REGISTRY_URL)
  REGISTRY_VERIFY_TLS   verify the registry TLS certificate (default: true)
  REGISTRY_CONCURRENCY  max parallel requests to the registry (default: 16)
  DELETE_ENABLED        allow deleting images from the UI (default: true)
  REGISTRY_STORAGE_PATH optional: the registry's filesystem storage root (its
                        `rootdirectory`, usually /var/lib/registry) mounted into
                        this container. Enables deleting empty repositories,
                        which the registry API itself cannot do.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

log = logging.getLogger("registry-manager")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logging.getLogger("httpx").setLevel(logging.WARNING)


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------


def env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


REGISTRY_URL = os.environ.get("REGISTRY_URL", "").strip().rstrip("/")
REGISTRY_USER = os.environ.get("REGISTRY_USER", "")
REGISTRY_PASSWORD = os.environ.get("REGISTRY_PASSWORD", "")
REGISTRY_VERIFY_TLS = env_bool("REGISTRY_VERIFY_TLS", True)
REGISTRY_PUBLIC_HOST = (
    os.environ.get("REGISTRY_PUBLIC_HOST", "").strip() or urlparse(REGISTRY_URL).netloc
)
REGISTRY_CONCURRENCY = max(1, int(os.environ.get("REGISTRY_CONCURRENCY", "16")))
DELETE_ENABLED = env_bool("DELETE_ENABLED", True)
REGISTRY_STORAGE_PATH = os.environ.get("REGISTRY_STORAGE_PATH", "").strip()
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).parent / "static"))

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")

# ---------------------------------------------------------------------------
# registry media types & validation
# ---------------------------------------------------------------------------

MT_DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
MT_DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
MT_OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
MT_OCI_INDEX = "application/vnd.oci.image.index.v1+json"
ACCEPT_MANIFEST = ", ".join([MT_DOCKER_MANIFEST, MT_DOCKER_LIST, MT_OCI_MANIFEST, MT_OCI_INDEX])
INDEX_TYPES = {MT_DOCKER_LIST, MT_OCI_INDEX}

# From the OCI distribution spec. Validating these keeps user input from
# smuggling extra path segments / query strings into registry URLs.
_COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
REPO_RE = re.compile(rf"^{_COMPONENT}(?:/{_COMPONENT})*$")
TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]{32,}$")
PLATFORM_RE = re.compile(r"^[a-z0-9._-]+/[a-z0-9._-]+(?:/[a-z0-9._-]+)?$")


def check_repo(repo: str) -> str:
    if len(repo) > 255 or not REPO_RE.match(repo):
        raise HTTPException(400, f"invalid repository name: {repo!r}")
    return repo


def check_tag(tag: str) -> str:
    if not TAG_RE.match(tag):
        raise HTTPException(400, f"invalid tag: {tag!r}")
    return tag


def check_digest(digest: str) -> str:
    if not DIGEST_RE.match(digest):
        raise HTTPException(400, f"invalid digest: {digest!r}")
    return digest


# ---------------------------------------------------------------------------
# registry client
# ---------------------------------------------------------------------------


class RegistryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class LRU:
    """Tiny LRU cache. Only used for content-addressed (immutable) data."""

    def __init__(self, maxsize: int):
        self.maxsize = maxsize
        self.data: OrderedDict[str, Any] = OrderedDict()

    def get(self, key: str) -> Any:
        if key in self.data:
            self.data.move_to_end(key)
            return self.data[key]
        return None

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value
        self.data.move_to_end(key)
        while len(self.data) > self.maxsize:
            self.data.popitem(last=False)


def is_index(media_type: str, manifest: dict) -> bool:
    if media_type in INDEX_TYPES:
        return True
    return "manifests" in manifest and "layers" not in manifest


def is_attestation(entry: dict) -> bool:
    """buildx stores provenance/SBOM as 'unknown/unknown' entries in indexes."""
    annotations = entry.get("annotations") or {}
    if annotations.get("vnd.docker.reference.type") == "attestation-manifest":
        return True
    platform = entry.get("platform") or {}
    return platform.get("os") == "unknown" and platform.get("architecture") == "unknown"


def platform_str(p: dict | None) -> str:
    p = p or {}
    s = f"{p.get('os') or '?'}/{p.get('architecture') or '?'}"
    if p.get("variant"):
        s += f"/{p['variant']}"
    return s


def manifest_size(manifest: dict) -> int:
    cfg = manifest.get("config") or {}
    return int(cfg.get("size") or 0) + sum(int(l.get("size") or 0) for l in manifest.get("layers") or [])


class Registry:
    def __init__(self) -> None:
        auth = httpx.BasicAuth(REGISTRY_USER, REGISTRY_PASSWORD) if REGISTRY_USER else None
        self.client = httpx.AsyncClient(
            base_url=REGISTRY_URL,
            auth=auth,
            verify=REGISTRY_VERIFY_TLS,
            timeout=httpx.Timeout(30.0, connect=10.0),
            # Blob GETs may redirect to object storage; httpx drops the
            # Authorization header on cross-origin redirects.
            follow_redirects=True,
            limits=httpx.Limits(max_connections=REGISTRY_CONCURRENCY * 2),
            headers={"User-Agent": "registry-manager"},
        )
        self.sem = asyncio.Semaphore(REGISTRY_CONCURRENCY)
        self.manifests = LRU(4096)  # digest -> (media_type, manifest)
        self.configs = LRU(4096)  # digest -> image config json

    async def close(self) -> None:
        await self.client.aclose()

    async def _request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        async with self.sem:
            try:
                return await self.client.request(method, url, **kw)
            except httpx.HTTPError as e:
                raise RegistryError(502, f"registry request failed: {e}") from e

    @staticmethod
    def _raise_for(r: httpx.Response) -> None:
        if r.status_code < 400:
            return
        msg = r.reason_phrase or "error"
        try:
            errors = r.json().get("errors") or []
            if errors:
                msg = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in errors)
        except Exception:
            pass
        raise RegistryError(r.status_code, msg)

    async def ping(self) -> int:
        r = await self._request("GET", "/v2/")
        return r.status_code

    async def _paginate(self, path: str, key: str) -> list[str]:
        items: list[str] = []
        url: str | None = path
        seen: set[str] = set()
        while url and url not in seen:
            seen.add(url)
            r = await self._request("GET", url)
            self._raise_for(r)
            items.extend(r.json().get(key) or [])
            nxt = r.links.get("next", {}).get("url")
            if nxt:
                # Keep only path+query: the Link header may carry the
                # registry's own idea of its hostname.
                u = urlparse(nxt)
                nxt = u.path + (f"?{u.query}" if u.query else "")
            url = nxt
        return items

    async def catalog(self) -> list[str]:
        return sorted(set(await self._paginate("/v2/_catalog", "repositories")))

    async def tags(self, repo: str) -> list[str]:
        try:
            return sorted(set(await self._paginate(f"/v2/{repo}/tags/list", "tags")))
        except RegistryError as e:
            if e.status == 404:
                return []
            raise

    async def get_manifest(self, repo: str, ref: str) -> tuple[str, str, dict]:
        """Return (digest, media_type, manifest) for repo:ref."""
        if DIGEST_RE.match(ref):
            cached = self.manifests.get(ref)
            if cached:
                return ref, cached[0], cached[1]
        r = await self._request("GET", f"/v2/{repo}/manifests/{ref}", headers={"Accept": ACCEPT_MANIFEST})
        self._raise_for(r)
        body = r.content
        digest = r.headers.get("Docker-Content-Digest") or "sha256:" + hashlib.sha256(body).hexdigest()
        data = json.loads(body)
        media_type = data.get("mediaType") or r.headers.get("Content-Type", "").split(";")[0].strip()
        self.manifests.set(digest, (media_type, data))
        return digest, media_type, data

    async def get_config(self, repo: str, digest: str) -> dict:
        cached = self.configs.get(digest)
        if cached is not None:
            return cached
        r = await self._request("GET", f"/v2/{repo}/blobs/{digest}")
        self._raise_for(r)
        data = r.json()
        self.configs.set(digest, data)
        return data

    async def resolve(self, repo: str, ref: str, platform: str | None = None) -> dict:
        """Resolve repo:ref down to a concrete image (picking a platform for
        multi-arch images) and load its config."""
        digest, media_type, data = await self.get_manifest(repo, ref)
        res: dict[str, Any] = {
            "digest": digest,
            "mediaType": media_type,
            "multiarch": False,
            "platforms": [],
            "platform": None,
            "index": None,
        }
        image_digest, image_mt, image = digest, media_type, data

        if is_index(media_type, data):
            entries = [m for m in data.get("manifests") or [] if not is_attestation(m)]
            res["multiarch"] = True
            res["index"] = data
            res["platforms"] = [
                {"platform": platform_str(m.get("platform")), "digest": m.get("digest")} for m in entries
            ]
            chosen = None
            if platform:
                chosen = next((m for m in entries if platform_str(m.get("platform")) == platform), None)
            if chosen is None:
                chosen = next(
                    (m for m in entries if platform_str(m.get("platform")) == "linux/amd64"),
                    entries[0] if entries else None,
                )
            if chosen is None:
                raise RegistryError(422, "image index has no usable platform manifests")
            res["platform"] = platform_str(chosen.get("platform"))
            image_digest, image_mt, image = await self.get_manifest(repo, chosen["digest"])

        config = None
        cfg_desc = image.get("config") or {}
        if cfg_desc.get("digest"):
            try:
                config = await self.get_config(repo, cfg_desc["digest"])
            except (RegistryError, ValueError) as e:
                log.warning("config blob %s@%s unavailable: %s", repo, cfg_desc["digest"], e)

        if config and not res["platform"]:
            res["platform"] = platform_str(config)
        res.update(
            imageDigest=image_digest,
            imageMediaType=image_mt,
            image=image,
            config=config,
            size=manifest_size(image),
        )
        return res

    async def delete_manifest(self, repo: str, digest: str) -> dict:
        r = await self._request(
            "DELETE", f"/v2/{repo}/manifests/{digest}", headers={"Accept": ACCEPT_MANIFEST}
        )
        if r.status_code in (200, 202):
            return {"digest": digest, "ok": True, "message": "deleted"}
        if r.status_code == 404:
            return {"digest": digest, "ok": True, "message": "not found (already deleted?)"}
        if r.status_code == 405:
            return {
                "digest": digest,
                "ok": False,
                "message": "deletion is disabled on the registry (REGISTRY_STORAGE_DELETE_ENABLED=true)",
            }
        try:
            self._raise_for(r)
        except RegistryError as e:
            return {"digest": digest, "ok": False, "message": f"HTTP {e.status}: {e.message}"}
        return {"digest": digest, "ok": False, "message": f"HTTP {r.status_code}"}


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

registry: Registry


@asynccontextmanager
async def lifespan(_: FastAPI):
    global registry
    if not REGISTRY_URL.startswith(("http://", "https://")):
        raise RuntimeError("REGISTRY_URL must be set to an http(s):// URL")
    registry = Registry()
    init_storage()
    log.info(
        "registry=%s user=%s delete_enabled=%s", REGISTRY_URL, REGISTRY_USER or "(none)", DELETE_ENABLED
    )
    try:
        yield
    finally:
        await registry.close()


app = FastAPI(title="Registry Manager", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.exception_handler(RegistryError)
async def registry_error_handler(_: Request, exc: RegistryError) -> JSONResponse:
    if exc.status == 404:
        status = 404
    elif exc.status in (401, 403):
        # Don't pass a 401 through: it would make the browser think the
        # reverse proxy wants credentials.
        status = 502
        exc.message = f"registry rejected our credentials (HTTP {exc.status}): {exc.message}"
    else:
        status = exc.status if 400 <= exc.status < 600 else 502
        if status in (401, 407):
            status = 502
    return JSONResponse({"detail": exc.message}, status_code=status)


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        # Always revalidate the app shell (ETag makes this cheap).
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


def summarize(tag: str, res: dict) -> dict:
    cfg = res.get("config") or {}
    platforms = [p["platform"] for p in res["platforms"]] or ([res["platform"]] if res["platform"] else [])
    return {
        "tag": tag,
        "digest": res["digest"],
        "multiarch": res["multiarch"],
        "platforms": platforms,
        "created": cfg.get("created"),
        "size": res.get("size"),
    }


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/api/info")
async def info() -> dict:
    try:
        status = await registry.ping()
        error = None if status == 200 else f"registry answered HTTP {status} on /v2/"
    except RegistryError as e:
        status, error = 0, e.message
    return {
        "registry": REGISTRY_PUBLIC_HOST,
        "deleteEnabled": DELETE_ENABLED,
        "repoDeleteEnabled": DELETE_ENABLED and REPOS_ROOT is not None,
        "ok": status == 200,
        "error": error,
    }


@app.get("/api/repos")
async def repos() -> list[dict]:
    names = await registry.catalog()

    async def one(name: str) -> dict:
        try:
            return {"name": name, "tags": await registry.tags(name)}
        except RegistryError as e:
            return {"name": name, "tags": [], "error": e.message}

    return list(await asyncio.gather(*(one(n) for n in names)))


@app.get("/api/tags")
async def tags(repo: str = Query(...)) -> list[dict]:
    check_repo(repo)
    tag_names = await registry.tags(repo)

    async def one(tag: str) -> dict:
        try:
            return summarize(tag, await registry.resolve(repo, tag))
        except (RegistryError, ValueError) as e:
            return {"tag": tag, "error": getattr(e, "message", str(e))}

    return list(await asyncio.gather(*(one(t) for t in tag_names)))


@app.get("/api/tag")
async def tag_details(repo: str = Query(...), tag: str = Query(...), platform: str | None = None) -> dict:
    check_repo(repo)
    if not (TAG_RE.match(tag) or DIGEST_RE.match(tag)):
        raise HTTPException(400, f"invalid tag: {tag!r}")
    if platform and not PLATFORM_RE.match(platform):
        raise HTTPException(400, f"invalid platform: {platform!r}")

    res = await registry.resolve(repo, tag, platform)

    # Per-platform sizes for multi-arch images (sub-manifests are cached).
    async def plat_size(p: dict) -> None:
        try:
            _, _, m = await registry.get_manifest(repo, p["digest"])
            p["size"] = manifest_size(m)
        except (RegistryError, ValueError):
            p["size"] = None

    await asyncio.gather(*(plat_size(p) for p in res["platforms"]))

    cfg = res.get("config") or {}
    image = res["image"]
    return {
        "repo": repo,
        "tag": tag,
        "registry": REGISTRY_PUBLIC_HOST,
        "digest": res["digest"],
        "mediaType": res["mediaType"],
        "multiarch": res["multiarch"],
        "platform": res["platform"],
        "platforms": res["platforms"],
        "imageDigest": res["imageDigest"],
        "imageMediaType": res["imageMediaType"],
        "size": res["size"],
        "created": cfg.get("created"),
        "author": cfg.get("author"),
        "config": cfg.get("config") or {},
        "history": cfg.get("history") or [],
        "layers": image.get("layers") or [],
        "manifest": image,
        "index": res["index"],
    }


class DeleteRequest(BaseModel):
    repo: str
    digests: list[str]


@app.post("/api/delete")
async def delete(req: DeleteRequest) -> dict:
    if not DELETE_ENABLED:
        raise HTTPException(403, "deleting is disabled (DELETE_ENABLED=false)")
    check_repo(req.repo)
    digests = list(dict.fromkeys(check_digest(d) for d in req.digests))
    if not digests:
        raise HTTPException(400, "no digests given")
    results = []
    for d in digests:
        res = await registry.delete_manifest(req.repo, d)
        log.info("delete %s@%s -> %s", req.repo, d, res["message"])
        results.append(res)
    return {"results": results}


# ---------------------------------------------------------------------------
# empty repository removal (filesystem storage only)
# ---------------------------------------------------------------------------
#
# The registry API has no "delete repository" call: after all tags are gone
# the repository directory stays and keeps showing up in /v2/_catalog. With
# the filesystem driver a repository is just
#   <root>/docker/registry/v2/repositories/<name>/{_manifests,_layers,_uploads}
# so we remove those. Nested repositories (e.g. "a" and "a/b") share
# directories, which is why only the three internal dirs are removed and
# parents are pruned only when empty. Blobs are reclaimed by the registry's
# garbage collector as usual.

REPOS_ROOT: Path | None = None
REPO_INTERNAL_DIRS = ("_manifests", "_layers", "_uploads")
RECENT_UPLOAD_SECONDS = 15 * 60


def init_storage() -> None:
    global REPOS_ROOT
    if not REGISTRY_STORAGE_PATH:
        return
    root = Path(REGISTRY_STORAGE_PATH) / "docker" / "registry" / "v2" / "repositories"
    if not root.is_dir():
        log.warning("REGISTRY_STORAGE_PATH set, but %s does not exist — repository deletion disabled", root)
        return
    if not os.access(root, os.W_OK | os.X_OK):
        log.warning("no write permission on %s — repository deletion will fail (check the container user)", root)
    REPOS_ROOT = root.resolve()
    log.info("repository deletion enabled via storage at %s", REPOS_ROOT)


def _newest_mtime(path: Path) -> float:
    """Newest mtime of anything *inside* path (0 when empty). The directory
    itself is skipped: its mtime changes whenever a finished upload is
    cleaned up."""
    newest = 0.0
    for dirpath, dirs, files in os.walk(path):
        names = [os.path.join(dirpath, n) for n in (*dirs, *files)]
        for name in names:
            try:
                newest = max(newest, os.stat(name).st_mtime)
            except OSError:
                pass
    return newest


def remove_repo_dir(repo: str) -> None:
    assert REPOS_ROOT is not None
    d = (REPOS_ROOT / repo).resolve()
    if REPOS_ROOT not in d.parents:
        raise HTTPException(400, "repository path escapes the storage root")
    if not any((d / sub).is_dir() for sub in REPO_INTERNAL_DIRS):
        raise HTTPException(404, f"repository {repo!r} not found in storage at {d}")

    tags_dir = d / "_manifests" / "tags"
    if tags_dir.is_dir() and any(tags_dir.iterdir()):
        raise HTTPException(409, "repository still has tags on disk")
    uploads = d / "_uploads"
    if uploads.is_dir() and time.time() - _newest_mtime(uploads) < RECENT_UPLOAD_SECONDS:
        raise HTTPException(409, "an upload to this repository is in progress (or was very recent) — try again later")

    try:
        for sub in REPO_INTERNAL_DIRS:
            if (d / sub).exists():
                shutil.rmtree(d / sub)
        # Remove now-empty directories up to (not including) the root.
        p = d
        while p != REPOS_ROOT:
            try:
                p.rmdir()
            except OSError:
                break  # not empty: another repository lives below
            p = p.parent
    except PermissionError as e:
        raise HTTPException(
            500, f"no permission to delete {e.filename}: run the container as the owner of the registry storage"
        ) from e


class RepoDeleteRequest(BaseModel):
    repo: str


@app.post("/api/delete-repo")
async def delete_repo(req: RepoDeleteRequest) -> dict:
    if not DELETE_ENABLED:
        raise HTTPException(403, "deleting is disabled (DELETE_ENABLED=false)")
    if REPOS_ROOT is None:
        raise HTTPException(501, "repository deletion needs REGISTRY_STORAGE_PATH (filesystem storage mounted)")
    check_repo(req.repo)
    tags = await registry.tags(req.repo)
    if tags:
        raise HTTPException(409, f"repository still has {len(tags)} tag(s); delete them first")
    await asyncio.to_thread(remove_repo_dir, req.repo)
    log.info("deleted empty repository %s from storage", req.repo)
    return {"ok": True}


# Static app shell (must be mounted last so it doesn't shadow /api).
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
