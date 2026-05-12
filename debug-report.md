# Debug Report

Three issues hit during local smoke testing and server bootstrap, with how each was diagnosed and fixed. Each one was the kind of thing that's easy to miss until you actually run the stack end-to-end, which is part of why running the smoke test before pushing to the server was worth the extra step.

---

## Issue 1 — App container aborted because MySQL was still initializing

**Problem.** First `docker compose up -d` brought MySQL up but failed the app container with:

```
dependency failed to start: container nextjs-mysql is unhealthy
```

The app never started. `docker compose ps` showed only `mysql` running.

**Root cause.** MySQL 8 spends ~60–90 seconds on first boot creating the data directory, the root user, and the default database. My healthcheck had `start_period: 30s`, `interval: 10s`, `retries: 10`. After the 30-second grace period, the healthcheck started counting failures every 10s, and MySQL was still not accepting connections, so the container was marked **unhealthy** before it ever became reachable. `depends_on: { mysql: { condition: service_healthy } }` then aborted the app container.

**How found.**

```bash
docker compose logs mysql --tail=40
# ...
# [Entrypoint]: Database files initialized
# [Entrypoint]: Creating database nextjs_mysql_example
# [Entrypoint]: Creating user appuser
# /usr/sbin/mysqld: ready for connections. port: 3306
```

Timestamps in the log showed MySQL becoming ready at roughly t+83s. My grace window only covered up to t+30s, so the dependency aborted ~50 seconds before MySQL was actually usable.

**Fix.** Bumped `start_period` in the MySQL healthcheck to 90 seconds so the grace window covers first-time initialization.

```yaml
# docker-compose.yml
healthcheck:
  test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u root -p$$MYSQL_ROOT_PASSWORD"]
  interval: 10s
  timeout: 5s
  retries: 10
  start_period: 90s
```

**Result.** Next bring-up: MySQL went `(healthy)` at ~t+85s, app started cleanly, migrations and seeds ran.

---

## Issue 2 — `sshd -t` failed on Ubuntu 24 with "Missing privilege separation directory: /run/sshd"

**Problem.** The server bootstrap script aborted at the SSH hardening step. The last line of output was:

```
=== [6/7] SSH hardening ===
Missing privilege separation directory: /run/sshd
```

Because of `set -e` in the script, the rest of the bootstrap (UFW enable) never ran. SSH access continued to work — the running daemon was unaffected — but the new hardening file was not yet active, and the firewall was still inactive.

**Root cause.** On Ubuntu 24's OpenSSH (9.6p1), `sshd -t` does more than parse the config — it touches the privilege-separation runtime directory `/run/sshd`. That directory is created by the `ssh.service` systemd unit at startup, but if the daemon hasn't been (re)started during the current boot's life with the new openssh binary, the directory can be missing. In this case, the SSH package upgrade earlier in the script left the daemon running from the old binary, so `/run/sshd` had not been recreated.

**How found.** Reconnected over SSH as root and ran:

```bash
ls -ld /run/sshd          # No such file or directory
cat /etc/ssh/sshd_config.d/99-hardening.conf   # file was written before the failure
systemctl status ssh      # daemon still active (running with the previous config)
```

The hardening file was on disk; only the validation step had failed. So the situation was recoverable in place.

**Fix.** Create `/run/sshd` before running `sshd -t`, then validate and reload:

```bash
mkdir -p /run/sshd
sshd -t                   # passes
systemctl reload ssh      # picks up the new sshd_config.d/99-hardening.conf
```

For future re-runs of the bootstrap, the script would be improved by either dropping the explicit `sshd -t` (since `systemctl reload ssh` itself fails on invalid config) or guarding it with `mkdir -p /run/sshd` first.

**Result.** SSH reloaded successfully. New session as `deploy@server` worked using the same key. UFW was then enabled with only 22/80/443 open.

---

## Issue 3 — Local port 3000 already in use during smoke test

**Problem.** `docker compose up -d app` failed locally with:

```
failed to bind host port 127.0.0.1:3000/tcp: address already in use
```

**Root cause.** A `next dev` server was already running on the host on port 3000 from an earlier interactive session. I didn't want to kill it (it belonged to other work), so I needed the local smoke test to use a different port without modifying `docker-compose.yml` (which is the production file deployed to the server unchanged).

**How found.**

```bash
ss -tlnp | grep ':3000'
# LISTEN ... users:(("next-server (v1",pid=13611,fd=21))
```

So another Next.js dev server was holding the port — not a stale container, just a host process I shouldn't touch.

**Fix (round 1, didn't work).** Created `docker-compose.override.yml` to remap host port:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:3001:3000"
```

Bring-up still failed with the same error. Compose v2 **merges** `ports` from override files into a list rather than replacing it, so the container was now trying to bind both `:3000` (from the base file) **and** `:3001`. The `:3000` bind still collided with the host's dev server.

**Fix (round 2, worked).** Used the `!override` YAML tag to replace the list entirely:

```yaml
services:
  app:
    ports: !override
      - "127.0.0.1:3001:3000"
```

The override file is gitignored, so this is purely a local-machine workaround — the production `docker-compose.yml` is untouched and the server still binds `127.0.0.1:3000`.

**Result.** App came up on host port 3001, smoke test passed (`GET /` → 200, `GET /api/users` → 10 seed users, `POST /api/users` → new user persisted).

---

## What I'd improve next

- Add a `wait-for` step in the deploy workflow that polls the MySQL container's health status with a longer overall budget, so initial deploys never race the database init.
- Bake the bootstrap script's idempotency more carefully — e.g. detect existing Docker installs by checking the apt source list rather than `command -v docker`, so a partial install gets repaired rather than skipped.
- Replace the in-image knex CLI (which is why the runtime image is ~900 MB) with a dedicated short-lived `migrate` service in compose. The runtime image would drop to ~150 MB.
