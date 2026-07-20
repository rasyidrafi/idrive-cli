import { open } from "node:fs/promises";

export async function readTextFileLimited(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const metadata = await handle.stat();
    if (metadata.size > maxBytes) {
      throw new Error(`Input exceeds the ${maxBytes}-byte limit`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function responseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`IDrive response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`IDrive response exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}
