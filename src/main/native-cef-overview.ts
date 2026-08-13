import { createServer, type Server } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  /** Keep the HTTP Overview API alive while another native CEF host renders it. */
  startRuntime?: boolean;
  /** Optional JSON rendezvous file for a native app launcher. */
  infoFile?: string;
  controlSocket?: string;
};

export type NativeCefOverviewPresentation = {
  openSpace(spaceId: number): Promise<void>;
  showOverview(): Promise<void>;
  closeSpace(spaceId: number): Promise<boolean>;
};

/** Electron-free Overview bridge. The page itself is rendered by CEF. */
export class NativeCefOverview {
  private server?: Server;
  private runtime?: NativeCefRuntime;
  private address?: { host: string; port: number };
  private presentation?: NativeCefOverviewPresentation;
  private readonly previewCache = new Map<number, { capturedAt: number; value: any }>();
  private previewQueue = Promise.resolve();
  private previewLastCaptureAt = 0;

  constructor(private readonly options: NativeCefOverviewOptions) {}

  setPresentationController(controller: NativeCefOverviewPresentation) {
    this.presentation = controller;
  }

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
    const info = { host, port: address.port, url };
    if (this.options.infoFile) {
      await mkdir(dirname(this.options.infoFile), { recursive: true, mode: 0o700 });
      await writeFile(this.options.infoFile, `${JSON.stringify(info)}\n`, { mode: 0o600 });
    }
    if (this.options.startRuntime === false) return info;
    this.runtime = new NativeCefRuntime({
      executable: this.options.executable,
      url,
      port: devtoolsPort,
      userDataDir: this.options.userDataDir,
      useMockKeychain: this.options.useMockKeychain,
      overview: true,
      controlSocket: this.options.controlSocket,
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
    if (this.options.infoFile) await writeFile(this.options.infoFile, "", { mode: 0o600 }).catch(() => undefined);
  }

  info() {
    return this.address
      ? { ...this.address, url: `http://${this.address.host}:${this.address.port}/` }
      : undefined;
  }

  async showWindow() {
    return this.control("show");
  }

  async hideWindow() {
    return this.control("hide");
  }

  async focusWindow() {
    return this.control("focus");
  }

  private async control(command: "show" | "hide" | "focus") {
    if (this.runtime) return this.runtime.control(command);
    if (!this.options.controlSocket) return "ok";
    return sendControlCommand(this.options.controlSocket, command);
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
      if (request.method === "GET" && url.pathname === "/api/profiles") {
        this.json(response, { profiles: this.options.manager.listProfiles() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/spaces") {
        const body = await readJsonBody(request);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const profileId = typeof body?.profileId === "string" ? body.profileId : undefined;
        if (!name) {
          this.json(response, { error: "Space name is required" }, 400);
          return;
        }
        const space = await this.options.manager.createSpace(name, "user", profileId);
        this.json(response, { space }, 201);
        return;
      }
      const previewMatch = url.pathname.match(/^\/api\/spaces\/(\d+)\/preview$/);
      if (request.method === "GET" && previewMatch) {
        const spaceId = Number(previewMatch[1]);
        const cached = this.previewCache.get(spaceId);
        const now = Date.now();
        if (cached && now - cached.capturedAt < 4_000) {
          this.json(response, cached.value);
          return;
        }
        const value = await this.enqueuePreview(spaceId);
        this.json(response, value ?? { available: false });
        return;
      }
      const match = url.pathname.match(/^\/api\/spaces\/(\d+)\/(open|focus|close)$/);
      if (request.method === "POST" && match) {
        const spaceId = Number(match[1]);
        const action = match[2];
        if (action === "open") {
          if (this.presentation) await this.presentation.openSpace(spaceId);
          else await this.options.manager.showSpace(spaceId);
        } else if (action === "focus") {
          if (this.presentation) await this.presentation.openSpace(spaceId);
          else await this.options.manager.focusSpace(spaceId);
        } else if (this.presentation) {
          await this.presentation.closeSpace(spaceId);
        } else {
          await this.options.manager.closeSpace(spaceId);
        }
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

  private enqueuePreview(spaceId: number) {
    const operation = this.previewQueue.then(async () => {
      const waitMs = Math.max(0, 4_000 - (Date.now() - this.previewLastCaptureAt));
      if (waitMs > 0) await delay(waitMs);
      const value = await this.options.manager.capturePreview(spaceId);
      if (!value) return undefined;
      this.previewLastCaptureAt = Date.now();
      this.previewCache.set(spaceId, { capturedAt: this.previewLastCaptureAt, value });
      return value;
    });
    this.previewQueue = operation.then(() => undefined, () => undefined);
    return operation;
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

function sendControlCommand(path: string, command: string) {
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => resolveResponse(response.trim()));
    socket.once("connect", () => socket.end(`${command}\n`));
  });
}

async function readJsonBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Overview request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Overview request body is not valid JSON");
  }
}

function delay(ms: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

const OVERVIEW_HTML = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UFO-Browser</title>
<style>
  :root { color-scheme:light; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif; background:#f5f5f7; color:#1d1d1f; }
  * { box-sizing:border-box; } body { margin:0; padding:36px 42px 56px; }
  header { display:flex; align-items:flex-end; justify-content:space-between; max-width:1220px; margin:0 auto 24px; gap:20px; }
  h1 { font-size:34px; letter-spacing:-.05em; margin:0; font-weight:700; } header p { color:#86868b; margin:7px 0 0; font-size:13px; }
  #spaces { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:20px; max-width:1220px; margin:0 auto; }
  article { overflow:hidden; background:rgba(255,255,255,.9); border:1px solid #e3e3e7; border-radius:20px; box-shadow:0 12px 34px #0000000b; transition:transform .18s ease,box-shadow .18s ease; }
  article:hover { transform:translateY(-2px); box-shadow:0 18px 42px #00000013; }
  .preview { position:relative; aspect-ratio:16/10; background:#e9e9ec; overflow:hidden; border-bottom:1px solid #e8e8ec; }
  .preview img { display:block; width:100%; height:100%; object-fit:cover; background:#e9e9ec; }
  .preview.empty { display:grid; place-items:center; color:#98989d; font-size:13px; }
  .chrome { position:absolute; inset:0 0 auto; height:27px; display:flex; align-items:center; gap:7px; padding:0 10px; background:linear-gradient(#f4f4f6,#e9e9ed); border-bottom:1px solid #d7d7dc; z-index:1; }
  .traffic { display:flex; gap:4px; } .traffic i { width:7px; height:7px; border-radius:50%; background:#c7c7cc; } .traffic i:first-child { background:#ff6259; } .traffic i:nth-child(2) { background:#ffbd2e; } .traffic i:nth-child(3) { background:#28c840; }
  .address { flex:1; height:16px; border-radius:8px; background:#fff9; border:1px solid #d8d8dc; color:#86868b; font-size:9px; padding:2px 8px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .body { padding:15px 17px 16px; } h2 { font-size:17px; margin:0 0 6px; letter-spacing:-.02em; } .meta { color:#86868b; min-height:18px; margin:0 0 14px; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  button { border:0; border-radius:10px; padding:8px 12px; margin-right:6px; background:#f0f0f2; color:#1d1d1f; cursor:pointer; font:inherit; font-size:12px; } button.primary { background:#1d1d1f; color:#fff; } button:active { transform:scale(.98); }
  .empty-grid { grid-column:1/-1; text-align:center; padding:64px 16px; color:#86868b; }
  .create { display:flex; align-items:center; gap:7px; } .create input,.create select { height:32px; border:1px solid #d8d8dc; border-radius:9px; background:#fff; padding:0 9px; font:inherit; font-size:12px; color:#1d1d1f; } .create input { width:150px; }
</style>
<header><div><h1>UFO-Browser</h1><p>原生 Chromium Task Spaces</p></div><div class="create"><input id="new-name" placeholder="新 Space 名称"><select id="new-profile"><option value="">Default</option></select><button class="primary" onclick="createSpace()">新建 Space</button><p id="status">正在同步…</p></div></header><div id="spaces"></div>
<script>
const cache=new Map();
async function load(){const [data,profiles]=await Promise.all([fetch('/api/spaces',{cache:'no-store'}).then(r=>r.json()),fetch('/api/profiles',{cache:'no-store'}).then(r=>r.json())]);const spaces=data.spaces||[];const select=document.querySelector('#new-profile');const selected=select.value;select.innerHTML=(profiles.profiles||[]).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+(p.isDefault?' · 默认':'')+'</option>').join('');if(selected)select.value=selected;document.querySelector('#status').textContent=spaces.length+' 个 Space';document.querySelector('#spaces').innerHTML=spaces.map(s=>card(s)).join('')||'<div class="empty-grid">还没有 Space</div>';await Promise.all(spaces.map(preview))}
function card(s){return '<article id="space-'+s.id+'"><div class="preview empty" id="preview-'+s.id+'"><div class="chrome"><span class="traffic"><i></i><i></i><i></i></span><span class="address">'+esc((s.recentTabTitles||[]).at(-1)||'New Tab')+'</span></div>加载预览…</div><div class="body"><h2>'+esc(s.name)+'</h2><p class="meta">'+esc((s.recentTabTitles||[]).join(' · ')||s.lifecycle)+'</p><button class="primary" onclick="act('+s.id+',\'open\')">打开</button><button onclick="act('+s.id+',\'focus\')">聚焦</button><button onclick="act('+s.id+',\'close\')">关闭</button></div></article>'}
async function preview(s){try{const v=await fetch('/api/spaces/'+s.id+'/preview',{cache:'no-store'}).then(r=>r.json());if(!v.dataUrl)return;const node=document.querySelector('#preview-'+s.id);if(!node)return;node.classList.remove('empty');node.innerHTML='<div class="chrome"><span class="traffic"><i></i><i></i><i></i></span><span class="address">'+esc(v.url||'New Tab')+'</span></div><img alt="'+esc(v.title||'')+'" src="'+v.dataUrl+'">'}catch(e){const node=document.querySelector('#preview-'+s.id);if(node)node.textContent='预览暂不可用'}}
async function act(id,a){await fetch('/api/spaces/'+id+'/'+a,{method:'POST'});await load()}
async function createSpace(){const input=document.querySelector('#new-name');const name=input.value.trim();if(!name){input.focus();return}const profile=document.querySelector('#new-profile').value;await fetch('/api/spaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,profileId:profile||undefined})});input.value='';await load()}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}load();setInterval(load,4000);
</script>`;
