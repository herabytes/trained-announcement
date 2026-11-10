const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt = (x, d = 3) => x == null ? "-" : (typeof x === "number" ? +x.toFixed(d) : x);
const META_FILTERS = ["channel", "noise_level", "accent", "gender", "type", "source"];
let preds = [], filters = {}, selected = null;

async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

async function init() {
  const runs = await j("/api/runs");
  $("run").innerHTML = runs.map(r => `<option>${esc(r)}</option>`).join("");
  $("run").onchange = () => loadRun($("run").value);
  if (runs.length) loadRun(runs[0]); else $("summary").innerHTML = "<tr><td>No runs found in results/</td></tr>";
}

async function loadRun(id) {
  const [info, p] = await Promise.all([j("/api/runs/" + id), j(`/api/runs/${id}/predictions`)]);
  preds = p; filters = {}; selected = null; $("detail").hidden = true;
  const r = info.run || {};
  $("runinfo").textContent = `${r.created_at || ""} | dataset ${r.dataset || "?"} | normalizer ${r.normalizer || "?"} | wrong weight ${r.fact_score_wrong_weight ?? "?"}${r.notes ? " | " + r.notes : ""}`;
  const sm = (info.summary || {}).models || {};
  $("summary").innerHTML = "<thead><tr><th>Model<th>Clips<th>Mean WER<th>Facts correct<th>Facts wrong<th>Facts missing<th>Fact score</tr></thead><tbody>" +
    Object.entries(sm).map(([m, s]) => `<tr><td>${esc(m)}<td>${s.n_clips}<td>${fmt(s.mean_wer)}<td>${s.facts_correct}<td>${s.facts_wrong}<td>${s.facts_missing}<td>${s.fact_score}</tr>`).join("") + "</tbody>";
  buildFilters(); renderPreds();
}

function buildFilters() {
  const defs = [["model", p => p.model], ...META_FILTERS.map(k => [k, p => (p.meta || {})[k]])];
  $("filters").innerHTML = "";
  for (const [name, get] of defs) {
    const o = [...new Set(preds.map(get).filter(v => v != null))].sort();
    if (!o.length) continue;
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">${name}: all</option>` + o.map(v => `<option>${esc(v)}</option>`).join("");
    sel.onchange = () => { filters[name] = [sel.value, get]; renderPreds(); };
    $("filters").append(sel);
  }
}

function renderPreds() {
  const rows = preds.filter(p => Object.values(filters).every(([v, get]) => !v || String(get(p)) === v));
  $("preds").innerHTML = "<thead><tr><th>Clip<th>Model<th>WER<th>Fact score<th>Wrong<th>Missing<th>Meta</tr></thead><tbody>" +
    rows.map(p => {
      const c = v => (p.facts || []).filter(f => f.verdict === v).length, m = p.meta || {};
      return `<tr data-i="${preds.indexOf(p)}"${p === selected ? ' class="sel"' : ""}><td>${esc(p.clip_id)}<td>${esc(p.model)}<td>${fmt(p.wer)}<td>${p.fact_score}<td>${c("wrong")}<td>${c("missing")}<td class="muted">${esc([m.channel, m.noise_level, m.accent].filter(Boolean).join(" / "))}</tr>`;
    }).join("") + "</tbody>";
  $("preds").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => { selected = preds[tr.dataset.i]; renderPreds(); showDetail(selected); });
}

// Word-level diff via LCS. Returns [refHtml, hypHtml].
function diff(ref, hyp) {
  const a = ref.split(/\s+/).filter(Boolean), b = hyp.split(/\s+/).filter(Boolean);
  const L = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let k = b.length - 1; k >= 0; k--)
    L[i][k] = a[i] === b[k] ? L[i+1][k+1] + 1 : Math.max(L[i+1][k], L[i][k+1]);
  const ra = [], rb = []; let i = 0, k = 0;
  while (i < a.length || k < b.length) {
    if (i < a.length && k < b.length && a[i] === b[k]) { ra.push(esc(a[i++])); rb.push(esc(b[k++])); }
    else if (k >= b.length || (i < a.length && L[i+1][k] >= L[i][k+1])) ra.push(`<span class="del">${esc(a[i++])}</span>`);
    else rb.push(`<span class="ins">${esc(b[k++])}</span>`);
  }
  return [ra.join(" "), rb.join(" ")];
}

function showDetail(p) {
  const [rh, hh] = diff(p.reference_norm ?? p.reference ?? "", p.hypothesis_norm ?? p.hypothesis ?? "");
  const d = $("detail"); d.hidden = false;
  d.innerHTML = `<h2>${esc(p.clip_id)} / ${esc(p.model)}</h2>
    <p id="audiobox"><audio controls src="/audio/${encodeURI(p.audio_path || "")}"></audio></p>
    <div class="cols">
      <div class="box"><b>Reference</b><p>${esc(p.reference)}</p><p class="muted">Normalised (diff):</p><p>${rh}</p></div>
      <div class="box"><b>Hypothesis</b><p>${esc(p.hypothesis)}</p><p class="muted">Normalised (diff):</p><p>${hh}</p></div>
    </div>
    <p>WER ${fmt(p.wer)} | fact score ${p.fact_score}</p>
    <table><thead><tr><th>Field<th>Reference<th>Hypothesis<th>Verdict</tr></thead><tbody>${
      (p.facts || []).map(f => `<tr class="v-${esc(f.verdict)}"><td>${esc(f.field)}<td>${esc(f.ref ?? "-")}<td>${esc(f.hyp ?? "-")}<td>${esc(f.verdict)}</tr>`).join("")}</tbody></table>
    <details><summary>meta</summary><pre>${esc(JSON.stringify(p.meta, null, 1))}</pre></details>`;
  d.querySelector("audio").onerror = () => { $("audiobox").innerHTML = '<span class="warn">Audio not available for this clip.</span>'; };
  d.scrollIntoView({behavior: "smooth"});
}

init().catch(e => document.body.append("Error: " + e.message));
