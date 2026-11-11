// Results viewer: one card per clip, one line per model, so models are easy to compare.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt = (x, d = 3) => x == null ? "-" : (typeof x === "number" ? +x.toFixed(d) : x);
const FILTERS = ["kind", "accent", "noise_level"];
const KIND_ORDER = {human_announcement: 0, mixed: 1, automated_announcement: 2};
let runs = [], checked = new Set(), preds = [], summaries = [], filters = {}, onlyScored = true;

async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

async function init() {
  // Replace the single run dropdown with run checkboxes (several runs can be compared at once).
  runs = (await j("/api/runs")).filter(r => r !== "mock");
  const defaults = runs.filter(r => r.includes("baseline"));
  (defaults.length ? defaults : runs.slice(-1)).forEach(r => checked.add(r));
  const box = document.createElement("span"); box.id = "runs";
  $("run").parentElement.replaceWith(box);
  box.innerHTML = "Runs: " + runs.map(r =>
    `<label class="runchk"><input type="checkbox" value="${esc(r)}"${checked.has(r) ? " checked" : ""}> ${esc(r)}</label>`).join(" ");
  box.querySelectorAll("input").forEach(cb => cb.onchange = () => { cb.checked ? checked.add(cb.value) : checked.delete(cb.value); load(); });

  const clipsDiv = document.createElement("div"); clipsDiv.id = "clips";
  $("preds").replaceWith(clipsDiv);
  if (!runs.length) { $("summary").innerHTML = "<tr><td>No runs found in results/</td></tr>"; return; }
  await load();
}

async function load() {
  const ids = [...checked];
  const data = await Promise.all(ids.map(id => Promise.all([j("/api/runs/" + id), j(`/api/runs/${id}/predictions`)])));
  preds = []; summaries = [];
  data.forEach(([info, p], i) => {
    preds.push(...p.map(x => ({...x, run: ids[i]})));
    for (const [model, s] of Object.entries((info.summary || {}).models || {})) summaries.push({model, run: ids[i], ...s});
  });
  $("runinfo").textContent = `${ids.length} run(s) selected`;
  renderSummary(); buildFilters(); render();
}

function renderSummary() {
  const byKind = (s, k) => { const d = (s.by_kind || {})[k]; return d ? `${fmt(d.mean_wer)} (${d.n})` : "-"; };
  $("summary").innerHTML = "<thead><tr><th>Model<th>Run<th>Clips scored<th>Mean WER<th>WER human (n)<th>WER automated (n)</tr></thead><tbody>" +
    summaries.map(s => `<tr><td>${esc(s.model)}<td class="muted">${esc(s.run)}<td>${s.n_with_reference ?? s.n_clips}<td>${fmt(s.mean_wer)}<td>${byKind(s, "human_announcement")}<td>${byKind(s, "automated_announcement")}</tr>`).join("") + "</tbody>";
}

function buildFilters() {
  $("filters").innerHTML = "";
  for (const name of FILTERS) {
    const opts = [...new Set(preds.map(p => (p.meta || {})[name]).filter(v => v != null))].sort();
    if (!opts.length) continue;
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">${name}: all</option>` + opts.map(v => `<option${filters[name] === v ? " selected" : ""}>${esc(v)}</option>`).join("");
    sel.onchange = () => { filters[name] = sel.value; render(); };
    $("filters").append(sel);
  }
  const lbl = document.createElement("label");
  lbl.innerHTML = `<input type="checkbox"${onlyScored ? " checked" : ""}> only clips with a reference`;
  lbl.querySelector("input").onchange = e => { onlyScored = e.target.checked; render(); };
  $("filters").append(lbl);
}

// One-line word diff of what the model wrote vs what was said:
// plain = matched, red/struck = said but missed, blue = written but not said.
function inlineDiff(ref, hyp) {
  if (!ref) return esc(hyp);
  const a = ref.split(/\s+/).filter(Boolean), b = (hyp || "").split(/\s+/).filter(Boolean);
  const L = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let k = b.length - 1; k >= 0; k--)
    L[i][k] = a[i] === b[k] ? L[i+1][k+1] + 1 : Math.max(L[i+1][k], L[i][k+1]);
  const out = []; let i = 0, k = 0;
  while (i < a.length || k < b.length) {
    if (i < a.length && k < b.length && a[i] === b[k]) { out.push(esc(a[i++])); k++; }
    else if (k >= b.length || (i < a.length && L[i+1][k] >= L[i][k+1])) out.push(`<span class="del">${esc(a[i++])}</span>`);
    else out.push(`<span class="ins">${esc(b[k++])}</span>`);
  }
  return out.join(" ") || '<span class="muted">(empty output)</span>';
}

const werClass = w => w == null ? "" : w < 0.2 ? "w-good" : w < 0.5 ? "w-mid" : "w-bad";

function render() {
  // Group rows by clip, keeping models in the order they first appear.
  const modelOrder = [...new Set(preds.map(p => p.model))];
  const groups = new Map();
  for (const p of preds) {
    if (onlyScored && p.wer == null) continue;
    if (!Object.entries(filters).every(([k, v]) => !v || String((p.meta || {})[k]) === v)) continue;
    if (!groups.has(p.clip_id)) groups.set(p.clip_id, []);
    groups.get(p.clip_id).push(p);
  }
  const clips = [...groups.entries()].sort(([a, pa], [b, pb]) =>
    (KIND_ORDER[pa[0].meta?.kind] ?? 3) - (KIND_ORDER[pb[0].meta?.kind] ?? 3) || a.localeCompare(b));
  // Same model in two selected runs -> show which run each line came from.
  const dupModels = new Set(summaries.map(s => s.model).filter((m, i, all) => all.indexOf(m) !== i));

  $("clips").innerHTML = clips.length ? clips.map(([clip, ps]) => {
    const p0 = ps[0], m = p0.meta || {};
    const rows = ps.sort((x, y) => modelOrder.indexOf(x.model) - modelOrder.indexOf(y.model)).map(p =>
      `<tr><td>${esc(p.model)}${dupModels.has(p.model) ? `<div class="muted">${esc(p.run)}</div>` : ""}</td>
        <td class="${werClass(p.wer)}">${fmt(p.wer, 2)}</td><td>${fmt(p.inference_s, 1)} s</td>
        <td title="${esc(p.hypothesis)}">${inlineDiff(p.reference_norm, p.hypothesis_norm ?? p.hypothesis)}</td></tr>`).join("");
    return `<div class="clip">
      <div class="cliphead"><b>${esc(clip)}</b> <span class="tag">${esc((m.kind || "unlabelled").replace("_announcement", ""))}</span>
        <span class="muted">${fmt(m.duration_s, 1)} s${m.accent ? " · " + esc(m.accent) : ""}${m.noise_level ? " · noise " + esc(m.noise_level) : ""}</span>
        <audio controls preload="none" src="/audio/${encodeURI(p0.audio_path || "")}"></audio></div>
      <div class="ref"><span class="muted">What was said:</span> ${esc(p0.reference ?? "(no reference)")}</div>
      <table class="cmp"><thead><tr><th>Model<th>WER<th>Time<th>What it wrote <span class="muted">(<span class="del">missed</span> · <span class="ins">added</span>)</span></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }).join("") : '<p class="muted">No clips match.</p>';
}

init().catch(e => document.body.append("Error: " + e.message));
