import {
  Env, json, html, markdown, readJson,
  ensureWorkspace, listKnowledge, saveKnowledgeFile, kbTotalBytes,
  cleanupExpired, checkTokenBudget,
} from "./shared";
export { CvAgent } from "./agent";
export { CvWorkflow } from "./workflow";

async function handleStatus(env: Env): Promise<Response> {
  return json(await checkTokenBudget(env));
}

async function handleKnowledgeList(request: Request, env: Env): Promise<Response> {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
  await ensureWorkspace(env, workspaceId);
  const files = await listKnowledge(env, workspaceId);
  const totalBytes = files.reduce((s, f) => s + f.content_bytes, 0);
  return json({ files, totalBytes, maxBytes: Number(env.KB_MAX_BYTES || 1048576) });
}

async function handleKnowledgeUpload(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ workspaceId?: string; files?: Array<{ filename?: string; content?: string }> }>(request);
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) return json({ error: "missing_workspace_id" }, { status: 400 });
  await ensureWorkspace(env, workspaceId);
  const files = body.files || [];
  if (!files.length) return json({ error: "missing_files" }, { status: 400 });
  const saved = [];
  for (const file of files) {
    const name = (file.filename || "knowledge.md").trim();
    if (!name.toLowerCase().endsWith(".md")) return json({ error: "only_markdown_supported", filename: name }, { status: 400 });
    saved.push(await saveKnowledgeFile(env, workspaceId, name, file.content || "", "upload"));
  }
  return json({ saved, files: await listKnowledge(env, workspaceId) });
}

async function handleKnowledgeDelete(request: Request, env: Env, fileId: string): Promise<Response> {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
  await ensureWorkspace(env, workspaceId);
  await env.DB.prepare("DELETE FROM cv_knowledge_files WHERE id = ? AND workspace_id = ?").bind(fileId, workspaceId).run();
  return json({ ok: true, files: await listKnowledge(env, workspaceId) });
}

async function handleDeleteAll(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ workspaceId?: string }>(request);
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) return json({ error: "missing_workspace_id" }, { status: 400 });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cv_knowledge_files WHERE workspace_id = ?").bind(workspaceId),
    env.DB.prepare("DELETE FROM cv_company_sources WHERE workspace_id = ?").bind(workspaceId),
    env.DB.prepare("DELETE FROM cv_workspaces WHERE id = ?").bind(workspaceId),
  ]);
  return json({ ok: true });
}

function schemaStatements(): string[] {
  return [
    "CREATE TABLE IF NOT EXISTS cv_workspaces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cv_knowledge_files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cv_workspaces(id) ON DELETE CASCADE, filename TEXT NOT NULL, content TEXT NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'github', 'linkedin', 'xing', 'x', 'company', 'clarification')), source_url TEXT, content_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cv_company_sources (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cv_workspaces(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT, content TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cv_daily_tokens (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_cv_knowledge_workspace ON cv_knowledge_files(workspace_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cv_knowledge_expires ON cv_knowledge_files(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_cv_company_workspace ON cv_company_sources(workspace_id, created_at)",
  ];
}

async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  // Route WebSocket and agent requests to the Durable Object
  const agentMatch = /^\/agents\/cv-agent\/([^/]+)$/.exec(url.pathname);
  if (agentMatch) {
    const workspaceId = agentMatch[1];
    if (!/^ws_[A-Za-z0-9_-]{16,80}$/.test(workspaceId)) {
      return json({ error: "invalid_workspace_id" }, { status: 400 });
    }
    const id = env.CV_AGENT.idFromName(workspaceId);
    const stub = env.CV_AGENT.get(id);
    return stub.fetch(request);
  }

  if (url.pathname === "/") return html(appHtml());
  if (url.pathname === "/api/health") return json({ ok: true });
  if (url.pathname === "/api/status") return handleStatus(env);
  if (url.pathname === "/api/admin/apply-schema" && request.method === "POST") {
    await env.DB.batch(schemaStatements().map(s => env.DB.prepare(s)));
    return json({ ok: true });
  }
  if (url.pathname === "/api/knowledge" && request.method === "GET") return handleKnowledgeList(request, env);
  if (url.pathname === "/api/knowledge" && request.method === "POST") return handleKnowledgeUpload(request, env);
  const delMatch = /^\/api\/knowledge\/([^/]+)$/.exec(url.pathname);
  if (delMatch && request.method === "DELETE") return handleKnowledgeDelete(request, env, delMatch[1]);
  if (url.pathname === "/api/delete-all" && request.method === "POST") return handleDeleteAll(request, env);
  if (url.pathname === "/download" && request.method === "POST") {
    const body = await readJson<{ filename?: string; content?: string }>(request);
    return markdown(body.content || "", body.filename || "document.md");
  }
  if (url.pathname === "/llms.txt") {
    return new Response("cv.haegele.dev is a private CV and cover letter tailoring workspace.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await router(request, env);
    } catch (error) {
      if (error instanceof Response) return error;
      return json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};

// ── Embedded HTML / CSS / JS ──────────────────────────────────────────────

function appHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CV tailoring workspace</title>
<style>${css()}</style>
</head>
<body>
<div id="errorBar" class="errorBar" hidden></div>
<div class="layout" id="layout">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <h2>Knowledge Base</h2>
        <p class="hint">Markdown files only &middot; 1 MB limit</p>
      </div>
      <div class="browse-row">
        <button id="browseBtn" class="secondary sm">+ Add files</button>
        <input id="kbFileInput" type="file" accept=".md,text/markdown" multiple hidden>
      </div>
      <div id="kbMeter" class="meter">—</div>
      <div id="kbFiles" class="fileList"></div>
      <div class="sidebar-footer">
        <button id="deleteAllBtn" class="danger sm">Delete all data</button>
      </div>
    </div>
    <button class="sidebar-toggle" id="sidebarToggle" title="Toggle sidebar">&#9664;</button>
  </aside>

  <main class="chat-area">
    <header class="chat-header">
      <h1 class="brand">CV Workspace</h1>
      <span id="budgetBadge" class="budget-badge">—</span>
      <button id="startOverBtn" class="secondary sm">Start over</button>
    </header>
    <div id="messages" class="messages"></div>
    <div class="input-row">
      <textarea id="chatInput" class="chat-input" placeholder="Type a message…" rows="1"></textarea>
      <button id="sendBtn" class="send-btn">&#9654;</button>
    </div>
    <footer class="app-footer">
      <span class="footer-privacy">Your files are stored in Cloudflare D1 for 30&nbsp;days and deleted automatically. Generated documents are never stored server-side.</span>
      <span class="footer-links">
        <a href="https://haegele.dev" target="_blank" rel="noopener">haegele.dev</a>
        &middot;
        <a href="https://github.com/karma-works/cv-haegele-dev" target="_blank" rel="noopener">GitHub</a>
      </span>
    </footer>
  </main>
</div>

<!-- Preview pane -->
<div id="previewOverlay" class="preview-overlay" hidden>
  <div class="preview-pane">
    <div class="preview-header">
      <span id="previewTitle">Preview</span>
      <div class="preview-actions">
        <button id="previewDownload" class="secondary sm">Download</button>
        <button id="previewClose" class="secondary sm">&#10005;</button>
      </div>
    </div>
    <div id="previewContent" class="preview-content"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>${clientJs()}</script>
</body>
</html>`;
}

function css(): string {
  return `
:root{--paper:#fcf9f8;--ink:#2d3930;--ink-soft:rgba(45,57,48,.65);--rule:rgba(45,57,48,.18);
--fill:#effdf0;--danger:#93000a;--user-bg:#2d3930;--tool-bg:rgba(45,57,48,.06);--sidebar-w:260px;}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:var(--paper);color:var(--ink);font-family:Georgia,"Noto Serif",serif}
button,input,textarea,select{font:inherit}
.layout{display:flex;height:100vh;overflow:hidden}

/* Sidebar */
.sidebar{display:flex;flex-shrink:0;width:var(--sidebar-w);border-right:1px solid var(--rule);
  position:relative;transition:width .2s}
.sidebar.collapsed{width:32px}
.sidebar-inner{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;
  min-width:0;transition:opacity .15s}
.sidebar.collapsed .sidebar-inner{opacity:0;pointer-events:none}
.sidebar-head h2{font-size:16px;font-weight:500}
.hint{color:var(--ink-soft);font-size:12px;margin-top:4px}
.browse-row{display:flex;gap:8px;align-items:center}
.meter{font-size:12px;color:var(--ink-soft)}
.fileList{display:flex;flex-direction:column;gap:6px;flex:1}
.file-item{display:flex;justify-content:space-between;align-items:start;gap:6px;
  border-top:1px solid var(--rule);padding-top:6px;font-size:13px}
.file-name{flex:1;word-break:break-word;font-size:12px}
.file-meta{color:var(--ink-soft);font-size:11px}
.sidebar-footer{padding-top:8px;border-top:1px solid var(--rule)}
.sidebar-toggle{position:absolute;right:-14px;top:50%;transform:translateY(-50%);
  width:14px;height:36px;border:1px solid var(--rule);border-left:none;background:var(--paper);
  cursor:pointer;font-size:9px;color:var(--ink-soft);display:flex;align-items:center;justify-content:center;
  border-radius:0 4px 4px 0;z-index:1}

/* Chat area */
.chat-area{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.chat-header{display:flex;align-items:center;gap:12px;padding:12px 16px;
  border-bottom:1px solid var(--rule);flex-shrink:0}
.brand{font-size:16px;font-weight:500;flex:1;letter-spacing:-.01em}
.budget-badge{font-size:12px;color:var(--ink-soft);border:1px solid var(--rule);
  padding:2px 8px;white-space:nowrap}
.app-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:8px 16px;border-top:1px solid var(--rule);flex-shrink:0;flex-wrap:wrap}
.footer-privacy{font-size:11px;color:var(--ink-soft);flex:1}
.footer-links{font-size:11px;color:var(--ink-soft);white-space:nowrap}
.footer-links a{color:var(--ink-soft);text-decoration:none}
.footer-links a:hover{text-decoration:underline}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}

/* Bubbles */
.bubble-wrap{display:flex;flex-direction:column;max-width:78%;gap:8px}
.bubble-wrap.user{align-self:flex-end;align-items:flex-end}
.bubble-wrap.agent{align-self:flex-start;align-items:flex-start}
.bubble{padding:10px 14px;line-height:1.55;border-radius:2px;font-size:15px}
.bubble.user{background:var(--user-bg);color:var(--paper)}
.bubble.agent{background:var(--fill);border:1px solid var(--rule)}
.bubble.agent p:first-child{margin-top:0}.bubble.agent p:last-child{margin-bottom:0}
.bubble.agent p,.bubble.agent li,.bubble.agent h1,.bubble.agent h2,.bubble.agent h3{margin-bottom:.5em}
.bubble.agent ul,.bubble.agent ol{padding-left:1.4em}
.bubble.agent code{font-family:ui-monospace,monospace;font-size:13px;background:rgba(45,57,48,.08);padding:1px 4px}
.bubble.agent pre{background:rgba(45,57,48,.08);padding:8px;overflow-x:auto;font-size:13px}
.tool-bar{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);
  background:var(--tool-bg);border:1px solid var(--rule);padding:6px 10px;border-radius:2px}
.tool-bar .tool-icon{font-size:13px}
.tool-bar.done{color:var(--ink-soft)}
.choices-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.choice-btn{background:var(--paper);border:1px solid var(--ink);color:var(--ink);
  padding:6px 12px;font-size:13px;cursor:pointer;border-radius:2px}
.choice-btn:hover{background:var(--fill)}
.choice-btn:disabled{opacity:.45;cursor:default}

/* Guideline badge */
.guideline-badge{font-size:12px;color:var(--ink-soft);background:var(--tool-bg);
  border:1px solid var(--rule);padding:4px 10px;border-radius:2px;align-self:center}

/* Input row */
.input-row{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--rule);flex-shrink:0}
.chat-input{flex:1;resize:none;border:1px solid var(--rule);padding:10px 12px;
  background:var(--paper);color:var(--ink);line-height:1.4;max-height:140px;overflow-y:auto}
.send-btn{border:1px solid var(--ink);background:var(--ink);color:var(--paper);
  width:44px;cursor:pointer;font-size:18px;flex-shrink:0}
.send-btn:disabled{opacity:.4;cursor:default}

/* JD action buttons */
.jd-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.jd-url-row{display:flex;gap:6px;margin-top:4px}
.jd-url-row input{flex:1;border:1px solid var(--rule);padding:8px 10px;background:var(--paper)}

/* Buttons */
button.secondary{background:var(--paper);color:var(--ink);border:1px solid var(--ink);
  padding:8px 12px;cursor:pointer}
button.danger{background:var(--paper);color:var(--danger);border:1px solid var(--danger);
  padding:8px 12px;cursor:pointer}
button.sm{padding:5px 10px;font-size:13px}
button:disabled{opacity:.42;cursor:not-allowed}

/* Error bar */
.errorBar{position:fixed;bottom:0;left:0;right:0;background:var(--danger);color:#fff;
  text-align:center;padding:10px;font-size:14px;z-index:200}

/* Preview overlay */
.preview-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;
  display:flex;align-items:center;justify-content:center}
.preview-overlay[hidden]{display:none}
.preview-pane{background:var(--paper);width:min(860px,calc(100vw - 32px));
  max-height:calc(100vh - 48px);display:flex;flex-direction:column;border:1px solid var(--rule)}
.preview-header{display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;border-bottom:1px solid var(--rule);flex-shrink:0}
.preview-actions{display:flex;gap:8px}
.preview-content{flex:1;overflow-y:auto;padding:24px;font-size:15px;line-height:1.6}
.preview-content h1,.preview-content h2,.preview-content h3{font-weight:500;margin:.8em 0 .4em}
.preview-content p{margin-bottom:.7em}
.preview-content ul,.preview-content ol{padding-left:1.4em;margin-bottom:.7em}
.preview-content code{font-family:ui-monospace,monospace;font-size:13px;
  background:rgba(45,57,48,.08);padding:1px 4px}

@media(max-width:680px){
  .sidebar{position:fixed;left:0;top:0;bottom:0;z-index:50;background:var(--paper)}
  .sidebar.collapsed{width:0;border:none}
  .sidebar-toggle{right:-14px}
  .chat-area{width:100%}
  .bubble-wrap{max-width:92%}
}`;
}

function clientJs(): string {
  return `
(function(){
'use strict';
const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────
let wsId = localStorage.getItem('cv_workspace_id') || '';
if (!wsId) {
  wsId = 'ws_' + Array.from(crypto.getRandomValues(new Uint8Array(18)))
    .map(b => b.toString(36).padStart(2,'0')).join('');
  localStorage.setItem('cv_workspace_id', wsId);
}

let ws = null;
let previewContent = '';
let previewType = 'cv';
let pendingJdUpload = false; // showing JD upload UI in chat

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(\`\${proto}://\${location.host}/agents/cv-agent/\${wsId}\`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'connect' }));
  ws.onmessage = e => handleWsMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}

function sendMsg(type, extra) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...extra }));
}

// ── Message rendering ─────────────────────────────────────────────────────
const messagesEl = $('messages');
let streamingBubble = null;

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  if (window.marked) return marked.parse(text || '');
  return (text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\n/g,'<br>');
}

function addBubble(role, html) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap ' + role;
  const b = document.createElement('div');
  b.className = 'bubble ' + role;
  b.innerHTML = html;
  wrap.appendChild(b);
  messagesEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function addToolBar(tool, summary, done) {
  const bar = document.createElement('div');
  bar.className = 'tool-bar' + (done ? ' done' : '');
  bar.dataset.tool = tool;
  bar.innerHTML = \`<span class="tool-icon">\${done ? '✓' : '⚙'}</span>
    <span><strong>\${escHtml(tool)}</strong> — \${escHtml(summary)}</span>\`;
  messagesEl.appendChild(bar);
  scrollBottom();
  return bar;
}

function addChoices(options, disabled) {
  const row = document.createElement('div');
  row.className = 'choices-row';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = opt;
    btn.disabled = !!disabled;
    if (!disabled) {
      btn.onclick = () => {
        row.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
        addUserBubble(opt);
        sendMsg('chat', { text: opt });
      };
    }
    row.appendChild(btn);
  });
  messagesEl.appendChild(row);
  scrollBottom();
  return row;
}

function addUserBubble(text) {
  addBubble('user', escHtml(text).replace(/\\n/g, '<br>'));
}

function addAgentBubble(text) {
  // Check if text contains JD prompt keywords
  const lower = text.toLowerCase();
  const isJdPrompt = lower.includes('job description') && (lower.includes('upload') || lower.includes('url') || lower.includes('provide'));
  const wrap = addBubble('agent', renderMarkdown(text));
  if (isJdPrompt && !pendingJdUpload) {
    addJdActions(wrap);
  }
  return wrap;
}

function addJdActions(wrap) {
  pendingJdUpload = true;
  const actions = document.createElement('div');
  actions.className = 'jd-actions';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'secondary sm';
  uploadBtn.textContent = '📄 Upload document';
  uploadBtn.onclick = () => { $('jdFileInput').click(); };

  const urlBtn = document.createElement('button');
  urlBtn.className = 'secondary sm';
  urlBtn.textContent = '🔗 Enter URL';
  let urlRowShown = false;
  urlBtn.onclick = () => {
    if (urlRowShown) return;
    urlRowShown = true;
    const row = document.createElement('div');
    row.className = 'jd-url-row';
    const inp = document.createElement('input');
    inp.type = 'url';
    inp.placeholder = 'https://company.com/jobs/123';
    const go = document.createElement('button');
    go.className = 'secondary sm';
    go.textContent = 'Fetch';
    go.onclick = () => {
      const u = inp.value.trim();
      if (!u) return;
      pendingJdUpload = false;
      actions.remove();
      row.remove();
      addUserBubble('JD URL: ' + u);
      sendMsg('jd_url', { url: u });
    };
    inp.onkeydown = e => { if (e.key === 'Enter') go.click(); };
    row.appendChild(inp);
    row.appendChild(go);
    wrap.after(row);
    inp.focus();
  };

  actions.appendChild(uploadBtn);
  actions.appendChild(urlBtn);
  wrap.after(actions);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── WebSocket message handling ────────────────────────────────────────────
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'history':
      messagesEl.innerHTML = '';
      pendingJdUpload = false;
      (msg.messages || []).forEach(renderHistoryMessage);
      scrollBottom();
      break;
    case 'agent':
      addAgentBubble(msg.text || '');
      break;
    case 'tool_start':
      addToolBar(msg.tool, msg.summary, false);
      break;
    case 'tool_end': {
      // Update existing start bar if present
      const existing = [...messagesEl.querySelectorAll('.tool-bar:not(.done)')]
        .find(el => el.dataset.tool === msg.tool);
      if (existing) {
        existing.className = 'tool-bar done';
        existing.innerHTML = \`<span class="tool-icon">✓</span>
          <span><strong>\${escHtml(msg.tool)}</strong> — \${escHtml(msg.summary)}</span>\`;
      } else {
        addToolBar(msg.tool, msg.summary, true);
      }
      break;
    }
    case 'choices':
      addChoices(msg.options, false);
      break;
    case 'guideline': {
      const badge = document.createElement('div');
      badge.className = 'guideline-badge';
      badge.textContent = '📋 ' + (msg.source === 'company' ? 'Following ' + msg.name : 'Using Anthropic candidate AI guidance (default)');
      messagesEl.appendChild(badge);
      scrollBottom();
      break;
    }
    case 'preview':
      previewContent = msg.content;
      previewType = msg.content_type;
      showPreview(msg.content_type, msg.content);
      break;
    case 'budget':
      $('budgetBadge').textContent = (msg.remaining || 0).toLocaleString() + ' / ' + (msg.total || 0).toLocaleString() + ' tokens';
      break;
    case 'error':
      showError(msg.message);
      break;
  }
}

function renderHistoryMessage(m) {
  if (m.role === 'user') {
    addBubble('user', escHtml(m.text || '').replace(/\\n/g, '<br>'));
  } else if (m.role === 'agent') {
    const wrap = addBubble('agent', renderMarkdown(m.text || ''));
    if (m.choices && m.choices.length) addChoices(m.choices, true);
  } else if (m.role === 'tool') {
    addToolBar(m.tool || '', m.summary || '', m.toolStatus === 'done');
  }
}

// ── Preview pane ──────────────────────────────────────────────────────────
function showPreview(type, content) {
  const titles = { cv: 'CV Preview', cover_letter: 'Cover Letter Preview', plan: 'Tailoring Plan Preview' };
  $('previewTitle').textContent = titles[type] || 'Preview';
  $('previewContent').innerHTML = renderMarkdown(content);
  $('previewOverlay').hidden = false;
}

$('previewClose').onclick = () => { $('previewOverlay').hidden = true; };
$('previewDownload').onclick = () => {
  const names = { cv: 'tailored-cv.md', cover_letter: 'cover-letter.md', plan: 'tailoring-plan.md' };
  const blob = new Blob([previewContent], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = names[previewType] || 'document.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('previewOverlay').onclick = e => { if (e.target === $('previewOverlay')) $('previewOverlay').hidden = true; };

// ── Error bar ─────────────────────────────────────────────────────────────
function showError(msg) {
  const bar = $('errorBar');
  bar.textContent = '⚠ ' + msg;
  bar.hidden = false;
  clearTimeout(bar._t);
  bar._t = setTimeout(() => { bar.hidden = true; }, 6000);
}

// ── Chat input ────────────────────────────────────────────────────────────
const chatInput = $('chatInput');
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('sendBtn').onclick = sendChat;

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  addUserBubble(text);
  sendMsg('chat', { text });
}

// ── Start over ────────────────────────────────────────────────────────────
$('startOverBtn').onclick = () => {
  if (!confirm('Start a new conversation? The chat history will be cleared (your knowledge base files are kept).')) return;
  pendingJdUpload = false;
  sendMsg('reset', {});
};

// ── KB sidebar ────────────────────────────────────────────────────────────
$('browseBtn').onclick = () => $('kbFileInput').click();
$('kbFileInput').addEventListener('change', uploadKbFiles);

async function uploadKbFiles() {
  const files = Array.from($('kbFileInput').files || []);
  if (!files.length) return;
  const payload = [];
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.md')) { showError('Only Markdown (.md) files are supported for the knowledge base.'); continue; }
    payload.push({ filename: f.name, content: await f.text() });
  }
  $('kbFileInput').value = '';
  if (!payload.length) return;
  try {
    $('browseBtn').disabled = true;
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId, files: payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    renderFileList(data.files, data.totalBytes, data.maxBytes || 1048576);
  } catch (e) { showError(e.message || String(e)); }
  finally { $('browseBtn').disabled = false; }
}

// JD file input (hidden, triggered by chat button)
const jdInput = document.createElement('input');
jdInput.id = 'jdFileInput';
jdInput.type = 'file';
jdInput.accept = '.md,.txt,text/markdown,text/plain';
jdInput.hidden = true;
document.body.appendChild(jdInput);
jdInput.addEventListener('change', async () => {
  const f = jdInput.files && jdInput.files[0];
  if (!f) return;
  pendingJdUpload = false;
  const text = await f.text();
  jdInput.value = '';
  addUserBubble(\`[Uploaded: \${f.name}]\`);
  sendMsg('jd_upload', { text, filename: f.name });
});

$('deleteAllBtn').onclick = async () => {
  if (!confirm('Delete all knowledge base data for this workspace?')) return;
  try {
    const res = await fetch('/api/delete-all', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId }),
    });
    if (res.ok) renderFileList([], 0, 1048576);
    else showError('Delete failed');
  } catch (e) { showError(e.message || String(e)); }
};

// Sidebar toggle
const sidebar = $('sidebar');
$('sidebarToggle').onclick = () => {
  sidebar.classList.toggle('collapsed');
  $('sidebarToggle').innerHTML = sidebar.classList.contains('collapsed') ? '&#9654;' : '&#9664;';
};

async function refreshKb() {
  try {
    const res = await fetch(\`/api/knowledge?workspaceId=\${encodeURIComponent(wsId)}\`);
    if (!res.ok) return;
    const d = await res.json();
    renderFileList(d.files || [], d.totalBytes || 0, d.maxBytes || 1048576);
  } catch {}
}

function renderFileList(files, totalBytes, maxBytes) {
  $('kbMeter').textContent = Math.round(totalBytes / 1024) + ' KB / ' + Math.round(maxBytes / 1024) + ' KB';
  const list = $('kbFiles');
  list.innerHTML = '';
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML =
      '<div><div class="file-name"></div><div class="file-meta"></div></div>' +
      '<button class="secondary sm">✕</button>';
    item.querySelector('.file-name').textContent = f.filename;
    item.querySelector('.file-meta').textContent =
      f.source_type + ' · ' + Math.round(f.content_bytes / 1024) + ' KB';
    item.querySelector('button').onclick = async () => {
      try {
        const res = await fetch(
          \`/api/knowledge/\${encodeURIComponent(f.id)}?workspaceId=\${encodeURIComponent(wsId)}\`,
          { method: 'DELETE', headers: { 'content-type': 'application/json' } }
        );
        const d = await res.json();
        renderFileList(d.files || [], d.files?.reduce((s,x)=>s+x.content_bytes,0)||0, maxBytes);
      } catch (e) { showError(e.message || String(e)); }
    };
    list.appendChild(item);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────
refreshKb();
connect();
})();`;
}
