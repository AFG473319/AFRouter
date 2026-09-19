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

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to `ghcr.io/afg473319/afrouter` (`:v{version}` + `:latest`). Docker Hub publishing additionally requires the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets.

```bash
git tag v0.5.x && git push origin v0.5.x
```

Workflow: `.github/workflows/docker-publish.yml`
