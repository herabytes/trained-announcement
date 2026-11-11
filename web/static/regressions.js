const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Word diff from a to b: red/struck = removed, blue = added.
function wordDiff(x, y) {
  const a = (x || "").split(/\s+/).filter(Boolean), b = (y || "").split(/\s+/).filter(Boolean);
  const L = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let k = b.length - 1; k >= 0; k--)
    L[i][k] = a[i] === b[k] ? L[i+1][k+1] + 1 : Math.max(L[i+1][k], L[i][k+1]);
  const out = []; let i = 0, k = 0;
  while (i < a.length || k < b.length) {
    if (i < a.length && k < b.length && a[i] === b[k]) { out.push(esc(a[i++])); k++; }
    else if (k >= b.length || (i < a.length && L[i+1][k] >= L[i][k+1])) out.push(`<span class="del">${esc(a[i++])}</span>`);
    else out.push(`<span class="ins">${esc(b[k++])}</span>`);
  }
  return out.join(" ") || '<span class="muted">(empty)</span>';
}

const median = v => { if (!v.length) return null; const s = [...v].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

// Pure logic: before/after = prediction rows for each side.
function compare(before, after, thr) {
  const A = new Map(before.filter(p => p.wer != null).map(p => [p.clip_id, p]));
  const rows = [];
  for (const q of after) {
    const p = A.get(q.clip_id);
    if (!p || q.wer == null) continue;
    const d = +(q.wer - p.wer).toFixed(6);
    let nc = null;
    if ((p.reference_norm ?? "") !== (q.reference_norm ?? "")) nc = "different reference";
    else if (Math.abs((p.meta?.duration_s ?? 0) - (q.meta?.duration_s ?? 0)) > 0.05) nc = "different audio length";
    rows.push({clip: q.clip_id, kind: q.meta?.kind, b: p, a: q, wb: p.wer, wa: q.wer, d, nc,
      verdict: nc ? "not comparable" : d <= -0.05 ? "improved" : d >= 0.05 ? "regressed" : "same"});
  }
  const ok = rows.filter(r => !r.nc);
  const counts = {improved: 0, regressed: 0, same: 0, "not comparable": rows.length - ok.length};
  ok.forEach(r => counts[r.verdict]++);
  const bad = ok.filter(r => r.d > thr);
  rows.sort((x, y) => (!!x.nc - !!y.nc) || y.d - x.d || x.clip.localeCompare(y.clip));
  return {rows, counts, medB: median(ok.map(r => r.wb)), medA: median(ok.map(r => r.wa)), bad};
}
if (typeof module !== "undefined") module.exports = {compare, wordDiff};

if (typeof document !== "undefined") (async () => {
  const $ = id => document.getElementById(id);
  const runs = (await (await fetch("/api/runs")).json()).filter(r => r !== "mock");
  const cache = {}, opts = [];
  for (const r of runs) {
    cache[r] = await (await fetch(`/api/runs/${r}/predictions`)).json();
    for (const m of [...new Set(cache[r].map(p => p.model))]) opts.push(`${r}:${m}`);
  }
  const qs = new URLSearchParams(location.search);
  const defs = {before: "2026-11-11_route_hint:whisper-small-int8", after: "2026-11-11_route_hint:whisper-small-int8+route"};
  for (const id of ["before", "after"]) {
    $(id).innerHTML = opts.map(o => `<option>${esc(o)}</option>`).join("");
    const want = qs.get(id) || defs[id];
    if (opts.includes(want)) $(id).value = want;
    $(id).onchange = render;
  }
  $("thr").oninput = render;
  const rowsOf = v => { const i = v.indexOf(":"); return cache[v.slice(0, i)].filter(p => p.model === v.slice(i + 1)); };
  const f = n => n == null ? "-" : n.toFixed(2);

  function render() {
    const thr = parseFloat($("thr").value) || 0;
    const r = compare(rowsOf($("before").value), rowsOf($("after").value), thr);
    const c = r.counts;
    $("summary").innerHTML = `improved <b class="imp">${c.improved}</b> · regressed <b class="reg">${c.regressed}</b> · same <b>${c.same}</b> · not comparable <b class="nc">${c["not comparable"]}</b> &nbsp;|&nbsp; median WER ${f(r.medB)} → ${f(r.medA)}`;
    $("gate").className = r.bad.length ? "fail" : "pass";
    $("gate").textContent = r.bad.length ? `FAIL: ${r.bad.length} clips regressed > ${thr.toFixed(2)}: ${r.bad.map(x => x.clip).join(", ")}` : "PASS";
    $("tbl").innerHTML = "<tr><th>clip</th><th>kind</th><th>WER before</th><th>WER after</th><th>Δ</th><th>verdict</th><th>change (before → after)</th></tr>" +
      r.rows.map(x => `<tr><td>${esc(x.clip)}</td><td>${esc(x.kind)}</td><td>${f(x.wb)}</td><td>${f(x.wa)}</td>
        <td>${x.d > 0 ? "+" : ""}${x.d.toFixed(2)}</td>
        <td>${x.nc ? `<span class="nc">NOT COMPARABLE: ${x.nc}</span>` : `<span class="${x.verdict === "regressed" ? "reg" : x.verdict === "improved" ? "imp" : ""}">${x.verdict}</span>`}</td>
        <td class="diff">${wordDiff(x.b.hypothesis_norm ?? x.b.hypothesis, x.a.hypothesis_norm ?? x.a.hypothesis)}<div class="ref">ref: ${esc(x.a.reference_norm)}</div></td></tr>`).join("");
  }
  render();
})();
