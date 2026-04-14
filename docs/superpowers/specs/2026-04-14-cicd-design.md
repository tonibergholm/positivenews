# CI/CD Pipeline — Design Spec
**Date:** 2026-04-14
**Scope:** Sub-project A of 4 (CI/CD). Sub-projects B/C/D (unit tests, UI tests, E2E) are separate specs.

---

## Goal

Automatically run lint + (eventually) tests on every push to `main`, then deploy to the production server only if all checks pass. Mirrors the pattern in `tonibergholm/tom-cruises.com`.

---

## Workflow: `.github/workflows/deploy.yml`

Triggers: `push` to `main`, plus `workflow_dispatch` for manual runs.

### Job 1: `test`

Runs on `ubuntu-latest`.

Steps:
1. `actions/checkout@v4`
2. `pnpm/action-setup@v4` with `version: 10`
3. `actions/setup-node@v4` with Node 20 and pnpm cache
4. `pnpm install --frozen-lockfile`
5. `pnpm lint` (see lint fix below)
6. *(commented out placeholder)* `# pnpm test` — uncommented when tests land in sub-projects B/C/D

The Next.js build is **not** run in CI — it requires production env vars and already runs on the server as part of the deploy step.

### Job 2: `deploy`

Runs on `ubuntu-latest`. Has `needs: test`.

Steps:
1. `appleboy/ssh-action@v1.2.0` with:
   - `host: bergholm.net`
   - `port: 2222`
   - `username: toni`
   - `key: ${{ secrets.SSH_DEPLOY_KEY }}`
   - Script:
     ```bash
     set -e
     cd /home/toni/apps/positivenews
     git pull origin main
     pnpm install --frozen-lockfile
     pnpm build
     pm2 restart positivenews
     ```

---

## Lint Script Fix

`package.json` currently has `"lint": "eslint"` with no target, which lints node_modules and generated files — 790 errors, all false positives. Fix: change to `"lint": "eslint app src"` to scope lint to project source only.

---

## Secret Required

`SSH_DEPLOY_KEY` — an SSH private key authorised to log in as `toni@bergholm.net` on port 2222. The same key already used in `tonibergholm/tom-cruises.com` can be reused. Add it to this repo under **Settings → Secrets and variables → Actions → New repository secret**.

---

## What is not in scope

- Running `pnpm build` in CI (requires production env vars)
- Separate staging environment
- Slack/email notifications on failure
- Tests (sub-projects B/C/D add `pnpm test` to the test job when ready)
