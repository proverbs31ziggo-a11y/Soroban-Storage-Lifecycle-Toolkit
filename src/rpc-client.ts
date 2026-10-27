import {
  parseStorageKey,
  decodeLedgerEntryData,
  ledgerKeyFromEntryData,
} from "./ledger-key.js";
import type { ToolkitConfig } from "./config.js";
import { xdr } from "@stellar/stellar-sdk";
import { errorMessage, ToolkitError } from "./errors.js";

const MAX_STORAGE_KEYS = 200;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_ENTRY_XDR_BYTES = 10 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_LEDGER_SEQUENCE = 0xffff_ffff;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RPC_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 250] as const;
const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
} as const;

interface RpcLedgerEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq: number | null;
}

interface RpcLedgerSnapshot {
  latestLedger: number;
  entries: Map<string, RpcLedgerEntry>;
}

export interface InspectedEntry {
  key: string;
  name?: string;
  owner?: string;
  notes?: string;
  keyType: "contractData" | "contractCode";
  durability: "temporary" | "persistent" | null;
  ttlKey: string;
  found: boolean;
  lastModifiedLedgerSeq: number | null;
  liveUntilLedgerSeq: number | null;
  entryBytes: number | null;
}

export interface RpcSnapshot {
  networkPassphrase: string;
  latestLedger: number;
  entries: InspectedEntry[];
}

export function requireLiveUntilLedgerSeq(
  entry: Pick<InspectedEntry, "key" | "found" | "liveUntilLedgerSeq">,
): number {
  if (entry.liveUntilLedgerSeq === null) {
    const reason = entry.found
      ? "expiration metadata was not returned by the RPC provider"
      : "the ledger entry was not found";
    throw new ToolkitError(
      "TTL_METADATA_UNAVAILABLE",
      `Expiration ledger is unavailable for key ${entry.key}: ${reason}`,
    );
  }
  return entry.liveUntilLedgerSeq;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalLedgerKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("RPC returned a ledger entry without a key");
  }
  try {
    const canonical = xdr.LedgerKey.fromXDR(value, "base64").toXDR("base64");
    if (canonical !== value) {
      throw new Error("non-canonical encoding");
    }
    return canonical;
  } catch (error) {
    throw new Error(`RPC returned an invalid ledger key: ${String(error)}`);
  }
}

function abortError(signal: AbortSignal): ToolkitError {
  return new ToolkitError(
    "ABORTED",
    "Soroban RPC inspection was aborted",
    signal.reason === undefined ? undefined : { cause: signal.reason },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

export class SorobanRpcClient {
  constructor(
    private readonly config: ToolkitConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async inspect(keys: string[], signal?: AbortSignal): Promise<RpcSnapshot> {
    try {
      return await this.inspectUnchecked(keys, signal);
    } catch (error) {
      if (error instanceof ToolkitError) {
        throw error;
      }
      throw new ToolkitError("RPC_RESPONSE", errorMessage(error), {
        cause: error,
      });
    }
  }

  private async inspectUnchecked(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<RpcSnapshot> {
    throwIfAborted(signal);
    if (keys.length === 0) {
      throw new ToolkitError(
        "INVALID_INPUT",
        "Provide at least one ledger key",
      );
    }
    if (keys.length > MAX_STORAGE_KEYS) {
      throw new ToolkitError(
        "INVALID_INPUT",
        `At most ${MAX_STORAGE_KEYS} storage keys can be inspected per request`,
      );
    }
    const parsedKeys = keys.map(parseStorageKey);
    const requestBytes = parsedKeys.reduce(
      (total, parsed) => total + Buffer.byteLength(parsed.xdr, "utf8"),
      0,
    );
    if (requestBytes > MAX_REQUEST_BYTES) {
      throw new ToolkitError(
        "INVALID_INPUT",
        "Combined ledger key request exceeds the 1 MB safety limit",
      );
    }
    const requested = new Set<string>();
    const uniqueStorageKeys = new Set<string>();
    for (const parsed of parsedKeys) {
      if (uniqueStorageKeys.has(parsed.xdr)) {
        throw new ToolkitError(
          "INVALID_INPUT",
          `Duplicate ledger key: ${parsed.xdr}`,
        );
      }
      uniqueStorageKeys.add(parsed.xdr);
      requested.add(parsed.xdr);
    }

    const networkPassphrase = await this.verifyNetwork(signal);
    const snapshot = await this.getLedgerEntries([...requested], signal);
    for (const returnedKey of snapshot.entries.keys()) {
      if (!requested.has(returnedKey)) {
        throw new ToolkitError(
          "RPC_RESPONSE",
          "RPC returned a ledger entry that was not requested",
        );
      }
    }

    const entries = parsedKeys.map((parsed): InspectedEntry => {
      const storage = snapshot.entries.get(parsed.xdr);
      if (storage) {
        const storageEntry = decodeLedgerEntryData(storage.xdr);
        const actualKey = ledgerKeyFromEntryData(storageEntry);
        if (actualKey !== parsed.xdr) {
          throw new ToolkitError(
            "RPC_RESPONSE",
            `RPC returned ledger data that does not match requested key ${parsed.xdr}`,
          );
        }
      }
      return {
        key: parsed.xdr,
        keyType: parsed.type,
        durability: parsed.durability,
        ttlKey: parsed.ttlKeyXdr,
        found: storage !== undefined,
        lastModifiedLedgerSeq: storage?.lastModifiedLedgerSeq ?? null,
        liveUntilLedgerSeq: storage?.liveUntilLedgerSeq ?? null,
        entryBytes: storage ? Buffer.from(storage.xdr, "base64").length : null,
      };
    });

    return { networkPassphrase, latestLedger: snapshot.latestLedger, entries };
  }

  private async verifyNetwork(signal?: AbortSignal): Promise<string> {
    const result = await this.callRpc("getNetwork", {}, signal);
    if (
      !isObject(result) ||
      typeof result.passphrase !== "string" ||
      result.passphrase.length === 0 ||
      !Number.isSafeInteger(result.protocolVersion) ||
      (result.protocolVersion as number) < 1
    ) {
      throw new Error("RPC returned an invalid getNetwork response");
    }
    const expectedPassphrase =
      this.config.expectedNetworkPassphrase ??
      (this.config.network === "custom"
        ? undefined
        : NETWORK_PASSPHRASES[this.config.network]);
    if (
      expectedPassphrase !== undefined &&
      result.passphrase !== expectedPassphrase
    ) {
      throw new ToolkitError(
        "NETWORK_MISMATCH",
        `RPC network passphrase does not match the configured expectation for "${this.config.network}"`,
      );
    }
    return result.passphrase;
  }

  private async getLedgerEntries(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<RpcLedgerSnapshot> {
    const result = await this.callRpc(
      "getLedgerEntries",
      {
        keys,
        xdrFormat: "base64",
      },
      signal,
    );
    if (
      !isObject(result) ||
      !Number.isSafeInteger(result.latestLedger) ||
      (result.latestLedger as number) < 1 ||
      (result.latestLedger as number) > MAX_LEDGER_SEQUENCE ||
      !Array.isArray(result.entries)
    ) {
      throw new Error("RPC returned an invalid getLedgerEntries response");
    }
    const latestLedger = result.latestLedger as number;
    const entries = new Map<string, RpcLedgerEntry>();
    for (const value of result.entries) {
      if (
        !isObject(value) ||
        typeof value.xdr !== "string" ||
        Buffer.byteLength(value.xdr, "utf8") > MAX_ENTRY_XDR_BYTES ||
        !Number.isSafeInteger(value.lastModifiedLedgerSeq) ||
        (value.lastModifiedLedgerSeq as number) < 0 ||
        (value.lastModifiedLedgerSeq as number) > MAX_LEDGER_SEQUENCE ||
        (value.lastModifiedLedgerSeq as number) > latestLedger ||
        (value.liveUntilLedgerSeq !== undefined &&
          (!Number.isSafeInteger(value.liveUntilLedgerSeq) ||
            (value.liveUntilLedgerSeq as number) < 0 ||
            (value.liveUntilLedgerSeq as number) > MAX_LEDGER_SEQUENCE))
      ) {
        throw new Error("RPC returned an invalid ledger entry");
      }
      const key = canonicalLedgerKey(value.key);
      if (entries.has(key)) {
        throw new Error(`RPC returned a duplicate ledger entry for ${key}`);
      }
      entries.set(key, {
        key,
        xdr: value.xdr,
        lastModifiedLedgerSeq: value.lastModifiedLedgerSeq as number,
        liveUntilLedgerSeq:
          typeof value.liveUntilLedgerSeq === "number"
            ? value.liveUntilLedgerSeq
            : null,
      });
    }
    return { latestLedger, entries };
  }

  private async callRpc(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_RPC_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.rpcUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.rpcAuthToken
              ? { authorization: `Bearer ${this.config.rpcAuthToken}` }
              : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted) {
          throw abortError(signal);
        }
        if (attempt + 1 < MAX_RPC_ATTEMPTS) {
          await this.delay(RETRY_DELAYS_MS[attempt]!, signal);
          continue;
        }
        throw new ToolkitError(
          "RPC_TRANSPORT",
          `Soroban RPC request failed after ${MAX_RPC_ATTEMPTS} attempts; check the endpoint, connectivity, or ${REQUEST_TIMEOUT_MS} ms timeout`,
          { cause: error },
        );
      }
      throwIfAborted(signal);
      if (!response.ok) {
        if (
          [429, 500, 502, 503, 504].includes(response.status) &&
          attempt + 1 < MAX_RPC_ATTEMPTS
        ) {
          await response.body?.cancel();
          await this.delay(this.retryDelay(response, attempt), signal);
          continue;
        }
        throw new ToolkitError(
          "RPC_HTTP",
          `Soroban RPC returned HTTP ${response.status}`,
        );
      }
      return this.parseResponse(response, signal);
    }
    throw new ToolkitError(
      "RPC_TRANSPORT",
      "Soroban RPC request failed after exhausting retries",
    );
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1_000, 2_000);
    }
    if (retryAfter) {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) {
        return Math.max(0, Math.min(retryAt - Date.now(), 2_000));
      }
    }
    return RETRY_DELAYS_MS[attempt]!;
  }

  private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
    if (signal.aborted) {
      return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async parseResponse(
    response: Response,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_RPC_RESPONSE_BYTES
    ) {
      throw new Error(
        `Soroban RPC response exceeds the ${MAX_RPC_RESPONSE_BYTES}-byte safety limit`,
      );
    }
    if (!response.body) {
      throw new Error("Soroban RPC returned an empty response body");
    }
    let responseText: string;
    try {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RPC_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(
            `Soroban RPC response exceeds the ${MAX_RPC_RESPONSE_BYTES}-byte safety limit`,
          );
        }
        chunks.push(value);
      }
      throwIfAborted(signal);
      responseText = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      if (error instanceof Error && error.message.includes("safety limit")) {
        throw error;
      }
      throw new Error(`Unable to read Soroban RPC response: ${String(error)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new Error(`Soroban RPC returned invalid JSON: ${String(error)}`);
    }
    if (!isObject(payload)) {
      throw new Error("Soroban RPC returned an invalid JSON-RPC response");
    }
    if (payload.jsonrpc !== "2.0" || payload.id !== 1) {
      throw new Error(
        "Soroban RPC returned a mismatched JSON-RPC version or request ID",
      );
    }
    if (isObject(payload.error)) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "unknown RPC error";
      throw new ToolkitError("RPC_ERROR", `Soroban RPC error: ${message}`);
    }
    if (!("result" in payload)) {
      throw new Error("Soroban RPC response did not contain a result");
    }
    return payload.result;
  }
}
