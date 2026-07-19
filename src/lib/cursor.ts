/**
 * Opaque list-pagination cursor: base64url-encoded JSON of the keyset
 * position (last row's updated_at + uuid). Clients must treat it as opaque.
 */
export interface CursorPosition {
  updatedAt: string;
  uuid: string;
}

export function encodeCursor(position: CursorPosition): string {
  const json = JSON.stringify({ u: position.updatedAt, id: position.uuid });
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const b64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(b64));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { u?: unknown }).u === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return {
        updatedAt: (parsed as { u: string }).u,
        uuid: (parsed as { id: string }).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}
