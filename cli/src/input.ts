import { readFileSync } from "node:fs";
import { usageError } from "./errors.js";

/**
 * Decide where an HTML upload comes from: a file argument or piped stdin.
 * Exactly one source must be present — a file argument alongside piped stdin
 * is ambiguous, and neither at all means the caller wants usage help.
 */
export function resolveBodySource(
  file: string | undefined,
  stdinIsTty: boolean,
): { source: "file"; file: string } | { source: "stdin" } {
  const piped = !stdinIsTty;
  if (file !== undefined && piped) {
    throw usageError(
      "Provide the HTML as a file argument or on stdin, not both.",
    );
  }
  if (file !== undefined) return { source: "file", file };
  if (piped) return { source: "stdin" };
  throw usageError(
    "No HTML to upload: pass a file argument or pipe the document to stdin.",
  );
}

/** Read the upload body from the resolved source. */
export function readBody(
  source: ReturnType<typeof resolveBodySource>,
): Uint8Array {
  const bytes =
    source.source === "file"
      ? new Uint8Array(readFileSync(source.file))
      : new Uint8Array(readFileSync(0)); // fd 0: all of stdin
  if (bytes.byteLength === 0) {
    throw usageError(
      source.source === "file"
        ? `${source.file} is empty.`
        : "stdin was empty.",
    );
  }
  return bytes;
}
