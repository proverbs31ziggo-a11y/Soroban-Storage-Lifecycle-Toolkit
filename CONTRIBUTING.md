# Contributing

## Development setup

Use Node.js 20 or newer. Install the lockfile dependencies and run the local checks:

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run format:check
```

The build output is generated in `dist/` and should not be committed.

## Project layout

- `src/config.ts` — network and risk configuration
- `src/ledger-key.ts` — XDR validation and TTL-key derivation
- `src/rpc-client.ts` — Soroban RPC inspection
- `src/risk.ts` — expiration risk classification
- `src/maintenance-planner.ts` — reports and dry-run plans
- `src/report.ts` — table, JSON, and CSV serialization
- `src/cli.ts` — CLI commands
- `src/tests/` — unit tests, deterministic local RPC tests (`local-rpc.test.ts`), opt-in Testnet integration tests (`integration.test.ts`), and their shared ledger-key fixtures (`fixtures.ts`)
- `examples/` — key-encoding example

## Guidelines

- Keep inspection limited to explicitly supplied keys; never imply that a contract ID enumerates all storage.
- Do not add transaction signing or automatic extension to the read-only MVP.
- Cost estimates must expose their assumptions and must not be presented as authoritative RPC quotes.
- Add focused tests for behavior changes. Put RPC behavior that must be exact (missing keys, omitted metadata, malformed responses) in the deterministic local tests; keep `integration.test.ts` for checks that need a real network. See [Integration tests](#integration-tests).
- Run `npm run format` before submitting changes; CI verifies formatting, unit tests, dependency advisories, and type safety.
- Keep RPC errors visible to callers and avoid logging credentials or private keys.

## Integration tests

There are two kinds of RPC tests:

| Suite                           | Command                    | Network | What it covers                                                                                                                                                                    |
| ------------------------------- | -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tests/local-rpc.test.ts`   | `npm test`                 | None    | A local HTTP RPC stand-in with fixed ledger data: contract-data and contract-code entries, missing keys, omitted `liveUntilLedgerSeq`, and how each flows into reports and plans. |
| `src/tests/integration.test.ts` | `npm run test:integration` | Testnet | Real `getNetwork`/`getLedgerEntries` calls for a known contract-data key, an optional known contract-code key, and missing keys of both types.                                    |

The Testnet tests are read-only: they never sign or submit transactions. Their default fixtures avoid user-owned state:

- **Contract data (found):** the instance key of the native asset (XLM) contract, which the protocol owns.
- **Missing keys:** a bare-symbol key under the native asset contract (which that contract never writes) and a contract-code key whose hash matches no WASM.
- **Contract code (found):** no default, because every Testnet reset removes uploaded WASM. The test is skipped unless you set one of the variables below.

A provider that omits expiration metadata cannot be reproduced on demand against a public endpoint, so that case is covered only by the local tests.

Override the fixtures with environment variables:

| Variable                          | Purpose                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `STELLAR_RPC_URL`                 | Testnet RPC endpoint (default `https://soroban-testnet.stellar.org`). The passphrase must still be Testnet's. |
| `STELLAR_RPC_AUTH_TOKEN`          | Bearer token for the endpoint, if it needs one.                                                               |
| `STORAGE_CONTRACT_DATA_KEY_XDR`   | Base64 `LedgerKey` for the found contract-data test. `STORAGE_LEDGER_KEY_XDR` is still accepted as an alias.  |
| `STORAGE_CONTRACT_CODE_WASM_HASH` | 64-character hex WASM hash; enables the found contract-code test.                                             |
| `STORAGE_CONTRACT_CODE_KEY_XDR`   | Base64 contract-code `LedgerKey`; used instead of `STORAGE_CONTRACT_CODE_WASM_HASH` when both are set.        |

Overrides are checked for the right key type before any request is sent. Choose a contract-data key whose TTL you expect to stay live, since the test asserts it has not expired. For example:

```sh
STORAGE_CONTRACT_CODE_WASM_HASH=<hex wasm hash> npm run test:integration
```

The scheduled `Testnet integration` workflow reads the same values from repository variables (`STORAGE_CONTRACT_DATA_KEY_XDR`, `STORAGE_CONTRACT_CODE_WASM_HASH`, `STELLAR_RPC_URL`). A manual run can also pass a WASM hash as an input. Update the WASM hash variable after a Testnet reset.
