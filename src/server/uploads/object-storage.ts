/** Stable object key for an uploaded file. The caller stores the bytes; this only names them. */
export function objectKey(userId: string, uploadId: string, fileId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9.]+/g, "_").replace(/^_+|_+$/g, "");
  return `uploads/${userId}/${uploadId}/${fileId}-${safe}`;
}

export function publicObjectUrl(base: string, key: string): string {
  return `${base.replace(/\/$/, "")}/${key}`;
}
