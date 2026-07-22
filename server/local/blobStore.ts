// Filesystem-backed stand-in for the Supabase Storage bucket API used by the
// routes (upload/download/remove/getPublicUrl). Files live under
// localBlobsDir()/<bucket>/<path>, which app.ts serves at /files/<bucket>/<path>
// — a relative URL, so it resolves correctly for viewers on other LAN devices
// without needing to know the server's own host/port.
import fs from "fs";
import path from "path";
import { localBlobsDir } from "./paths.js";

function resolvePath(bucket: string, objectPath: string): string {
  const dir = path.join(localBlobsDir(), bucket);
  const full = path.join(dir, objectPath);
  // Object paths are server-generated (nanoid / session id), but guard against
  // a stray ".." the same way any path-from-input code should.
  if (!full.startsWith(dir + path.sep) && full !== dir) {
    throw new Error("Invalid object path");
  }
  return full;
}

export function createBucket(bucket: string) {
  return {
    async upload(objectPath: string, buffer: Buffer): Promise<{ data: { path: string } | null; error: { message: string } | null }> {
      try {
        const full = resolvePath(bucket, objectPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buffer);
        return { data: { path: objectPath }, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },

    async download(objectPath: string): Promise<{ data: Blob | null; error: { message: string } | null }> {
      try {
        const buf = fs.readFileSync(resolvePath(bucket, objectPath));
        return { data: new Blob([Uint8Array.from(buf)]), error: null };
      } catch {
        return { data: null, error: { message: "Object not found" } };
      }
    },

    async remove(objectPaths: string[]): Promise<{ data: null; error: null }> {
      for (const p of objectPaths) {
        try {
          fs.unlinkSync(resolvePath(bucket, p));
        } catch {
          // Already gone — removal is idempotent, matching Supabase Storage.
        }
      }
      return { data: null, error: null };
    },

    getPublicUrl(objectPath: string): { data: { publicUrl: string } } {
      // Relative on purpose: resolved by the browser against whatever origin
      // served the page, which is this same server for every viewer.
      return { data: { publicUrl: `/files/${bucket}/${objectPath}` } };
    },
  };
}
