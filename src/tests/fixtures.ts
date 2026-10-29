// Ledger-key fixtures shared by the local RPC tests and the Testnet
// integration tests. Nothing here talks to the network.
import { createHash } from "node:crypto";
import { Address, Asset, xdr } from "@stellar/stellar-sdk";
import { parseStorageKey } from "../ledger-key.js";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/** Contract address of the native-asset (XLM) Stellar Asset Contract. */
export const NATIVE_ASSET_CONTRACT = new Address(
  Asset.native().contractId(TESTNET_PASSPHRASE),
).toScAddress();

/**
 * Instance key of the native-asset (XLM) Stellar Asset Contract on Testnet.
 * The protocol owns this contract, so it exists after every Testnet reset
 * and no user can change or remove it.
 */
export const NATIVE_ASSET_INSTANCE_KEY = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: NATIVE_ASSET_CONTRACT,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  }),
).toXDR("base64");

/**
 * A contract-data key under the native-asset contract that can never exist:
 * the Stellar Asset Contract only writes enum-shaped (vector) keys, never a
 * bare symbol.
 */
export const MISSING_CONTRACT_DATA_KEY = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: NATIVE_ASSET_CONTRACT,
    key: xdr.ScVal.scvSymbol("toolkit_missing_fixture"),
    durability: xdr.ContractDataDurability.persistent,
  }),
).toXDR("base64");

/**
 * A contract-code key whose hash is not the SHA-256 of any uploaded WASM,
 * since finding a matching WASM would require a SHA-256 preimage.
 */
export const MISSING_CONTRACT_CODE_KEY = contractCodeKey(
  createHash("sha256")
    .update("soroban-storage-lifecycle-toolkit/missing-contract-code")
    .digest(),
);

export function contractCodeKey(hash: Buffer): string {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash }),
  ).toXDR("base64");
}

function requireKeyType(
  envName: string,
  value: string,
  type: "contractData" | "contractCode",
): string {
  const parsed = parseStorageKey(value);
  if (parsed.type !== type) {
    throw new Error(`${envName} must be a ${type} ledger key`);
  }
  return parsed.xdr;
}

/**
 * Contract-data key for the live "found" test. Defaults to the native-asset
 * instance. STORAGE_LEDGER_KEY_XDR is still read for backward compatibility.
 */
export function liveContractDataKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = env.STORAGE_CONTRACT_DATA_KEY_XDR
    ? "STORAGE_CONTRACT_DATA_KEY_XDR"
    : "STORAGE_LEDGER_KEY_XDR";
  const override = env[name];
  return override
    ? requireKeyType(name, override, "contractData")
    : NATIVE_ASSET_INSTANCE_KEY;
}

/**
 * Contract-code key for the live "found" test, or undefined when none is
 * configured. Testnet resets remove every uploaded WASM, so there is no
 * permanent default; set STORAGE_CONTRACT_CODE_KEY_XDR or
 * STORAGE_CONTRACT_CODE_WASM_HASH (64 hex characters) to enable it.
 */
export function liveContractCodeKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.STORAGE_CONTRACT_CODE_KEY_XDR) {
    return requireKeyType(
      "STORAGE_CONTRACT_CODE_KEY_XDR",
      env.STORAGE_CONTRACT_CODE_KEY_XDR,
      "contractCode",
    );
  }
  const wasmHash = env.STORAGE_CONTRACT_CODE_WASM_HASH?.trim();
  if (wasmHash) {
    if (!/^[0-9a-fA-F]{64}$/.test(wasmHash)) {
      throw new Error(
        "STORAGE_CONTRACT_CODE_WASM_HASH must be 64 hexadecimal characters",
      );
    }
    return contractCodeKey(Buffer.from(wasmHash, "hex"));
  }
  return undefined;
}
