# Soroban Storage Lifecycle Toolkit

[![CI](https://github.com/proverbs31ziggo-a11y/Soroban-Storage-Lifecycle-Toolkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/proverbs31ziggo-a11y/Soroban-Storage-Lifecycle-Toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A TypeScript SDK and CLI for inspecting **known** Soroban ledger keys, checking their TTL risk, and producing dry-run maintenance plans.

## Important limitation

A contract ID does not reveal every contract storage key. Supply the `LedgerKey` XDR values your application knows about (for example, from contract metadata or an indexer). The toolkit does not discover or protect unlisted keys.

The MVP reads contract data and contract code entries, including the `liveUntilLedgerSeq` expiration metadata, from one Soroban RPC snapshot. It checks the RPC's network passphrase against the selected named network and verifies returned entry data re-encodes to the requested ledger key. It does not directly query TTL ledger keys: Soroban RPC rejects direct TTL-key requests. It does not construct, sign, or submit transactions. Any extension-cost estimate is explicitly illustrative; it does not replace transaction simulation or a network fee quote.

## Requirements and setup

- Node.js 20 or newer
- A Soroban RPC endpoint accessible from the environment

```sh
npm ci
npm run build
```

The package exposes the `soroban-storage` CLI and a programmatic SDK through `src/index.ts` / the package root.

## Create a known contract-data key

The example below encodes a contract data key whose storage key is an ScVal symbol. Adapt the ScVal construction to match the key type used by your contract:

```sh
node examples/contract-data-key.mjs <CONTRACT_ID> COUNTER persistent
```

Copy the printed base64 XDR into `--key`, or put one key per line in a keys file. Blank lines and lines beginning with `#` are ignored.

## CLI

```sh
# Inspect one or more known keys on Testnet
node dist/cli.js inspect --key '<BASE64_LEDGER_KEY_XDR>'
node dist/cli.js inspect --keys-file ./known-keys.txt --format json --output report.json

# Export CSV
node dist/cli.js inspect --keys-file ./known-keys.txt --format csv

# Create a dry-run plan targeting at least 30 days of remaining TTL
node dist/cli.js plan --keys-file ./known-keys.txt --target-days 30 --format json
```

Supported networks are `testnet`, `mainnet`, `futurenet`, and `custom`. Built-in networks have default RPC URLs; custom endpoints require `--rpc-url`. A custom endpoint must use HTTPS, except for localhost. RPC URLs containing username/password credentials are rejected.

Global connection and risk options can be passed before the command:

```sh
node dist/cli.js --network custom --rpc-url https://rpc.example.org \
  --critical-days 7 --warning-days 30 inspect --key '<BASE64_LEDGER_KEY_XDR>'
```

You can also use `--config config.json`, `STELLAR_NETWORK`, and `STELLAR_RPC_URL`. CLI options override config-file values, which override environment/default values. See [`config.example.json`](config.example.json). Risk defaults are 7 critical days and 30 warning days; the default ledger interval is five seconds and can be changed with `ledgerCloseSeconds`.

For custom endpoints, set `networkPassphrase` in the config or pass `--network-passphrase` to pin the expected Stellar network passphrase. Named networks are checked against their canonical passphrases automatically.

For RPC providers requiring bearer authentication, set `STELLAR_RPC_AUTH_TOKEN` in the environment. The token is sent in the Authorization header and is never included in the report. Avoid putting credentials in endpoint URLs or committed config files.

The CLI accepts up to 200 unique contract data/code keys per call. Reports include the verified network passphrase, snapshot ledger, ledger-time assumption, entry modification ledger, TTL expiration ledger when supplied by RPC, estimated remaining ledgers/days, risk, and the known-key limitation. Output formats are `table`, `json`, and `csv`.

## Extension-cost estimate

The planner reports no cost estimate unless you explicitly configure `rentFeePerByteLedger` (or pass `--rent-fee-per-byte-ledger`). When configured, the estimate is:

```text
ledger-entry data XDR byte length × added TTL ledgers × configured stroops per byte-ledger
```

This is a user-supplied planning approximation, not the protocol's authoritative rent calculation. The report states the assumption; actual cost depends on current network configuration and transaction simulation. No transaction is generated or submitted.

## SDK

```ts
import {
  createInspectionReport,
  createMaintenancePlan,
  resolveConfig,
  SorobanRpcClient,
} from "soroban-storage-lifecycle-toolkit";

const config = await resolveConfig({ network: "testnet" });
const snapshot = await new SorobanRpcClient(config).inspect([ledgerKeyXdr]);
const report = createInspectionReport(
  config.network,
  snapshot.latestLedger,
  snapshot.entries,
  config,
  snapshot.networkPassphrase,
);
const plan = createMaintenancePlan(report, config, 30);
```

The SDK validates the LedgerKey XDR and supports only TTL-managed Soroban contract data/code keys. It derives the related TTL key for inclusion in reports, but obtains expiration from the `liveUntilLedgerSeq` metadata on the storage entry response rather than querying TTL keys directly. If an RPC provider omits that metadata, expiration and risk are reported as unknown rather than inferred. Named networks are checked by passphrase; custom endpoints report their returned passphrase without asserting its identity.

SDK failures use the exported `ToolkitError` class and stable `code` values (`INVALID_INPUT`, `CONFIGURATION`, `NETWORK_MISMATCH`, `RPC_TRANSPORT`, `RPC_HTTP`, `RPC_ERROR`, `RPC_RESPONSE`, and `ABORTED`). Pass an optional `AbortSignal` as the second argument to `SorobanRpcClient.inspect(keys, signal)` to cancel in-flight RPC calls and retry waits. Missing expiration metadata remains a successful inspection with a `null` ledger and `unknown` risk; strict callers can use `requireLiveUntilLedgerSeq(entry)`, which raises `TTL_METADATA_UNAVAILABLE`. Typed errors preserve the underlying cause where available; avoid logging causes if your application treats transport details as sensitive.

## Development

```sh
npm run typecheck
npm test
```

The Testnet integration test queries the built-in native asset contract's known instance key. You can override it with `STORAGE_LEDGER_KEY_XDR` and change the endpoint with `STELLAR_RPC_URL`:

```sh
npm run test:integration
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidance.
