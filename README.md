# nextjs-mysql-example: Production Deployment

A Next.js 14 + MySQL 8 CRUD app, dockerised, served behind Nginx with HTTPS, and deployed from GitHub Actions to an Ubuntu host.

Live at **https://hirun.duckdns.org**.

---

## 1. Project overview

The app reads and writes a `users` table in MySQL through Knex and Objection. The Dockerfile is multi-stage (`deps`, `builder`, `runner`) and the final image runs as the non-root `node` user. Docker Compose runs two services, `mysql` (with a named volume and a healthcheck) and `app` (bound to `127.0.0.1:3000` only). Nginx on the host terminates TLS, applies gzip and security headers, and proxies through to the app. The TLS certificate is from Let's Encrypt via Certbot, renewed by `certbot.timer`. CI/CD lives in `.github/workflows/deploy.yml` and is wired to GHCR. UFW limits inbound to ports 22, 80, and 443.

---

## 2. Prerequisites

Locally: Docker 24 or newer, the Docker Compose v2 plugin, Node.js 20 (only if running lint outside Docker), and git. The server is Ubuntu 24.04 with 1.9 GB RAM and a 2 GB swap file. The DuckDNS subdomain `hirun.duckdns.org` is registered and points at the server's public IP. A GitHub PAT with `read:packages` and `write:packages` is needed for the deploy job to pull from GHCR.

---

## 3. Environment variables

The app reads `.env` at the project root. A template is committed at `.env.example`; the real file is gitignored and lives only on the server at `/opt/nextjs-app/.env` (chmod 600). The variables are `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE_NAME`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_HOST` (use `mysql` when running via Compose), `MYSQL_PORT`, and `RUN_SEEDS` (set `true` once on first boot to load the 10 seed users, then back to `false`). Production passwords are generated with `openssl rand -base64 24`.

```bash
cp .env.example .env
```

---

## 4. Local setup

```bash
git clone https://github.com/hirun-kolongahapitiya/nextjs-mysql-example.git
cd nextjs-mysql-example
cp .env.example .env
docker compose up -d --build
```

After about 90 seconds (MySQL first-init), the homepage responds at `http://127.0.0.1:3000` and the API at `http://127.0.0.1:3000/api/users`. `docker compose down` stops everything, `docker compose down -v` also wipes the database.

---

## 5. Server deployment

The server was bootstrapped once with `server-bootstrap.sh` (run as root). The script installs base packages, creates a 2 GB swap, installs Docker CE and Compose v2 from Docker's apt repo (with daemon log limits set in `/etc/docker/daemon.json`), installs Nginx and Certbot, creates the non-root `deploy` user in the `docker` and `sudo` groups, hardens SSH via `/etc/ssh/sshd_config.d/99-hardening.conf`, and enables UFW with only 22, 80, and 443 allowed.

After bootstrap, every push to `main` is deployed automatically by GitHub Actions. To deploy manually:

```bash
ssh deploy@54.251.146.235
cd /opt/nextjs-app
git pull
export APP_IMAGE=ghcr.io/hirun-kolongahapitiya/nextjs-mysql-example:latest
docker compose pull app
docker compose up -d --remove-orphans
```

The Nginx site was installed with:

```bash
sudo cp /opt/nextjs-app/nginx/nextjs-app.conf /etc/nginx/sites-available/nextjs-app.conf
sudo ln -sf /etc/nginx/sites-available/nextjs-app.conf /etc/nginx/sites-enabled/nextjs-app.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS was enabled with Certbot in nginx mode, which also installed the HTTP-to-HTTPS redirect:

```bash
sudo certbot --nginx -d hirun.duckdns.org --non-interactive --agree-tos -m admin@example.com --redirect
```

The `certbot.timer` systemd unit handles renewals.

---

## 6. CI/CD pipeline

`.github/workflows/deploy.yml` runs on every push to `main` (and on manual dispatch). It has three sequential jobs. `lint` runs `npm ci` and `next lint`. `build-and-push` uses Buildx to build the multi-stage image and pushes two tags to GHCR, an immutable `:sha-<full-sha>` and `:latest` (only on the default branch); layer cache is stored in GitHub Actions cache so subsequent builds finish in roughly 20 to 30 seconds. `deploy` connects to the server as the `deploy` user via `appleboy/ssh-action`, pulls the source, logs in to GHCR, runs `docker compose pull app` followed by `docker compose up -d`, and then polls `http://127.0.0.1:3000` for up to 30 seconds. If the app does not respond, the job dumps the last 100 lines of the app logs and exits non-zero so the failure is visible.

The workflow uses six repository secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `GHCR_USER`, `GHCR_TOKEN`, and an optional `SSH_PORT`. Nothing is hardcoded.

---

## 7. Security changes applied

UFW is enabled with a default-deny inbound policy and only ports 22, 80, and 443 open. SSH password and keyboard-interactive auth are both off, and root login is restricted to keys only. CI deploys run as the non-root `deploy` user (uid 1001); the user's passwordless sudo is limited to four exact Nginx-management commands. Secrets are kept out of Git through `.gitignore` entries for `.env`, `.env.production`, `.env.staging`, `*.local.txt`, `*.pem`, `*.key`, `id_rsa`, and `id_ed25519`. The container runs as the non-root `node` user. The app binds only to loopback on the host, so it is only reachable through Nginx; MySQL has no host port at all. Nginx sends `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and `X-XSS-Protection`, hides its version (`server_tokens off`), and Next.js drops its `X-Powered-By` header. HTTPS is enforced by Certbot's Let's Encrypt cert with HTTP redirected to HTTPS. `fail2ban` is installed with default jails. The server's `.env` is `chmod 600`.

---

## 8. Optimisation changes applied

The image is kept small with a multi-stage build and Next.js `output: 'standalone'`. Container logs are capped at 10 MB across 3 files per service, with the same defaults set globally in `/etc/docker/daemon.json`. A 2 GB swap file gives the build process headroom on a 1.9 GB box, with `vm.swappiness=10` so the kernel only swaps under genuine pressure. Compression is on at two layers: Nginx gzip for text, JSON, JavaScript, CSS, SVG, and fonts (`gzip_min_length 1024`, level 6), and Next.js's own `compress: true`. Static assets at `/_next/static/*` get `Cache-Control: public, max-age=31536000, immutable` (safe because the paths are content-hashed). Next.js's `s-maxage` caching shows `x-nextjs-cache: HIT` once warm. The production knex pool is bounded at `{ min: 0, max: 10 }`. Docker healthchecks gate `depends_on` with a 90-second start window to cover MySQL first-boot init. GitHub Actions Buildx uses `cache-from`/`cache-to: type=gha,mode=max`.

---

## 9. Troubleshooting

A 502 from Nginx usually means the app container is down; `docker compose ps` and `docker compose logs app --tail=100` are the first stops. If the app is restart-looping, the same logs almost always show a MySQL connectivity problem, fixed by checking that the `MYSQL_*` variables match between the two services. Migrations failing at boot show up in the app logs after the `Requiring external module sucrase/register/ts` line. If MySQL takes longer than 90 seconds to become healthy on first boot, raising `start_period` further is the fix. `sudo certbot certificates` shows TLS expiry; `sudo certbot renew` forces a renewal, otherwise `certbot.timer` handles it. If the CI deploy fails at the 30-second responsiveness check, the new container probably can't reach MySQL, so check `docker compose logs app` on the server.

---

## 10. Assumptions

The DuckDNS subdomain is registered and pointed at the server's public IP before deployment. The provided SSH key has root access on first connect, and after bootstrap the same key authenticates the `deploy` user. The AWS security group permits inbound on 22, 80, and 443. A single host is enough; there is no load balancer, no multi-AZ, no separate database server. One environment only, no staging tier. Secrets management is GitHub Actions secrets for CI and a `.env` on the server for runtime; a real production setup would use a managed secret store. Database backups are out of scope; the MySQL data lives on a Docker named volume, and a `mysqldump` cron or volume snapshots would be the next step.
