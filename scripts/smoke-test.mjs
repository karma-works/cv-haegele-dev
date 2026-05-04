const base = process.env.SMOKE_BASE_URL || "https://cv.haegele.dev";
const token = process.env.SMOKE_TOKEN || "";

async function request(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text.slice(0, 500)}`);
  return { res, text };
}

await request("/api/health");
await request("/");

if (token) {
  const auth = await request("/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const session = JSON.parse(auth.text);
  await request(`/api/knowledge?workspaceId=ws_smoke${Date.now()}`, {
    headers: { authorization: `Bearer ${session.sessionId}` },
  });
}

console.log("smoke ok");
