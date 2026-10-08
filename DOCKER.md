# Docker

Run AFRouter in a container. No prebuilt images are published yet - build from source.

---

# 👤 For Users

## Quick start

```bash
git clone https://github.com/AFG473319/AFRouter.git
cd AFRouter
docker build -t afrouter .

docker run -d \
  -p 20128:20128 \
  -v "$HOME/.afrouter:/app/data" \
  -e DATA_DIR=/app/data \
  --name afrouter \
  afrouter:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f afrouter        # view logs
docker stop afrouter           # stop
docker start afrouter          # start again
docker rm -f afrouter          # remove
```

## Data persistence

```bash
-v "$HOME/.afrouter:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.afrouter/` (macOS/Linux) or `%APPDATA%\afrouter\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.afrouter/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
git clone https://github.com/AFG473319/AFRouter.git
cd AFRouter
docker build -t afrouter .

docker run -d \
  -p 20128:20128 \
  -v "$HOME/.afrouter:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name afrouter \
  afrouter:latest
```

## Optional Headroom sidecar

The AFRouter image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point AFRouter at that proxy:

```yaml
services:
  afrouter:
    build: .
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.afrouter:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
git pull && docker build -t afrouter .
docker rm -f afrouter
# re-run the quick start command
```

To pin a specific version instead of following `latest`, use a numbered image tag:

```bash
docker pull decolua/9router:0.5.81
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t afrouter .

docker run --rm -p 20128:20128 \
  -v "$HOME/.afrouter:/app/data" \
  -e DATA_DIR=/app/data \
  afrouter
```

The Dockerfile uses the official Alpine and npm registries by default. Regional mirrors can be supplied when needed:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  -t 9router .
```

## Publish (automatic via CI)

Push a Docker-safe semver git tag `vX.Y.Z` (or a prerelease such as `vX.Y.Z-rc.1`) → GitHub Actions builds `linux/amd64` and `linux/arm64` on native runners, health-checks each platform image, verifies the resulting manifest and `/api/health`, then publishes:

- `ghcr.io/afg473319/afrouter:X.Y.Z` + `:latest`
- `afg473319/afrouter:X.Y.Z` + `:latest` (Docker Hub, when secrets are configured)

The `v` prefix is used only for the git tag; image tags omit it. A stable tag push promotes `latest`, but a prerelease tag such as `vX.Y.Z-rc.1` publishes only its numbered image by default. Prereleases require an explicit manual `promote_latest` opt-in. Promotion happens only after both native platform builds, both platform health checks, manifest inspection, and the resolved-manifest smoke test succeed. A failed or timed-out platform build therefore cannot move `latest`.

The workflow rejects SemVer build metadata such as `v1.2.3+build.7` because the `+` form is not a valid Docker image tag. The git tag and both `package.json` versions must match exactly.

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.5.x && git push origin v0.5.x
```

To republish an existing tag, run the `Build and Push Docker Image` workflow manually and provide the exact tag, for example `v0.5.95`, in the `release_tag` input. Manual runs publish the numbered tag but leave `latest` unchanged by default:

```text
release_tag:     v0.5.95
promote_latest:  false
```

The `promote_latest` checkbox is an explicit opt-in for changing `latest`. Use it when a deliberate rollback or recovery should make that version the current default:

```text
release_tag:     v0.5.95
promote_latest:  true
```

Numbered image tags are mutable because a republish can replace their manifest. For a deployment that must be immutable, pin the image digest instead:

```bash
docker pull afg473319/afrouter@sha256:<verified-digest>
```

The release workflow runs `/api/health` on each native `amd64` and `arm64` platform image before it uploads the digest artifact or assembles the multi-platform manifest. It then runs a second health check against the resolved version manifest before any requested `latest` promotion.

During recovery, the selected tag remains the application source while the Dockerfile from the workflow revision is used, so an older tag can be rebuilt with the current publishing fixes.

The workflow is tag-driven. Creating a git tag does not automatically create a GitHub Release, so the Releases page and the published package/image tags can be at different versions unless a maintainer creates a release separately.

This repository needs these repository secrets for Docker Hub publishing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

GHCR publishing uses the workflow's `GITHUB_TOKEN` with package write permission. Forks can publish to their own GHCR namespace, but Docker Hub publication is restricted to the `afg473319/afrouter` repository.

The optional repository variables `ALPINE_MIRROR` and `NPM_REGISTRY` can override the default package mirrors used by the CI Docker build.

Workflow: `.github/workflows/docker-publish.yml`
