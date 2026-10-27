export type ToolkitErrorCode =
  | "INVALID_INPUT"
  | "CONFIGURATION"
  | "NETWORK_MISMATCH"
  | "TTL_METADATA_UNAVAILABLE"
  | "ABORTED"
  | "RPC_TRANSPORT"
  | "RPC_HTTP"
  | "RPC_ERROR"
  | "RPC_RESPONSE";

export class ToolkitError extends Error {
  constructor(
    readonly code: ToolkitErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolkitError";
  }
}

export function isToolkitError(error: unknown): error is ToolkitError {
  return error instanceof ToolkitError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
