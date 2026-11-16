// A made-up App Store Connect for the Ouro AX X-ray: it listens on loopback only, answers GETs with made-up data,
// and refuses every write. Usage: node scripts/xray-mock.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4010);

const server = createServer((request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method !== "GET") {
    send(405, { errors: [{ status: "405", title: "The mock refuses writes" }] });
    return;
  }
  const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
  if (pathname === "/__mock") {
    send(200, { mock: true, madeUpData: true });
    return;
  }
  send(200, { data: [{ type: "apps", id: "mock-app-1", attributes: { name: "Made-up app", bundleId: "app.example.mock" } }] });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`xray mock listening on http://127.0.0.1:${port}\n`);
});
