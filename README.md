# cardano-trading-bots

Paper-trading foundation for Cardano DEX bots. No real funds move in this repo.
Design: `docs/specs/2026-09-05-paper-trading-foundation.md`. Plan: `docs/plans/`.
Runbooks: `docs/ops/RUNBOOK-collector.md` (the collector), `docs/ops/RUNBOOK-paper.md` (paper mode).

## Quick start

    nvm use && npm install
    cp .env.example .env            # add BLOCKFROST_PROJECT_ID
    docker compose up -d postgres
    npm run migrate
    npm run collect -- --once
    npm run status

## Checks

    npm test        # unit tests
    npm run test:pg # needs docker compose postgres
    npm run lint
