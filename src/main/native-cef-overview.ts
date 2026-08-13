import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { NativeCefRuntime } from "./native-cef-runtime.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

export type NativeCefOverviewOptions = {
  manager: NativeCefTaskSpaceManager;
  host?: string;
  port?: number;
  executable?: string;
  userDataDir: string;
  devtoolsPort: number;
  useMockKeychain?: boolean;
};

/** Electron-free Overview bridge. The page itself is rendered by CEF. */
export class NativeCefOverview {
  private server?: Server;
  private runtime?: NativeCefRuntime;
  private address?: { host: string; port: number };

  constructor(private readonly options: NativeCefOverviewOptions) {}

  async start() {
    if (this.runtime) return this.info();
    const host = this.options.host || "127.0.0.1";
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? 0, host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("native Overview server did not bind");
    this.address = { host, port: address.port };
    const url = `http://${host}:${address.port}/`;
    const devtoolsPort = this.options.devtoolsPort > 0
      ? this.options.devtoolsPort
      : await findFreePort();
    this.runtime = new NativeCefRuntime({
      executable: this.options.executable,
      url,
      port: devtoolsPort,
      userDataDir: this.options.userDataDir,
      useMockKeychain: this.options.useMockKeychain,
      overview: true,
    });
    await this.runtime.start();
    return this.info();
  }

  async stop() {
    await this.runtime?.stop().catch(() => undefined);
    this.runtime = undefined;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
    this.address = undefined;
  }

  info() {
    return this.address && this.runtime
      ? { ...this.address, url: `http://${this.address.host}:${this.address.port}/` }
      : undefined;
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    try {
      const url = new URL(request.url || "/", `http://${this.options.host || "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(OVERVIEW_HTML);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/spaces") {
        this.json(response, { spaces: this.options.manager.listSpaces() });
        return;
      }
      const match = url.pathname.match(/^\/api\/spaces\/(\d+)\/(open|focus|close)$/);
      if (request.method === "POST" && match) {
        const spaceId = Number(match[1]);
        const action = match[2];
        if (action === "open") await this.options.manager.showSpace(spaceId);
        else if (action === "focus") await this.options.manager.focusSpace(spaceId);
        else await this.options.manager.closeSpace(spaceId);
        this.json(response, { ok: true });
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      this.json(response, { error: String(error instanceof Error ? error.message : error) }, 500);
    }
  }

  private json(response: import("node:http").ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  }
}

async function findFreePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("unable to allocate Native CEF Overview DevTools port");
  return port;
}

const OVERVIEW_HTML = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UFO-Browser</title>
<style>
  :root { color-scheme: light; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif; background:#f6f7f8; color:#1d1d1f; }
  body { margin:0; padding:48px; } h1 { font-size:32px; letter-spacing:-.04em; margin:0 0 24px; }
  #spaces { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:18px; }
  article { background:#fff; border:1px solid #e6e7e9; border-radius:18px; padding:18px; box-shadow:0 8px 24px #0000000a; }
  h2 { font-size:17px; margin:0 0 8px; } p { color:#6e7075; min-height:20px; margin:0 0 16px; font-size:13px; }
  button { border:0; border-radius:10px; padding:9px 13px; margin-right:6px; background:#f0f1f3; cursor:pointer; } button.primary { background:#1d1d1f; color:#fff; }
</style>
<h1>UFO-Browser</h1><div id="spaces"></div>
<script>
async function load(){const data=await fetch('/api/spaces').then(r=>r.json());document.querySelector('#spaces').innerHTML=(data.spaces||[]).map(s=>
  '<article><h2>'+esc(s.name)+'</h2><p>'+esc((s.recentTabTitles||[]).join(' · ')||s.lifecycle)+'</p>'+
  '<button class="primary" onclick="act('+s.id+',\'open\')">打开</button><button onclick="act('+s.id+',\'focus\')">聚焦</button><button onclick="act('+s.id+',\'close\')">关闭</button></article>').join('')||'<p>还没有 Space</p>'}
async function act(id,a){await fetch('/api/spaces/'+id+'/'+a,{method:'POST'});await load()}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))} load(); setInterval(load,4000);
</script>`;
