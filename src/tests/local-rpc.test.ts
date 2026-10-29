// Deterministic tests against a local Soroban RPC stand-in served over real
// HTTP on 127.0.0.1. They use the same ledger keys as the Testnet integration
// tests but never touch the network, so they run as part of `npm test`.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import type { ToolkitConfig } from "../config.js";
import { ToolkitError } from "../errors.js";
import {
  createInspectionReport,
  createMaintenancePlan,
} from "../maintenance-planner.js";
import { formatReport } from "../report.js";
import { requireLiveUntilLedgerSeq, SorobanRpcClient } from "../rpc-client.js";
import {
  contractCodeKey,
  MISSING_CONTRACT_CODE_KEY,
  MISSING_CONTRACT_DATA_KEY,
  NATIVE_ASSET_CONTRACT,
  NATIVE_ASSET_INSTANCE_KEY,
  TESTNET_PASSPHRASE,
} from "./fixtures.js";

const LATEST_LEDGER = 1_000;

interface LedgerFixture {
  xdr: string;
  lastModifiedLedgerSeq: number;
  /** Omitted from the response when undefined, like some RPC providers. */
  liveUntilLedgerSeq?: number;
}

const contractDataXdr = xdr.LedgerEntryData.contractData(
  new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: NATIVE_ASSET_CONTRACT,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
    val: xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        storage: null,
      }),
    ),
  }),
).toXDR("base64");

const wasmHash = Buffer.alloc(32, 0xc0);
const CONTRACT_CODE_KEY = contractCodeKey(wasmHash);
const contractCodeXdr = xdr.LedgerEntryData.contractCode(
  new xdr.ContractCodeEntry({
    ext: xdr.ContractCodeEntryExt.v0(),
    hash: wasmHash,
    code: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
  }),
).toXDR("base64");

class LocalRpc {
  ledger = new Map<string, LedgerFixture>();
  requestedKeys: string[][] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void (async () => {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
        }
        const rpc = JSON.parse(body) as {
          id: number;
          method: string;
          params: { keys?: string[] };
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(this.handle(rpc)));
      })().catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private handle(rpc: {
    id: number;
    method: string;
    params: { keys?: string[] };
  }): unknown {
    if (rpc.method === "getNetwork") {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { passphrase: TESTNET_PASSPHRASE, protocolVersion: 23 },
      };
    }
    if (rpc.method !== "getLedgerEntries") {
      // A minimal provider: optional methods such as getLedgers are absent.
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "method not found" },
      };
    }
    const keys = rpc.params.keys ?? [];
    this.requestedKeys.push(keys);
    // Like Soroban RPC, missing keys are simply absent from `entries`.
    const entries = keys.flatMap((key) => {
      const fixture = this.ledger.get(key);
      return fixture ? [{ key, ...fixture }] : [];
    });
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: { latestLedger: LATEST_LEDGER, entries },
    };
  }
}

describe("local RPC (deterministic)", () => {
  const rpc = new LocalRpc();
  let config: ToolkitConfig;

  before(async () => {
    await rpc.start();
    config = {
      network: "testnet",
      rpcUrl: rpc.url,
      criticalDays: 7,
      warningDays: 30,
      ledgerCloseSeconds: 5,
    };
  });
  after(() => rpc.stop());

  function useLedger(entries: Record<string, LedgerFixture>): void {
    rpc.ledger = new Map(Object.entries(entries));
    rpc.requestedKeys = [];
  }

  test("returns contract-data and contract-code entries with expiration metadata", async () => {
    useLedger({
      [NATIVE_ASSET_INSTANCE_KEY]: {
        xdr: contractDataXdr,
        lastModifiedLedgerSeq: 900,
        liveUntilLedgerSeq: 2_000_000,
      },
      [CONTRACT_CODE_KEY]: {
        xdr: contractCodeXdr,
        lastModifiedLedgerSeq: 950,
        liveUntilLedgerSeq: 3_000,
      },
    });
    const snapshot = await new SorobanRpcClient(config).inspect([
      NATIVE_ASSET_INSTANCE_KEY,
      CONTRACT_CODE_KEY,
    ]);
    assert.equal(snapshot.latestLedger, LATEST_LEDGER);
    assert.deepEqual(
      snapshot.entries.map(
        ({ key, keyType, durability, found, ...ledger }) => ({
          key,
          keyType,
          durability,
          found,
          lastModifiedLedgerSeq: ledger.lastModifiedLedgerSeq,
          liveUntilLedgerSeq: ledger.liveUntilLedgerSeq,
          entryBytes: ledger.entryBytes,
        }),
      ),
      [
        {
          key: NATIVE_ASSET_INSTANCE_KEY,
          keyType: "contractData",
          durability: "persistent",
          found: true,
          lastModifiedLedgerSeq: 900,
          liveUntilLedgerSeq: 2_000_000,
          entryBytes: Buffer.from(contractDataXdr, "base64").length,
        },
        {
          key: CONTRACT_CODE_KEY,
          keyType: "contractCode",
          durability: null,
          found: true,
          lastModifiedLedgerSeq: 950,
          liveUntilLedgerSeq: 3_000,
          entryBytes: Buffer.from(contractCodeXdr, "base64").length,
        },
      ],
    );
  });

  test("reports keys absent from the provider response as not found", async () => {
    useLedger({
      [NATIVE_ASSET_INSTANCE_KEY]: {
        xdr: contractDataXdr,
        lastModifiedLedgerSeq: 900,
        liveUntilLedgerSeq: 2_000_000,
      },
    });
    const keys = [
      MISSING_CONTRACT_CODE_KEY,
      NATIVE_ASSET_INSTANCE_KEY,
      MISSING_CONTRACT_DATA_KEY,
    ];
    const snapshot = await new SorobanRpcClient(config).inspect(keys);
    assert.deepEqual(rpc.requestedKeys, [keys]);
    assert.deepEqual(
      snapshot.entries.map((entry) => [entry.key, entry.keyType, entry.found]),
      [
        [MISSING_CONTRACT_CODE_KEY, "contractCode", false],
        [NATIVE_ASSET_INSTANCE_KEY, "contractData", true],
        [MISSING_CONTRACT_DATA_KEY, "contractData", false],
      ],
    );
    for (const entry of [snapshot.entries[0]!, snapshot.entries[2]!]) {
      assert.equal(entry.lastModifiedLedgerSeq, null);
      assert.equal(entry.liveUntilLedgerSeq, null);
      assert.equal(entry.entryBytes, null);
    }

    const report = createInspectionReport(
      "testnet",
      snapshot.latestLedger,
      snapshot.entries,
      config,
      snapshot.networkPassphrase,
    );
    assert.deepEqual(
      report.entries.map((entry) => entry.risk),
      ["unknown", "healthy", "unknown"],
    );
    const plan = createMaintenancePlan(report, config, 30);
    assert.deepEqual(
      plan.plan.actions.map((action) => [action.action, action.reason]),
      [
        ["unavailable", "storage-entry-not-found"],
        ["no-op", "existing-ttl-meets-target"],
        ["unavailable", "storage-entry-not-found"],
      ],
    );
  });

  test("treats omitted expiration metadata as unknown, not expired", async () => {
    useLedger({
      [NATIVE_ASSET_INSTANCE_KEY]: {
        xdr: contractDataXdr,
        lastModifiedLedgerSeq: 900,
      },
      [CONTRACT_CODE_KEY]: {
        xdr: contractCodeXdr,
        lastModifiedLedgerSeq: 950,
        liveUntilLedgerSeq: 1_100,
      },
    });
    const snapshot = await new SorobanRpcClient(config).inspect([
      NATIVE_ASSET_INSTANCE_KEY,
      CONTRACT_CODE_KEY,
    ]);
    const [withoutTtl, withTtl] = snapshot.entries;
    assert.equal(withoutTtl?.found, true);
    assert.equal(withoutTtl?.lastModifiedLedgerSeq, 900);
    assert.equal(withoutTtl?.liveUntilLedgerSeq, null);
    // A neighbouring entry's metadata must not leak into the omitted one.
    assert.equal(withTtl?.liveUntilLedgerSeq, 1_100);

    assert.throws(
      () => requireLiveUntilLedgerSeq(withoutTtl!),
      (error: unknown) =>
        error instanceof ToolkitError &&
        error.code === "TTL_METADATA_UNAVAILABLE" &&
        /not returned by the RPC provider/.test(error.message),
    );
    assert.equal(requireLiveUntilLedgerSeq(withTtl!), 1_100);

    const report = createInspectionReport(
      "testnet",
      snapshot.latestLedger,
      snapshot.entries,
      config,
      snapshot.networkPassphrase,
    );
    assert.equal(report.entries[0]?.risk, "unknown");
    assert.equal(report.entries[0]?.remainingDays, null);
    assert.equal(report.entries[1]?.risk, "critical");

    const plan = createMaintenancePlan(report, config, 30);
    assert.equal(plan.plan.actions[0]?.action, "unavailable");
    assert.equal(
      plan.plan.actions[0]?.reason,
      "expiration-metadata-unavailable",
    );
    assert.equal(plan.plan.estimatedTotalStroops, null);

    const json = JSON.parse(formatReport(report, "json")) as {
      entries: Array<{ liveUntilLedgerSeq: number | null }>;
    };
    assert.equal(json.entries[0]?.liveUntilLedgerSeq, null);
    const dataRow = formatReport(report, "table")
      .split("\n")
      .find((line) => line.includes("contractData"));
    assert.match(
      dataRow ?? "",
      /\| yes \| 900 \| unknown \| unknown \| unknown/,
    );
  });
});
