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

## Strategies

Three plumbing proofs, none a recommendation: `ma-crossover`, `rsi-mean-reversion`, and the
`buy-and-hold` baseline every other row is read against. Compare them over one window:

    npm run backtest -- ma-crossover,rsi-mean-reversion,buy-and-hold SNEK 2026-06-01T00:00:00Z 2026-09-01T00:00:00Z --source external --depth-ada 800000

Each strategy gets its own persisted run; a comparison table follows the per-run reports.

## Checks

    npm test        # unit tests
    npm run test:pg # needs docker compose postgres
    npm run lint
