// Network-dependent tests against Stellar Testnet. Run with
// `npm run test:integration`; they are not part of `npm test`.
//
// Every request is a read-only getNetwork/getLedgerEntries call. Default
// fixtures only use protocol-owned state (the native-asset contract) or keys
// that cannot exist, so they survive Testnet resets and are not affected by
// user activity. See "Integration tests" in CONTRIBUTING.md for overrides.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveConfig, type ToolkitConfig } from "../config.js";
import { ToolkitError } from "../errors.js";
import {
  createInspectionReport,
  createMaintenancePlan,
} from "../maintenance-planner.js";
import {
  requireLiveUntilLedgerSeq,
  SorobanRpcClient,
  type RpcSnapshot,
} from "../rpc-client.js";
import {
  liveContractCodeKey,
  liveContractDataKey,
  MISSING_CONTRACT_CODE_KEY,
  MISSING_CONTRACT_DATA_KEY,
  TESTNET_PASSPHRASE,
} from "./fixtures.js";

const contractDataKey = liveContractDataKey();
const contractCodeKey = liveContractCodeKey();

async function testnetConfig(): Promise<ToolkitConfig> {
  // STELLAR_RPC_URL and STELLAR_RPC_AUTH_TOKEN are read by resolveConfig.
  return resolveConfig({ network: "testnet" });
}

async function inspect(keys: string[]): Promise<RpcSnapshot> {
  return new SorobanRpcClient(await testnetConfig()).inspect(keys);
}

function assertSnapshotHeader(snapshot: RpcSnapshot): void {
  assert.equal(snapshot.networkPassphrase, TESTNET_PASSPHRASE);
  assert.ok(
    Number.isSafeInteger(snapshot.latestLedger) && snapshot.latestLedger > 0,
  );
}

describe("Stellar Testnet (network)", () => {
  test("inspects a known contract-data key", async () => {
    const snapshot = await inspect([contractDataKey]);
    assertSnapshotHeader(snapshot);
    assert.equal(snapshot.entries.length, 1);
    const entry = snapshot.entries[0]!;
    assert.equal(entry.key, contractDataKey);
    assert.equal(entry.keyType, "contractData");
    assert.equal(entry.found, true);
    assert.ok((entry.entryBytes ?? 0) > 0);
    assert.ok(
      entry.lastModifiedLedgerSeq !== null &&
        entry.lastModifiedLedgerSeq <= snapshot.latestLedger,
    );
    assert.ok((entry.liveUntilLedgerSeq ?? 0) > snapshot.latestLedger);
  });

  test(
    "inspects a known contract-code key",
    {
      skip: contractCodeKey
        ? false
        : "set STORAGE_CONTRACT_CODE_WASM_HASH or STORAGE_CONTRACT_CODE_KEY_XDR to enable",
    },
    async () => {
      const snapshot = await inspect([contractCodeKey!]);
      assertSnapshotHeader(snapshot);
      const entry = snapshot.entries[0]!;
      assert.equal(entry.key, contractCodeKey);
      assert.equal(entry.keyType, "contractCode");
      assert.equal(entry.durability, null);
      assert.equal(
        entry.found,
        true,
        "configured contract-code fixture was not found; Testnet may have been reset",
      );
      assert.ok((entry.entryBytes ?? 0) > 0);
      // Code can be archived without being deleted, so only require that the
      // provider returned a ledger number, not that it is in the future.
      assert.ok(Number.isSafeInteger(entry.liveUntilLedgerSeq));
    },
  );

  test("reports missing contract-data and contract-code keys as not found", async () => {
    const keys = [
      MISSING_CONTRACT_CODE_KEY,
      contractDataKey,
      MISSING_CONTRACT_DATA_KEY,
    ];
    const snapshot = await inspect(keys);
    assertSnapshotHeader(snapshot);
    // Results keep request order, and one found key does not hide the others.
    assert.deepEqual(
      snapshot.entries.map((entry) => [entry.key, entry.found]),
      [
        [MISSING_CONTRACT_CODE_KEY, false],
        [contractDataKey, true],
        [MISSING_CONTRACT_DATA_KEY, false],
      ],
    );
    for (const entry of [snapshot.entries[0]!, snapshot.entries[2]!]) {
      assert.equal(entry.lastModifiedLedgerSeq, null);
      assert.equal(entry.liveUntilLedgerSeq, null);
      assert.equal(entry.entryBytes, null);
      assert.throws(
        () => requireLiveUntilLedgerSeq(entry),
        (error: unknown) =>
          error instanceof ToolkitError &&
          error.code === "TTL_METADATA_UNAVAILABLE" &&
          /not found/.test(error.message),
      );
    }

    const config = await testnetConfig();
    const report = createInspectionReport(
      "testnet",
      snapshot.latestLedger,
      snapshot.entries,
      config,
      snapshot.networkPassphrase,
    );
    assert.equal(report.entries[0]?.risk, "unknown");
    assert.equal(report.entries[2]?.risk, "unknown");
    const plan = createMaintenancePlan(report, config, 30);
    assert.equal(plan.plan.actions[0]?.reason, "storage-entry-not-found");
    assert.equal(plan.plan.actions[2]?.reason, "storage-entry-not-found");
    assert.equal(plan.plan.estimatedTotalStroops, null);
  });
});
