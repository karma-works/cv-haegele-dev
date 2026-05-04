const base = process.env.SMOKE_BASE_URL || "https://cv.haegele.dev";

async function request(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text.slice(0, 500)}`);
  return { res, text };
}

await request("/api/health");
await request("/");
await request(`/api/knowledge?workspaceId=ws_smoke_${Date.now()}`);

console.log("smoke ok");
