import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import { ToolkitError } from "../errors.js";
import type { ToolkitConfig } from "../config.js";
import { parseStorageKey } from "../ledger-key.js";
import { requireLiveUntilLedgerSeq, SorobanRpcClient } from "../rpc-client.js";

const config: ToolkitConfig = {
  network: "testnet",
  rpcUrl: "https://rpc.example.test",
  criticalDays: 7,
  warningDays: 30,
  ledgerCloseSeconds: 5,
};

interface RpcRequest {
  id: number;
  method: string;
  params: { keys?: string[] };
}

function rpcStub(
  handleLedgerRequest: (request: RpcRequest) => Promise<Response>,
  passphrase = "Test SDF Network ; September 2015",
): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    if (request.method === "getNetwork") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { passphrase, protocolVersion: 29 },
      });
    }
    return handleLedgerRequest(request);
  };
}

test("retrieves a known entry and its expiration metadata from one RPC snapshot", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 3) }),
  ).toXDR("base64");
  const parsedKey = parseStorageKey(key);
  const storageValue = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: Buffer.alloc(32, 3),
      code: Buffer.from([1, 2, 3]),
    }),
  ).toXDR("base64");
  let requestedKeys: string[] = [];
  const fetchStub = rpcStub(async (request) => {
    requestedKeys = request.params.keys ?? [];
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        latestLedger: 100,
        entries: [
          {
            key,
            xdr: storageValue,
            lastModifiedLedgerSeq: 99,
            liveUntilLedgerSeq: 150,
          },
        ],
      },
    });
  });

  const result = await new SorobanRpcClient(config, fetchStub).inspect([key]);
  assert.deepEqual(requestedKeys, [parsedKey.xdr]);
  assert.equal(result.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(result.latestLedger, 100);
  assert.equal(result.entries[0]?.found, true);
  assert.equal(result.entries[0]?.durability, null);
  assert.equal(result.entries[0]?.liveUntilLedgerSeq, 150);
  assert.ok(result.entries[0]?.entryBytes);
});

test("treats omitted expiration metadata as unknown and rejects invalid metadata", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 4) }),
  ).toXDR("base64");
  const storageValue = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: Buffer.alloc(32, 4),
      code: Buffer.from([9]),
    }),
  ).toXDR("base64");
  const fetchWithoutTtl = rpcStub(async (request) =>
    Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        latestLedger: 100,
        entries: [
          {
            key,
            xdr: storageValue,
            lastModifiedLedgerSeq: 100,
          },
        ],
      },
    }),
  );
  const unknownResult = await new SorobanRpcClient(
    config,
    fetchWithoutTtl,
  ).inspect([key]);
  assert.equal(unknownResult.entries[0]?.liveUntilLedgerSeq, null);

  const fetchInvalidTtl = rpcStub(async (request) =>
    Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        latestLedger: 100,
        entries: [
          {
            key,
            xdr: storageValue,
            lastModifiedLedgerSeq: 100,
            liveUntilLedgerSeq: -1,
          },
        ],
      },
    }),
  );
  await assert.rejects(
    new SorobanRpcClient(config, fetchInvalidTtl).inspect([key]),
    /invalid ledger entry/,
  );
});

test("rejects ledger data that does not encode the requested ledger key", async () => {
  const requestedKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 4) }),
  ).toXDR("base64");
  const mismatchedData = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: Buffer.alloc(32, 5),
      code: Buffer.from([9]),
    }),
  ).toXDR("base64");
  const fetchStub = rpcStub(async (request) =>
    Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        latestLedger: 100,
        entries: [
          {
            key: requestedKey,
            xdr: mismatchedData,
            lastModifiedLedgerSeq: 100,
            liveUntilLedgerSeq: 200,
          },
        ],
      },
    }),
  );

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([requestedKey]),
    /does not match requested key/,
  );
});

test("rejects mismatched JSON-RPC response identifiers", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 6) }),
  ).toXDR("base64");
  const fetchStub = rpcStub(async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: { latestLedger: 100, entries: [] },
    }),
  );

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([key]),
    /mismatched JSON-RPC/,
  );
});

test("refuses an RPC endpoint on the wrong named network", async () => {
  let ledgerRequestMade = false;
  const fetchStub = rpcStub(async () => {
    ledgerRequestMade = true;
    return Response.json({});
  }, "Public Global Stellar Network ; September 2015");
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 7) }),
  ).toXDR("base64");

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([key]),
    (error: unknown) => {
      assert.ok(error instanceof ToolkitError);
      assert.equal(error.code, "NETWORK_MISMATCH");
      assert.match(
        error.message,
        /does not match the configured expectation for "testnet"/,
      );
      return true;
    },
  );
  assert.equal(ledgerRequestMade, false);
});

test("classifies transport and malformed RPC failures without leaking endpoint query values", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 13) }),
  ).toXDR("base64");
  const privateUrlConfig = {
    ...config,
    rpcUrl: "https://rpc.example.test/v1?api-key=private",
  };
  const failingFetch: typeof fetch = async () => {
    throw new Error("transport failed for private endpoint");
  };
  await assert.rejects(
    new SorobanRpcClient(privateUrlConfig, failingFetch).inspect([key]),
    (error: unknown) => {
      assert.ok(error instanceof ToolkitError);
      assert.equal(error.code, "RPC_TRANSPORT");
      assert.doesNotMatch(error.message, /private|api-key/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );

  const malformedFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    if (request.method === "getNetwork") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          passphrase: "Test SDF Network ; September 2015",
          protocolVersion: 29,
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { latestLedger: "invalid", entries: [] },
    });
  };
  await assert.rejects(
    new SorobanRpcClient(config, malformedFetch).inspect([key]),
    (error: unknown) => {
      assert.ok(error instanceof ToolkitError);
      assert.equal(error.code, "RPC_RESPONSE");
      return true;
    },
  );
});

test("classifies missing expiration metadata for strict SDK consumers", () => {
  assert.throws(
    () =>
      requireLiveUntilLedgerSeq({
        key: "known-key",
        found: true,
        liveUntilLedgerSeq: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ToolkitError);
      assert.equal(error.code, "TTL_METADATA_UNAVAILABLE");
      assert.match(error.message, /not returned by the RPC provider/);
      return true;
    },
  );
});

test("retries transient RPC failures without retrying successful requests", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 8) }),
  ).toXDR("base64");
  let ledgerAttempts = 0;
  const fetchStub = rpcStub(async (request) => {
    ledgerAttempts += 1;
    if (ledgerAttempts === 1) {
      return Response.json(
        { error: "temporarily unavailable" },
        { status: 503 },
      );
    }
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { latestLedger: 100, entries: [] },
    });
  });

  const snapshot = await new SorobanRpcClient(config, fetchStub).inspect([key]);
  assert.equal(ledgerAttempts, 2);
  assert.equal(snapshot.latestLedger, 100);
});

test("rejects RPC responses larger than the configured safety limit", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 9) }),
  ).toXDR("base64");
  const fetchStub = rpcStub(
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(26 * 1024 * 1024) },
      }),
  );

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([key]),
    /response exceeds the 26214400-byte safety limit/,
  );
});

test("sends bearer tokens only in the authorization header", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 10) }),
  ).toXDR("base64");
  const observed: string[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    const headers = new Headers(init?.headers);
    observed.push(headers.get("authorization") ?? "");
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "getNetwork"
          ? {
              passphrase: "Test SDF Network ; September 2015",
              protocolVersion: 29,
            }
          : { latestLedger: 100, entries: [] },
    });
  };

  await new SorobanRpcClient(
    { ...config, rpcAuthToken: "secret-token" },
    fetchStub,
  ).inspect([key]);
  assert.deepEqual(observed, ["Bearer secret-token", "Bearer secret-token"]);
  assert.ok(observed.every((header) => !header.includes(config.rpcUrl)));
});

test("does not echo RPC URL query credentials in transport errors", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 11) }),
  ).toXDR("base64");
  const privateUrlConfig = {
    ...config,
    rpcUrl: "https://rpc.example.test/v1?api-key=private",
  };
  const fetchStub: typeof fetch = async () => {
    throw new Error(
      "failed fetching https://rpc.example.test/v1?api-key=private",
    );
  };

  await assert.rejects(
    new SorobanRpcClient(privateUrlConfig, fetchStub).inspect([key]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private|api-key/);
      return true;
    },
  );
});

test("does not send RPC requests when inspection is already aborted", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 14) }),
  ).toXDR("base64");
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const fetchStub: typeof fetch = async () => {
    requests += 1;
    return Response.json({});
  };

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([key], controller.signal),
    (error: unknown) =>
      error instanceof ToolkitError && error.code === "ABORTED",
  );
  assert.equal(requests, 0);
});

test("cancels an in-flight RPC request without retrying", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 15) }),
  ).toXDR("base64");
  const controller = new AbortController();
  let requests = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetchStub: typeof fetch = async (_input, init) => {
    requests += 1;
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const requestSignal = init?.signal;
      if (!requestSignal) {
        reject(new Error("RPC request did not receive an abort signal"));
        return;
      }
      requestSignal.addEventListener(
        "abort",
        () => reject(requestSignal.reason),
        { once: true },
      );
    });
  };

  const inspection = new SorobanRpcClient(config, fetchStub).inspect(
    [key],
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(
    inspection,
    (error: unknown) =>
      error instanceof ToolkitError && error.code === "ABORTED",
  );
  assert.equal(requests, 1);
});

test("cancels retry backoff when the caller aborts", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 16) }),
  ).toXDR("base64");
  const controller = new AbortController();
  let ledgerRequests = 0;
  const fetchStub: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    if (request.method === "getNetwork") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          passphrase: "Test SDF Network ; September 2015",
          protocolVersion: 29,
        },
      });
    }
    ledgerRequests += 1;
    setTimeout(() => controller.abort(), 10);
    return Response.json({ error: "temporarily unavailable" }, { status: 503 });
  };

  await assert.rejects(
    new SorobanRpcClient(config, fetchStub).inspect([key], controller.signal),
    (error: unknown) =>
      error instanceof ToolkitError && error.code === "ABORTED",
  );
  assert.equal(ledgerRequests, 1);
});
