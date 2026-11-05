// Additions: shader files, proposals and review
const CODE_REPO = "eclipse-obs07";
const CODE_BRANCH = "main";
const ADMIN = "Summxx";
const MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";

const ws = {
  ready: false, loading: false, view: "files",
  head: null, tree: [], byPath: {},
  files: {},        // path -> { original, model }
  tabs: [], active: null,
  proposals: [],    // { data, sha }
  current: null,    // open proposal id
};
let editor = null, diffEditor = null, monacoReady = null;

function loadMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MONACO + "/vs/loader.js";
    s.onerror = () => reject(new Error("editor failed to load"));
    s.onload = () => {
      window.MonacoEnvironment = {
        getWorkerUrl: () => "data:text/javascript;charset=utf-8," + encodeURIComponent(
          `self.MonacoEnvironment={baseUrl:'${MONACO}/'};importScripts('${MONACO}/vs/base/worker/workerMain.js');`),
      };
      window.require.config({ paths: { vs: MONACO + "/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    document.head.appendChild(s);
  });
  return monacoReady;
}

function langOf(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (["glsl", "fsh", "vsh", "gsh", "csh", "tcs", "tes", "h"].includes(ext)) return "cpp";
  if (["properties", "lang", "cfg", "txt"].includes(ext)) return "ini";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  return "plaintext";
}

const codeApi = (p) => `/repos/${OWNER}/${CODE_REPO}${p}`;

async function readBlob(sha) {
  const b = await gh(codeApi(`/git/blobs/${sha}`));
  return fromB64(b.content);
}

async function loadTree() {
  const ref = await gh(codeApi(`/git/ref/heads/${CODE_BRANCH}`));
  ws.head = ref.object.sha;
  const t = await gh(codeApi(`/git/trees/${ws.head}?recursive=1`));
  ws.tree = t.tree.filter((e) => e.type === "blob");
  ws.byPath = Object.fromEntries(ws.tree.map((e) => [e.path, e]));
  $("#ws-head").textContent = CODE_REPO + " @ " + ws.head.slice(0, 7);
}

async function loadProposals() {
  let list = [];
  try { list = await gh(`/repos/${OWNER}/${REPO}/contents/proposals`); }
  catch (e) { if (e.status !== 404) throw e; }
  const out = await Promise.all(list.filter((f) => f.name.endsWith(".json")).map(async (f) => {
    const x = await gh(`/repos/${OWNER}/${REPO}/contents/${f.path}`);
    return { data: JSON.parse(fromB64(x.content)), sha: x.sha };
  }));
  const rank = { open: 0, merged: 1, rejected: 2, closed: 3 };
  out.sort((a, b) => (rank[a.data.status] - rank[b.data.status]) || b.data.created.localeCompare(a.data.created));
  ws.proposals = out;
  const open = out.filter((p) => p.data.status === "open").length;
  $("#c-prop").textContent = open || "";
  $("#c-additions").textContent = open || "";
  const h = $("#h-add");
  if (h) h.textContent = open;
  renderProposalList();
}

async function codeOpen() {
  if (ws.ready || ws.loading) return;
  ws.loading = true;
  $("#ws-msg").textContent = "Loading...";
  try {
    await loadMonaco();
    await loadTree();
    renderTree();
    await loadProposals();
    editor = monaco.editor.create($("#ws-editor"), {
      theme: "vs-dark", automaticLayout: true, fontSize: 13, minimap: { enabled: true },
      model: null, readOnly: true,
    });
    ws.ready = true;
    $("#ws-msg").textContent = "Open a file on the left.";
  } catch (e) {
    $("#ws-msg").textContent = e.status === 404 || e.status === 403
      ? "This token can't read the shader repo. Add " + CODE_REPO + " to your token."
      : "Could not load: " + e.message;
  }
  ws.loading = false;
}

// ---- files ----

function renderTree() {
  const q = $("#ws-search").value.trim().toLowerCase();
  const dirty = new Set(dirtyPaths());
  if (q) {
    $("#ws-tree").innerHTML = ws.tree.filter((e) => e.path.toLowerCase().includes(q)).slice(0, 300)
      .map((e) => `<div class="f ${dirty.has(e.path) ? "dirty" : ""}" data-path="${esc(e.path)}" title="${esc(e.path)}">${esc(e.path)}</div>`).join("");
    return;
  }
  const root = {};
  for (const e of ws.tree) {
    const parts = e.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((p) => node = (node[p + "/"] ||= {}));
    node[parts.at(-1)] = e.path;
  }
  const opened = new Set([...document.querySelectorAll("#ws-tree details[open]")].map((d) => d.dataset.dir));
  const draw = (node, prefix) => Object.keys(node)
    .sort((a, b) => (b.endsWith("/") - a.endsWith("/")) || a.localeCompare(b))
    .map((k) => {
      if (k.endsWith("/")) {
        const dir = prefix + k;
        const hasDirty = [...dirty].some((p) => p.startsWith(dir));
        return `<details data-dir="${esc(dir)}" ${opened.has(dir) ? "open" : ""}><summary class="${hasDirty ? "dirty" : ""}">${esc(k.slice(0, -1))}</summary>${draw(node[k], dir)}</details>`;
      }
      const path = node[k];
      return `<div class="f ${dirty.has(path) ? "dirty" : ""} ${path === ws.active ? "active" : ""}" data-path="${esc(path)}">${esc(k)}</div>`;
    }).join("");
  $("#ws-tree").innerHTML = draw(root, "");
}

async function openFile(path) {
  if (!ws.ready) return;
  showWsView("files");
  if (!ws.files[path]) {
    status("Opening...");
    try {
      const original = await readBlob(ws.byPath[path].sha);
      const model = monaco.editor.createModel(original, langOf(path), monaco.Uri.parse("file:///" + path));
      model.onDidChangeContent(() => { renderTabs(); renderTree(); updateProposeButton(); });
      ws.files[path] = { original, model, sha: ws.byPath[path].sha };
      status("");
    } catch (e) { status("Open failed: " + e.message, true); return; }
  }
  if (!ws.tabs.includes(path)) ws.tabs.push(path);
  ws.active = path;
  editor.setModel(ws.files[path].model);
  editor.updateOptions({ readOnly: false });
  $("#ws-msg").classList.add("hidden");
  renderTabs();
  renderTree();
}

function closeTab(path) {
  ws.tabs = ws.tabs.filter((p) => p !== path);
  if (ws.active === path) {
    ws.active = ws.tabs.at(-1) || null;
    if (ws.active) editor.setModel(ws.files[ws.active].model);
    else { editor.setModel(null); $("#ws-msg").classList.remove("hidden"); $("#ws-msg").textContent = "Open a file on the left."; }
  }
  renderTabs();
  renderTree();
}

const isDirty = (p) => ws.files[p] && ws.files[p].model.getValue() !== ws.files[p].original;
const dirtyPaths = () => Object.keys(ws.files).filter(isDirty);

function renderTabs() {
  $("#ws-tabs").innerHTML = ws.tabs.map((p) => `<div class="tab ${p === ws.active ? "active" : ""} ${isDirty(p) ? "dirty" : ""}" data-path="${esc(p)}" title="${esc(p)}">
    <span>${esc(p.split("/").pop())}</span>${isDirty(p) ? `<i data-revert="${esc(p)}" title="Undo my changes">↺</i>` : ""}<i data-close="${esc(p)}" title="Close">×</i></div>`).join("");
}

function updateProposeButton() {
  const n = dirtyPaths().length;
  $("#ws-propose").disabled = n === 0;
  $("#ws-propose").textContent = n ? `Propose changes (${n})` : "Propose changes";
}

// ---- proposals ----

const propPath = (id) => `proposals/${id}.json`;

async function saveProposal(id, mutate, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let cur, sha;
    try {
      const x = await gh(`/repos/${OWNER}/${REPO}/contents/${propPath(id)}`);
      cur = JSON.parse(fromB64(x.content)); sha = x.sha;
    } catch (e) { if (e.status !== 404) throw e; cur = null; sha = null; }
    const next = mutate(cur);
    try {
      await gh(`/repos/${OWNER}/${REPO}/contents/${propPath(id)}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: toB64(JSON.stringify(next, null, 2) + "\n"), ...(sha ? { sha } : {}) }),
      });
      return next;
    } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error("conflict, refresh and retry");
}

function openProposeModal() {
  const paths = dirtyPaths();
  if (!paths.length) return;
  $("#modal-files").innerHTML = paths.map((p) => `<div class="dim">${esc(p)}</div>`).join("");
  $("#modal").classList.remove("hidden");
  $("#modal-form").title.focus();
}

async function sendProposal(title, notes) {
  const paths = dirtyPaths();
  const id = new Date().toISOString().slice(0, 10) + "-" + uid();
  const p = {
    id, title, notes, by: me, created: today(), status: "open", base: ws.head,
    files: paths.map((path) => ({ path, baseSha: ws.files[path].sha, content: ws.files[path].model.getValue() })),
    comments: [],
  };
  status("Sending...");
  try {
    await saveProposal(id, () => p, `proposal: ${title}`);
    paths.forEach((path) => ws.files[path].model.setValue(ws.files[path].original));
    status("Proposal sent");
    setTimeout(() => status(""), 1500);
    await loadProposals();
    openProposal(id);
  } catch (e) { status("Send failed: " + e.message, true); }
}

function renderProposalList() {
  $("#ws-plist").innerHTML = ws.proposals.length ? ws.proposals.map(({ data: p }) =>
    `<div class="p ${p.id === ws.current ? "active" : ""}" data-prop="${esc(p.id)}">
      <div>${esc(p.title)}</div>
      <small><span class="st ${esc(p.status)}">${esc(p.status)}</span> ${esc(p.by)} · ${esc(p.created)} · ${p.files.length} file${p.files.length > 1 ? "s" : ""}</small>
    </div>`).join("") : `<div class="empty">No proposals yet.</div>`;
}

async function openProposal(id) {
  const entry = ws.proposals.find((x) => x.data.id === id);
  if (!entry) return;
  const p = entry.data;
  ws.current = id;
  showWsView("proposals");
  renderProposalList();
  const canReview = me === ADMIN && p.status === "open";
  const conflicts = p.files.filter((f) => ws.byPath[f.path] && ws.byPath[f.path].sha !== f.baseSha).map((f) => f.path);
  $("#ws-prop").innerHTML = `
    <div class="ph">
      <div>
        <b>${esc(p.title)}</b> <span class="st ${esc(p.status)}">${esc(p.status)}</span>
        <div class="dim">by ${esc(p.by)} on ${esc(p.created)}${p.mergedBy ? ` · merged by ${esc(p.mergedBy)} on ${esc(p.mergedAt)} (${esc((p.commit || "").slice(0, 7))})` : ""}</div>
        ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ""}
      </div>
      <div class="pa">
        ${canReview ? `<button class="primary small" data-pact="approve">Approve and merge</button><button class="small" data-pact="reject">Reject</button>` : ""}
        ${p.status === "open" && p.by === me && me !== ADMIN ? `<button class="small" data-pact="withdraw">Withdraw</button>` : ""}
      </div>
    </div>
    ${conflicts.length && p.status === "open" ? `<div class="warn">Changed on main since this proposal: ${conflicts.map(esc).join(", ")}. The left side shows main now, check the right side keeps those changes before approving.</div>` : ""}
    ${canReview ? `<div class="dim small-note">You can edit the right side before approving.</div>` : ""}
    <div class="pfiles">${p.files.map((f, i) => `<button class="small ${i === 0 ? "active" : ""}" data-pfile="${i}">${esc(f.path)}</button>`).join("")}</div>
    <div class="comments">
      ${(p.comments || []).map((c) => `<div class="c"><b>${esc(c.by)}</b> <span class="dim">${esc(c.at)}</span><div class="notes">${esc(c.text)}</div></div>`).join("")}
      <form id="comment-form"><input name="text" placeholder="Comment" maxlength="2000"><button class="small">Send</button></form>
    </div>`;
  await showProposalFile(p, 0, canReview, conflicts);
}

async function showProposalFile(p, i, editable, conflicts) {
  const f = p.files[i];
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($("#ws-diff"), {
      theme: "vs-dark", automaticLayout: true, fontSize: 13, renderSideBySide: true, originalEditable: false,
    });
  }
  document.querySelectorAll("[data-pfile]").forEach((b) => b.classList.toggle("active", b.dataset.pfile == i));
  status("Loading diff...");
  try {
    if (!ws.review || ws.review.id !== p.id) ws.review = { id: p.id, files: {} };
    // open: compare with main as it is now; closed: with what it started from
    const nowSha = ws.byPath[f.path] ? ws.byPath[f.path].sha : null;
    const left = await readBlob(p.status === "open" && nowSha ? nowSha : f.baseSha);
    const old = diffEditor.getModel();
    const lang = langOf(f.path);
    const right = monaco.editor.createModel(ws.review.files[i] ?? f.content, lang);
    const review = ws.review;
    right.onDidChangeContent(() => { review.files[i] = right.getValue(); });
    diffEditor.setModel({ original: monaco.editor.createModel(left, lang), modified: right });
    diffEditor.getModifiedEditor().updateOptions({ readOnly: !editable });
    if (old) { old.original.dispose(); old.modified.dispose(); }
    status("");
  } catch (e) { status("Diff failed: " + e.message, true); }
}

async function approveProposal(p) {
  if (!confirm(`Merge "${p.title}" into ${CODE_REPO}?`)) return;
  status("Merging...");
  try {
    const finals = p.files.map((f, i) => (ws.review && ws.review.id === p.id && ws.review.files[i] !== undefined) ? ws.review.files[i] : f.content);
    const ref = await gh(codeApi(`/git/ref/heads/${CODE_BRANCH}`));
    const headCommit = await gh(codeApi(`/git/commits/${ref.object.sha}`));
    const tree = await gh(codeApi("/git/trees"), {
      method: "POST",
      body: JSON.stringify({
        base_tree: headCommit.tree.sha,
        tree: p.files.map((f, i) => ({ path: f.path, mode: (ws.byPath[f.path] || {}).mode || "100644", type: "blob", content: finals[i] })),
      }),
    });
    const commit = await gh(codeApi("/git/commits"), {
      method: "POST",
      body: JSON.stringify({
        message: `${p.title}\n\nProposed by ${p.by}` + (p.notes ? `\n\n${p.notes}` : ""),
        tree: tree.sha, parents: [ref.object.sha],
        author: { name: p.by, email: `${p.by}@users.noreply.github.com`, date: new Date().toISOString() },
      }),
    });
    await gh(codeApi(`/git/refs/heads/${CODE_BRANCH}`), { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
    await saveProposal(p.id, (cur) => ({ ...cur, status: "merged", mergedBy: me, mergedAt: today(), commit: commit.sha }), `merged: ${p.title}`);
    status("Merged");
    setTimeout(() => status(""), 1500);
    await afterMerge(p);
  } catch (e) { status("Merge failed: " + e.message, true); }
}

async function afterMerge(p) {
  await loadTree();
  for (const f of p.files) {
    const file = ws.files[f.path];
    if (file && !isDirty(f.path)) {
      file.original = await readBlob(ws.byPath[f.path].sha);
      file.sha = ws.byPath[f.path].sha;
      file.model.setValue(file.original);
    }
  }
  renderTree();
  await loadProposals();
  openProposal(p.id);
}

async function setProposalStatus(p, statusName, reason) {
  status("Saving...");
  try {
    await saveProposal(p.id, (cur) => ({
      ...cur, status: statusName,
      comments: reason ? [...(cur.comments || []), { by: me, at: today(), text: reason }] : cur.comments,
    }), `${statusName}: ${p.title}`);
    status("");
    await loadProposals();
    openProposal(p.id);
  } catch (e) { status("Save failed: " + e.message, true); }
}

function showWsView(view) {
  ws.view = view;
  document.querySelectorAll("[data-ws]").forEach((b) => b.classList.toggle("active", b.dataset.ws === view));
  $("#ws-files").classList.toggle("hidden", view !== "files");
  $("#ws-props").classList.toggle("hidden", view !== "proposals");
  const inProp = view === "proposals" && ws.current;
  $("#ws-top").classList.toggle("hidden", view !== "files");
  $("#ws-editor").classList.toggle("hidden", view !== "files" || !ws.active);
  $("#ws-prop").classList.toggle("hidden", !inProp);
  $("#ws-diff").classList.toggle("hidden", !inProp);
  $("#ws-msg").classList.toggle("hidden", view === "files" ? !!ws.active : !!inProp);
  if (view === "proposals" && !inProp) $("#ws-msg").textContent = ws.proposals.length ? "Pick a proposal on the left." : "No proposals yet. Edit files, then Propose changes.";
  if (view === "files" && !ws.active) $("#ws-msg").textContent = "Open a file on the left.";
}

// ---- events ----

function wireWorkspace() {
  document.querySelectorAll("[data-ws]").forEach((b) => b.onclick = () => showWsView(b.dataset.ws));
  $("#ws-search").oninput = renderTree;
  $("#ws-tree").onclick = (e) => { const f = e.target.closest(".f"); if (f) openFile(f.dataset.path); };
  $("#ws-tabs").onclick = (e) => {
    const close = e.target.closest("[data-close]");
    if (close) { e.stopPropagation(); if (!isDirty(close.dataset.close) || confirm("Close and drop your changes?")) { if (isDirty(close.dataset.close)) ws.files[close.dataset.close].model.setValue(ws.files[close.dataset.close].original); closeTab(close.dataset.close); } return; }
    const rev = e.target.closest("[data-revert]");
    if (rev) { e.stopPropagation(); if (confirm("Undo your changes to this file?")) ws.files[rev.dataset.revert].model.setValue(ws.files[rev.dataset.revert].original); return; }
    const tab = e.target.closest(".tab");
    if (tab) openFile(tab.dataset.path);
  };
  $("#ws-propose").onclick = openProposeModal;
  $("#modal-cancel").onclick = () => $("#modal").classList.add("hidden");
  $("#modal-form").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return;
    $("#modal").classList.add("hidden");
    sendProposal(title, f.notes.value.trim());
    f.reset();
  };
  $("#ws-plist").onclick = (e) => { const p = e.target.closest("[data-prop]"); if (p) openProposal(p.dataset.prop); };
  $("#ws-prop").addEventListener("click", (e) => {
    const entry = ws.proposals.find((x) => x.data.id === ws.current);
    if (!entry) return;
    const p = entry.data;
    const fb = e.target.closest("[data-pfile]");
    if (fb) {
      const conflicts = p.files.filter((f) => ws.byPath[f.path] && ws.byPath[f.path].sha !== f.baseSha).map((f) => f.path);
      showProposalFile(p, +fb.dataset.pfile, me === ADMIN && p.status === "open", conflicts);
      return;
    }
    const act = e.target.closest("[data-pact]");
    if (!act) return;
    if (act.dataset.pact === "approve") approveProposal(p);
    if (act.dataset.pact === "reject") { const r = prompt("Why? (optional)", ""); if (r !== null) setProposalStatus(p, "rejected", r.trim()); }
    if (act.dataset.pact === "withdraw" && confirm("Withdraw this proposal?")) setProposalStatus(p, "closed", "");
  });
  $("#ws-prop").addEventListener("submit", async (e) => {
    if (e.target.id !== "comment-form") return;
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    const id = ws.current;
    status("Sending...");
    try {
      await saveProposal(id, (cur) => ({ ...cur, comments: [...(cur.comments || []), { by: me, at: today(), text }] }), `comment: ${id}`);
      status("");
      await loadProposals();
      openProposal(id);
    } catch (err) { status("Comment failed: " + err.message, true); }
  });
  window.addEventListener("beforeunload", (e) => { if (dirtyPaths().length) { e.preventDefault(); e.returnValue = ""; } });
}
