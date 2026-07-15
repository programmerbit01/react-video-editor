// Read a JSON request body, transparently gunzipping it when the client marked it with the
// X-Payload-Gzip header. A caption-heavy export design is a big JSON (tens of MB); POSTing it
// raw to a REMOTE editor over a cloudflared tunnel took minutes at a blank 0%. The client
// gzips it (~85-90% smaller) and we inflate it here. A CUSTOM header (not Content-Encoding)
// is used deliberately so proxies/CDNs in between don't try to auto-decompress it themselves.
export async function readJsonBody(request: Request): Promise<any> {
  if (request.headers.get("x-payload-gzip") === "1") {
    const buf = Buffer.from(await request.arrayBuffer());
    const { gunzipSync } = await import("zlib");
    return JSON.parse(gunzipSync(buf).toString("utf8"));
  }
  return request.json();
}
