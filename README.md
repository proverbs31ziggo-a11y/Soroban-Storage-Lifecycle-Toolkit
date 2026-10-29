# Soroban Storage Lifecycle Toolkit

[![CI](https://github.com/proverbs31ziggo-a11y/Soroban-Storage-Lifecycle-Toolkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/proverbs31ziggo-a11y/Soroban-Storage-Lifecycle-Toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A TypeScript SDK and CLI for inspecting **known** Soroban ledger keys, checking their TTL risk, and producing dry-run maintenance plans.

## Important limitation

A contract ID does not reveal every contract storage key. Supply the `LedgerKey` XDR values your application knows about (for example, from contract metadata or an indexer). The toolkit does not discover or protect unlisted keys.

The MVP reads contract data and contract code entries, including the `liveUntilLedgerSeq` expiration metadata, from Soroban RPC. Up to 200 keys are read in one `getLedgerEntries` request (a single ledger snapshot); larger inputs are split into requests of at most 200 keys, which Soroban RPC cannot pin to one ledger (see [Key limits and chunking](#key-limits-and-chunking)). It checks the RPC's network passphrase against the selected named network and verifies returned entry data re-encodes to the requested ledger key. It does not directly query TTL ledger keys: Soroban RPC rejects direct TTL-key requests. It does not construct, sign, or submit transactions. Any extension-cost estimate is explicitly illustrative; it does not replace transaction simulation or a network fee quote.

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

For reviewable key inventories, use a versioned JSON manifest:

```json
{
  "version": 1,
  "entries": [
    {
      "name": "counter",
      "key": "<BASE64_LEDGER_KEY_XDR>",
      "owner": "payments team",
      "notes": "Persistent contract counter"
    }
  ]
}
```

Run either command with `--manifest ./storage-keys.json` in place of `--key` or `--keys-file`. A manifest may contain up to 1,000 unique names and keys; it does not discover keys or imply complete contract-storage coverage. Manifest metadata is included with its matching entry in reports.

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

You can also use `--config config.json`, `STELLAR_NETWORK`, and `STELLAR_RPC_URL`. CLI options override config-file values, which override environment/default values. See [`config.example.json`](config.example.json). Risk defaults are 7 critical days and 30 warning days. The toolkit samples the latest 10 ledger intervals from the RPC `getLedgers` close-time metadata and uses that observed cadence only when the 11-ledger window is complete, strictly increasing, and every interval is at most 60 seconds. If history or timestamps are unavailable or invalid, `ledgerCloseSeconds` (five seconds by default) is used as an explicit fallback. Reports and plans include the cadence source, sampling window, and fallback reason when applicable.

For custom endpoints, set `networkPassphrase` in the config or pass `--network-passphrase` to pin the expected Stellar network passphrase. Named networks are checked against their canonical passphrases automatically.

For RPC providers requiring bearer authentication, set `STELLAR_RPC_AUTH_TOKEN` in the environment. The token is sent in the Authorization header and is never included in the report. Avoid putting credentials in endpoint URLs or committed config files.

The CLI accepts up to 1,000 unique contract data/code keys per call (see [Key limits and chunking](#key-limits-and-chunking)). Reports include the verified network passphrase, snapshot ledger, ledger-time assumption and its source/sampling window, entry modification ledger, TTL expiration ledger when supplied by RPC, estimated remaining ledgers/days, risk, and the known-key limitation. Output formats are `table`, `json`, and `csv`. CSV text cells beginning with spreadsheet formula markers (`=`, `+`, `-`, or `@`, including after leading whitespace/control characters) are prefixed with an apostrophe to reduce formula-injection risk; numeric report values remain numeric.

## Key limits and chunking

- At most **1,000** unique keys per inspection (`MAX_INSPECT_KEYS`). Larger inputs are rejected before any RPC call.
- Keys are sent in sequential `getLedgerEntries` requests of at most **200** keys (`MAX_KEYS_PER_RPC_REQUEST`, the Soroban RPC per-request limit). Each request body is also capped at 1 MB. SDK users can lower the chunk size for providers with stricter limits: `new SorobanRpcClient(config, fetch, { maxKeysPerRequest: 50 })`.
- Each response is checked only against the keys sent in that request. Malformed, duplicate, or unrequested entries fail the whole inspection.
- If any request fails, the inspection fails and no report is produced; there are no partial reports. Errors name the failed request (for example `getLedgerEntries request 2 of 5 failed: ...`).
- Entries keep the order the keys were supplied in, regardless of response order.

**Snapshot consistency.** Soroban RPC cannot pin separate requests to one ledger. When more than one request is needed, entries may come from different ledgers. The report's `latestLedger` is the highest ledger seen across requests, so remaining TTL is measured conservatively, and the report adds a limitation naming the request count and observed ledger range. The SDK exposes the same data as `RpcSnapshot.consistency` (`requestCount`, `oldestLedger`, `latestLedger`). Inspect 200 or fewer keys when you need a single-ledger snapshot.

## Extension-cost estimate

The planner reports no cost estimate unless you explicitly configure `rentFeePerByteLedger` (or pass `--rent-fee-per-byte-ledger`). When configured, the estimate is:

```text
ledger-entry data XDR byte length × added TTL ledgers × configured stroops per byte-ledger
```

This is a user-supplied planning approximation, not the protocol's authoritative rent calculation. The report states the assumption; actual cost depends on current network configuration and transaction simulation. No transaction is generated or submitted.

## JSON report schema

The versioned [JSON Schema for report version 1](schemas/report-v1.schema.json) describes both inspection reports and dry-run plans. JSON consumers should check `schemaVersion` before processing reports. Additive optional metadata may be introduced without changing the schema version; changes to required fields, field meaning, or enum values require a new schema version. `remainingDays` and plan target ledgers use the reported effective ledger interval; `estimatedCostStroops` and `estimatedTotalStroops` are optional illustrative estimates, not quotes.

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
  snapshot.ledgerCloseInterval,
);
const plan = createMaintenancePlan(report, config, 30);
```

The SDK validates the LedgerKey XDR and supports only TTL-managed Soroban contract data/code keys. It derives the related TTL key for inclusion in reports, but obtains expiration from the `liveUntilLedgerSeq` metadata on the storage entry response rather than querying TTL keys directly. If an RPC provider omits that metadata, expiration and risk are reported as unknown rather than inferred. Named networks are checked by passphrase; custom endpoints report their returned passphrase without asserting its identity.

SDK failures use the exported `ToolkitError` class and stable `code` values (`INVALID_INPUT`, `CONFIGURATION`, `NETWORK_MISMATCH`, `ABORTED`, `RPC_TRANSPORT`, `RPC_HTTP`, `RPC_ERROR`, and `RPC_RESPONSE`). Missing expiration metadata remains a successful inspection with a `null` ledger and `unknown` risk; strict callers can use `requireLiveUntilLedgerSeq(entry)`, which raises `TTL_METADATA_UNAVAILABLE`. Typed errors preserve the underlying cause where available; avoid logging causes if your application treats transport details as sensitive.

An inspection can be cancelled by passing an `AbortSignal` in its options. Cancellation stops active RPC fetches and retry waits, and rejects with a `ToolkitError` whose code is `ABORTED`:

```ts
const controller = new AbortController();
const inspection = new SorobanRpcClient(config).inspect([ledgerKeyXdr], {
  signal: controller.signal,
});
controller.abort();
await inspection;
```

## Development

```sh
npm run typecheck
npm test
```

`npm test` is fully offline: it includes deterministic tests against a local RPC stand-in on `127.0.0.1` that cover contract-data and contract-code keys, missing keys, and providers that omit expiration metadata.

Read-only checks against Stellar Testnet are separate:

```sh
npm run test:integration
```

By default they inspect the native asset contract's instance key and keys that cannot exist. A live contract-code check runs only when you supply a WASM hash, because Testnet resets remove uploaded WASM. See [Integration tests](CONTRIBUTING.md#integration-tests) for all overrides.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidance.

For scheduled/read-only operation, token handling, provider failures, and
incident response, see the [operations runbook](docs/OPERATIONS.md).
