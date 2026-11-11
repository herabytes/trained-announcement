// Clip labelling page. Titles/descriptions come from Freesound (untrusted) → only ever set via textContent.
const KINDS = [
  ["human_announcement", "human announcement"],
  ["automated_announcement", "automated"],
  ["mixed", "mixed human+auto"],
  ["noise_only", "noise only"],
  ["unusable", "unusable"],
];
const FACTS = ["station", "platform", "time", "delay_min"];
const STATUSES = ["", "on_time", "delayed", "cancelled", "platform_change", "next_stop", "calling_at", "safety", "other"];
let clips = [], current = null;

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const $ = (s) => document.querySelector(s);

async function load() {
  clips = await (await fetch("/api/clips")).json();
  renderList();
}

function renderList() {
  const only = $("#unlabelledOnly").checked;
  const list = $("#list");
  list.replaceChildren();
  let lastGroup = null;
  for (const c of clips) {
    if (only && c.label) continue;
    const group = c.suggested ? "★ suggested" : c.folder.replace("freesound_", "");
    if (group !== lastGroup) list.append(el("div", { className: "grp", textContent: group })), (lastGroup = group);
    const head = el("div", { textContent: (c.suggested ? "★ " : "") + c.clip_id });
    if (c.label) head.append(el("span", { className: "badge " + c.label.kind, textContent: c.label.kind || "saved" }));
    if (c.label && c.label.keep === "yes") head.append(el("span", { className: "badge", textContent: "keep" }));
    const item = el("div", { className: "item" + (current?.clip_id === c.clip_id ? " sel" : "") },
      head, el("div", { className: "t", textContent: c.title || "" }));
    item.onclick = () => select(c.clip_id);
    list.append(item);
  }
  const done = clips.filter((c) => c.label).length;
  $("#progress").textContent = `${done}/${clips.length} labelled`;
}

function field(name, labelText, value, attrs = {}) {
  const input = el("input", { name, value: value ?? "", ...attrs });
  return el("label", {}, labelText, input);
}

function select(id) {
  current = clips.find((c) => c.clip_id === id);
  const c = current, L = c.label || {};
  const audio = el("audio", { controls: true, autoplay: true, src: "/audio/" + c.audio_path });
  audio.onerror = () => panel.prepend(el("p", { className: "warn", textContent: "audio file missing - run scripts/download_data.py" }));

  const g = c.guess || {};
  const guess = el("div", { className: "guess" },
    el("b", { textContent: "Agent's guess (from title/description, NOT listened): " }),
    `${g.human_or_automated || "?"} · accent: ${g.accent_region || "?"} · noise: ${g.noise_level || "?"} · ${g.duration || ""}`,
    el("br"), el("span", { className: "muted", textContent: c.description || "" }));

  const kind = el("div", { className: "row kind" });
  for (const [v, t] of KINDS) {
    const r = el("input", { type: "radio", name: "kind", value: v, checked: L.kind === v });
    kind.append(el("label", {}, r, t));
  }
  const keep = el("label", {}, el("input", { type: "checkbox", name: "keep", checked: L.keep === "yes" }), "use in v0");
  keep.style.cssText = "flex-direction:row;gap:4px;font-size:14px;color:#222";
  kind.append(keep);

  const segBtn = (name) => el("button", { type: "button", textContent: "← playhead",
    onclick: () => (form.elements[name].value = audio.currentTime.toFixed(1)) });
  const playSeg = el("button", { type: "button", textContent: "▶ play segment", onclick: () => {
    const s = parseFloat(form.elements.seg_start.value) || 0, e = parseFloat(form.elements.seg_end.value) || audio.duration;
    audio.currentTime = s; audio.play();
    audio.ontimeupdate = () => { if (audio.currentTime >= e) { audio.pause(); audio.ontimeupdate = null; } };
  }});
  const seg = el("div", { className: "row" },
    field("seg_start", "segment start (s)", L.seg_start, { size: 6 }), segBtn("seg_start"),
    field("seg_end", "segment end (s)", L.seg_end, { size: 6 }), segBtn("seg_end"), playSeg,
    el("span", { className: "muted", textContent: "announcement window, or a speech-free window for noise clips" }));

  const textarea = el("textarea", { name: "transcript", value: L.transcript || "" });
  const draftUsed = el("input", { type: "hidden", name: "draft_used", value: L.draft_used || "" });
  const transcript = el("label", { style: "display:block" }, "transcript (write [inaudible] where you genuinely can't tell - don't guess)",
    textarea, draftUsed);

  // Model drafts: shown separately, only copied in when you click - so a model's
  // output never becomes the answer key by accident. draft_used records which one you started from.
  const drafts = el("div", { className: "guess" },
    el("b", { textContent: "Model drafts (NOT the answer key - listen and correct): " }));
  for (const [model, text] of Object.entries(c.drafts || {})) {
    drafts.append(el("div", {},
      el("button", { type: "button", textContent: "use as starting point", onclick: () => {
        textarea.value = text; draftUsed.value = model; textarea.focus(); } }),
      ` ${model}: `, el("i", { textContent: text || "(empty output)" })));
  }
  if (!Object.keys(c.drafts || {}).length) drafts.append("none yet - run scripts/run_eval.py");

  const status = el("select", { name: "status" });
  for (const s of STATUSES) status.append(el("option", { value: s, textContent: s || "-", selected: L.status === s }));
  const facts = el("div", { className: "row" },
    ...FACTS.map((f) => field(f, f, L[f], { size: f === "station" ? 24 : 8 })),
    el("label", {}, "status", status));

  const gender = el("select", { name: "gender" });
  for (const s of ["", "f", "m", "unclear"]) gender.append(el("option", { value: s, textContent: s || "-", selected: L.gender === s }));
  const noise = el("select", { name: "noise_level" });
  for (const s of ["", "low", "med", "high"]) noise.append(el("option", { value: s, textContent: s || "-", selected: L.noise_level === s }));
  const meta = el("div", { className: "row" },
    field("accent", "accent", L.accent, { size: 14 }), el("label", {}, "gender", gender),
    el("label", {}, "noise level", noise), field("notes", "notes", L.notes, { size: 40 }));

  const saved = el("span", { id: "saved" });
  const actions = el("div", { className: "row" },
    el("button", { type: "submit", className: "primary", textContent: "Save (Ctrl+Enter)" }),
    el("button", { type: "button", textContent: "Save & next", onclick: () => save(true) }), saved);

  const form = el("form", {}, kind, seg, drafts, transcript, el("h4", { textContent: "Key facts" }), facts, meta, actions);
  form.onsubmit = (e) => { e.preventDefault(); save(false); };

  const panel = $("#panel");
  const titleLink = el("a", { href: c.url || "#", target: "_blank", rel: "noopener", textContent: c.title || c.clip_id });
  panel.replaceChildren(el("h2", {}, c.clip_id + " · ", titleLink),
    el("div", { className: "muted", textContent: `${c.folder} · licence: ${c.licence || "?"}` }), audio, guess, form);
  renderList();
}

async function save(next) {
  const form = $("#panel form");
  if (!form) return;
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.keep = form.elements.keep.checked ? "yes" : "no";
  const res = await fetch("/api/labels/" + encodeURIComponent(current.clip_id), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { $("#saved").textContent = "save failed: " + res.status; return; }
  current.label = await res.json();
  $("#saved").textContent = "saved ✓";
  if (next) {
    const i = clips.indexOf(current);
    const n = clips.slice(i + 1).find((c) => !c.label) || clips[i + 1];
    if (n) return select(n.clip_id);
  }
  renderList();
}

document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); save(false); } });
$("#unlabelledOnly").onchange = renderList;
load();
