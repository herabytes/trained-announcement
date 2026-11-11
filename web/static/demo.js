// Live demo page ("on the train" view).
// Pick an announcement and press Play, or record one yourself. The audio goes to POST /api/transcribe
// and the transcript appears as a card. Each card has a play button for exactly the audio the model heard.
// "Simulate my PA" (mic only): POST /api/simulate makes a train-PA version of your recording; the page
// plays your voice, then the PA version, and transcribes both.
// Dataset clips also get a .refbox (human reference + word diff), always visible.
// Technical details (latency, model, segments) live in each card's .tech block and only
// show when the Analysis switch is on (body.analysis).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

const RECOMMENDED = ["fs40156", "fs277754", "fs267700", "fs83789", "fs44974"];  // clip ids hand-picked by the user, shown first in the clip picker (in this order)

// Copied from README.md "Failure examples" (keep the two in sync).
const FAILURES = [
  ["Real-world channel breaks a small model", ["fs267700"],
    'Parakeet: "Surely." on the real recording; perfect on a clean synthetic version of the same sentence'],
  ["Hallucination in non-speech windows", ["fs44974", "fs65805", "fs277754", "fs533718"],
    'Whisper writes fluent text that was never said: "Thank you for watching", "Let us know in the comments if you want more"'],
  ["Audible to a human, invisible to models", ["fs44974"],
    'Whisper rates the first 30 s "not speech" and outputs nothing; a standard VAD also finds no speech'],
  ["Silent failure", ["fs317554", "fs40156", "fs95874"], "Parakeet returns an empty transcript"],
  ["Place names mangled", ["fs65803", "fs65806", "fs646162"],
    '"Kirkcaldy" → "Capote"/"Carcotti", "Edinburgh Waverley" → "Ember Wavelay"'],
];

let clips = {};            // clip_id -> {title, reference, seg_start, ...} from /api/demo/clips
let clipList = [];         // the raw list from /api/demo/clips
let lastRecording = null;  // the most recent mic recording (a Blob)

// ---------- Form fields shared by every transcription request ----------
let route = null;          // {origin, destination, stations, hint} once a journey is set and looked up
const journeyOf = () => ({origin: $("from").value.trim(), destination: $("to").value.trim(), operator: $("operator").value});
const hasJourney = () => !!(route && route.origin === $("from").value.trim() && route.destination === $("to").value.trim());

function buildForm(audioBlob, filename, ctx = $("context").checked) {
  const form = new FormData();
  form.append("journey", JSON.stringify(journeyOf()));
  form.append("denoise", false);                  // no denoiser yet (control hidden until one exists)
  form.append("context", ctx);
  if (audioBlob) form.append("audio", audioBlob, filename);
  return form;
}

const extFor = blob => (blob.type.match(/audio\/(\w+)/) || [, "webm"])[1];

// ---------- The result area: one result set at a time ----------
// A "result set" = the cards for one action (1 card, or 2 for Simulate my PA).
// Starting a new action clears the old set and stops its audio. Each set has an id, so a slow
// response from an old set can't write into the new one.
let current = {id: 0, cards: []};

function newResultSet() {
  current.cards.forEach(c => c.player.stop());
  current = {id: current.id + 1, cards: []};
  $("result").innerHTML = "";
  return current.id;
}

// A player for one card: plays `src`, optionally only the segment start..end (seconds).
function makePlayer(btn) {
  const audio = new Audio();
  let start = 0, end = null;
  const p = {
    onDone: null,                                       // called when playback reaches the end
    setSource(src, s = 0, e = null) { audio.src = src; start = s; end = e; btn.disabled = !src; },
    async play() {
      if (!audio.src) return;
      if (audio.readyState < 1) await new Promise(r => audio.addEventListener("loadedmetadata", r, {once: true}));
      if (audio.currentTime < start || (end != null && audio.currentTime >= end - 0.05) || audio.ended) audio.currentTime = start;
      audio.play().catch(() => {});                       // autoplay blocked: the user can press the button
    },
    stop() { audio.pause(); },
    toggle() { audio.paused ? p.play() : audio.pause(); },
  };
  const finish = () => { audio.pause(); audio.currentTime = start; if (p.onDone) p.onDone(); };
  audio.addEventListener("timeupdate", () => { if (end != null && audio.currentTime >= end) finish(); });
  audio.addEventListener("ended", finish);
  audio.addEventListener("play", () => { btn.classList.add("playing"); btn.textContent = "❚❚"; });
  audio.addEventListener("pause", () => { btn.classList.remove("playing"); btn.textContent = "▶"; });
  btn.onclick = () => p.toggle();
  btn.disabled = true;
  return p;
}

function enableAnalysis() {
  $("analysis").disabled = false;
  $("analysis").closest("label").title = "Show timings, model details, route-hint comparison and the evaluation evidence";
}

// POST one transcription request. Returns the JSON, or throws with the server's message.
async function postTranscribe(form) {
  const r = await fetch("/api/transcribe", {method: "POST", body: form});
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail || r.status);
  return d;
}

// One message card: header with play button, the plain transcript, the reference, the
// with/without-hint comparison (.cmp, only while Compare is on) and a hidden .tech block.
function addCard(runId, who, cls = "") {
  const el = document.createElement("article");
  el.className = "msg " + cls;
  const when = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  el.innerHTML = `<div class="msg-head"><button class="playbtn" title="Play the audio this transcript came from">▶</button>
    <span class="who">${esc(who)}</span><span class="when">${when}</span></div>
    <div class="said"></div><div class="refbox"></div><div class="cmp"></div><div class="tech"></div>`;
  $("result").append(el);
  const card = {
    el, runId,
    data: null,      // the main transcription response
    mk: null,        // ctx => FormData for this card's audio, so Compare can re-run it the other way
    extra: {},
    cmp: null,       // {key, data, error, pending}: the opposite-hint run for route `key`
    player: makePlayer(el.querySelector(".playbtn")),
    status(text) { el.querySelector(".said").innerHTML = `<div class="thinking">${esc(text)}</div>`; },
    error(msg) {
      el.classList.add("err");
      el.querySelector(".said").innerHTML = `<div class="lead">Sorry, that didn't work.</div><div class="hint">${esc(msg)}</div>`;
    },
    show(d, extra = {}) {
      // The route lookup failed, so the hint only had the two ends of the journey: say so on the card.
      const missed = d.hint_partial
        ? `<div class="notice">Partial route hint: ${esc(d.hint_note)}.</div>` : "";
      el.querySelector(".said").innerHTML = (d.text
        ? `<div class="lead">This is what was said:</div><div class="text">${esc(d.text)}</div>`
        : `<div class="lead">This is what was said:</div><div class="empty">Couldn't make out any speech.</div>`) + missed;
      el.querySelector(".refbox").innerHTML = refHtml(d.source && d.source.reference, d.reference_norm, d.text_norm);
      el.querySelector(".tech").innerHTML = techHtml(d, extra);
    },
    // Transcribe this card's audio (mk(ctx) builds the form) and fill the card. Returns the response (or null).
    async transcribe(mk, ctx, extra = {}) {
      card.mk = mk; card.extra = extra;
      card.status("transcribing…");
      try {
        const d = await postTranscribe(mk(ctx));
        if (runId !== current.id) return null;          // the user has moved on
        card.data = d;
        card.show(d, extra);
        enableAnalysis();                               // first transcript: the Analysis switch becomes usable
        if (comparing()) queueCompare(card);
        return d;
      } catch (e) {
        if (runId === current.id) card.error(e.message);
        return null;
      }
    },
  };
  current.cards.push(card);
  return card;
}

// ---------- Compare: the same audio with vs without the route hint ----------
// Turning Compare on re-runs every finished card with the opposite hint setting; new cards get
// their second run automatically. Runs go one at a time (the server does one at a time anyway).
const routeKey = () => route ? `${route.origin} → ${route.destination}` : "";
const comparing = () => $("compare").checked && hasJourney();
let compareQueue = Promise.resolve();

function queueCompare(card) {
  const key = routeKey();
  if (!card.data || !card.mk || (card.cmp && card.cmp.key === key)) return renderCompare(card);  // done already
  card.cmp = {key, pending: true};
  renderCompare(card);
  const ctx = !card.data.context.applied;               // the other way round from the main run
  compareQueue = compareQueue.then(async () => {
    if (card.runId !== current.id || card.cmp.key !== key) return;   // stale: card gone or journey changed
    try { card.cmp = {key, data: await postTranscribe(card.mk(ctx))}; }
    catch (e) { card.cmp = {key, error: e.message}; }
    if (card.runId === current.id) renderCompare(card);
  });
}

// Words of a transcript, keeping the original spelling for display; `k` is the comparison key.
const tokens = s => String(s || "").split(/\s+/).filter(Boolean)
  .map(w => ({w, k: w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")}));

// WER of one response against its reference (null if the clip has no reference).
function werOf(d) {
  const a = words(d.reference_norm), b = words(d.text_norm);
  if (!d.source || !d.source.reference || !a.length) return null;
  return align(a, b).filter(o => o[0] !== "=").length / a.length;
}

function renderCompare(card) {
  const el = card.el.querySelector(".cmp");
  const c = card.cmp, main = card.data;
  if (!c || !main) { el.innerHTML = ""; return; }
  const mainHasHint = main.context.applied;
  const other = c.data;
  const withD = mainHasHint ? main : other, without = mainHasHint ? other : main;

  // Which words the hint changed: align the two transcripts word by word.
  let noHtml = "", hintHtml = "", changed = 0;
  if (withD && without && withD.context.applied) {
    const A = tokens(without.text), B = tokens(withD.text);
    let i = 0, k = 0;
    const no = [], yes = [];
    for (const [op] of align(A.map(t => t.k), B.map(t => t.k))) {
      if (op === "=") { no.push(esc(A[i++].w)); yes.push(esc(B[k++].w)); continue; }
      changed++;
      if (op === "S" || op === "D") no.push(`<span class="gone">${esc(A[i++].w)}</span>`);
      if (op === "S" || op === "I") yes.push(`<mark class="came">${esc(B[k++].w)}</mark>`);
    }
    noHtml = no.join(" "); hintHtml = yes.join(" ");
  }

  const row = (cls, tag, d, html, note) => `<div class="cmp-row ${cls}">
      <div class="cmp-tag">${tag}</div>
      <div class="cmp-text">${note || html || (d && d.text ? esc(d.text) : '<span class="hint">no speech found</span>')}</div>
      <div class="cmp-wer">${d && werOf(d) != null ? `WER ${werOf(d).toFixed(2)}` : ""}</div></div>`;
  const pending = '<span class="thinking">re-running…</span>';
  const failed = msg => `<span class="notice inline">${esc(msg)}</span>`;
  const hintMissing = withD && !withD.context.applied;  // asked for the hint, server couldn't build it

  let foot;
  if (c.pending) foot = `Transcribing ${mainHasHint ? "without" : "with"} the hint for ${esc(c.key)}…`;
  else if (c.error) foot = "The second run failed.";
  else if (hintMissing) foot = "No route hint available, so there's nothing to compare.";
  else {
    const w0 = werOf(without), w1 = werOf(withD);
    const delta = w0 == null ? "" : w1 < w0 ? `<span class="delta better">WER ${w0.toFixed(2)} → ${w1.toFixed(2)} · hint helped</span>`
      : w1 > w0 ? `<span class="delta worse">WER ${w0.toFixed(2)} → ${w1.toFixed(2)} · hint hurt</span>`
      : `<span class="delta same">WER unchanged (${w0.toFixed(2)})</span>`;
    foot = (withD.hint_partial ? "Hint had only the origin and destination. " : "") + (changed ? `The route hint changed <b>${changed}</b> word${changed === 1 ? "" : "s"}.` : "The route hint changed nothing here.") + delta;
  }
  el.innerHTML = `<div class="cmp-title">With vs without route hint <span>${esc(c.key)}</span></div>
    ${row("no", "No hint", without, noHtml, !without ? (c.error ? failed(c.error) : pending) : "")}
    ${row("yes", "Route hint", hintMissing ? null : withD, hintHtml, !withD ? (c.error ? failed(c.error) : pending) : hintMissing ? failed("no journey set, so no hint") : "")}
    <div class="cmp-foot">${foot}</div>`;
}

// Show the Route hint panel only when there is a route, and (re)run comparisons when Compare is on.
function updateCompareUI() {
  $("hintpanel").hidden = !hasJourney();
  document.body.classList.toggle("comparing", comparing());
  if (comparing()) current.cards.forEach(queueCompare);
}

// ---------- Human reference vs model: word diff ----------
// The server normalises both texts with the eval's own normaliser (reference_norm, text_norm),
// so here we only split into words: the WER shown equals what scripts/run_eval.py would score.
const words = s => String(s || "").split(/\s+/).filter(Boolean);

// Word alignment by edit distance, the same alignment WER (jiwer) is built on.
// Each step is one of: ["=", word] match, ["S", said, written] substitution,
// ["D", said] deletion (said but missed), ["I", written] insertion (written but never said).
// So the counts below add up to exactly WER = (S + D + I) / reference words.
function align(a, b) {
  const C = Array.from({length: a.length + 1}, (_, i) => Array.from({length: b.length + 1}, (_, k) => i + k));
  for (let i = 1; i <= a.length; i++) for (let k = 1; k <= b.length; k++)
    C[i][k] = Math.min(C[i-1][k-1] + (a[i-1] === b[k-1] ? 0 : 1), C[i-1][k] + 1, C[i][k-1] + 1);
  // Walk back from the end. Several alignments can have the same (minimum) cost, which changes the
  // picture but never the WER; prefer match, then missed/added, then substitution, which reads most naturally.
  const ops = []; let i = a.length, k = b.length;
  while (i > 0 || k > 0) {
    if (i > 0 && k > 0 && a[i-1] === b[k-1] && C[i][k] === C[i-1][k-1]) { ops.push(["=", a[i-1]]); i--; k--; }
    else if (i > 0 && C[i][k] === C[i-1][k] + 1) { ops.push(["D", a[i-1]]); i--; }
    else if (k > 0 && C[i][k] === C[i][k-1] + 1) { ops.push(["I", b[k-1]]); k--; }
    else { ops.push(["S", a[i-1], b[k-1]]); i--; k--; }
  }
  return ops.reverse();
}

// The reference block, right under the transcript. Always visible, but only dataset clips have one.
function refHtml(reference, referenceNorm, hypothesisNorm) {
  if (!reference) return "";
  const a = words(referenceNorm), b = words(hypothesisNorm);
  const ops = align(a, b);
  const n = t => ops.filter(o => o[0] === t).length;
  const S = n("S"), D = n("D"), I = n("I");
  const w = a.length ? (S + D + I) / a.length : null;
  const grade = w == null ? "" : w < 0.2 ? "good" : w < 0.5 ? "mid" : "bad";
  const del = word => `<span class="del">${esc(word)}</span>`, ins = word => `<span class="ins">${esc(word)}</span>`;
  const diff = ops.map(([op, x, y]) =>
    op === "=" ? esc(x) : op === "S" ? `<span class="sub">${del(x)}<span class="to">→</span>${ins(y)}</span>`
    : op === "D" ? del(x) : ins(x)).join(" ");
  return `<div class="ref-head"><span class="ref-title">Human reference</span>
      ${w == null ? "" : `<span class="wer ${grade}" title="word error rate, normalised and scored the same way as the eval">WER ${w.toFixed(2)}</span>`}</div>
    <div class="ref-text">“${esc(reference)}”</div>
    <div class="ref-diff">${diff}</div>
    <div class="legend">
      <span><span class="sub"><span class="del">said</span><span class="to">→</span><span class="ins">written</span></span> substituted ${S}</span>
      <span><span class="del">missed</span> ${D}</span>
      <span><span class="ins">added</span> ${I}</span>
      ${w == null ? "" : `<span class="formula">(${S} + ${D} + ${I}) / ${a.length} words = ${w.toFixed(2)}</span>`}</div>`;
}

// Everything technical about one transcription (only visible with Analysis on).
function techHtml(d, extra) {
  const src = d.source || {};
  const tile = (label, value, note = "") =>
    `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div>${note ? `<div class="t-note">${note}</div>` : ""}</div>`;
  const tiles = [
    tile("Latency", `${d.latency_s.toFixed(2)} s`, d.model_load_s > 0.05 ? `+ ${d.model_load_s.toFixed(1)} s first load` : ""),
    tile("Audio", `${d.audio_s.toFixed(1)} s`),
  ].join("");
  const chip = (text, on = true) => `<span class="chip${on ? "" : " dim"}">${text}</span>`;
  const chips = [
    chip(esc(d.model)),
    src.clip_id ? chip(`clip ${esc(src.clip_id)}${src.segment ? ` · ${src.segment[0]}–${src.segment[1] ?? "end"} s` : ""}`) : "",
    extra.simulated ? chip(`train PA · ${extra.simulated.snr_db} dB SNR${extra.simulated.pa_filter ? " · band-pass" : ""}`) : "",
    chip(`context hint ${d.context.applied ? "on" : "off"}`, d.context.applied),
    d.hint ? chip(esc(d.hint)) : "",
    d.hint_partial ? chip("partial hint: origin + destination only", false) : "",
  ].join("");
  const segs = d.segments.length
    ? `<details><summary>Whisper segments (${d.segments.length})</summary>
        <table class="segs"><tr><th>time</th><th>text</th><th title="Whisper's probability that this window is not speech">no-speech</th></tr>${d.segments.map(s => {
          const p = +s.no_speech_prob || 0;
          return `<tr><td class="time">${(+s.start).toFixed(1)}–${(+s.end).toFixed(1)} s</td><td>${esc(s.text)}</td>
            <td><div class="bar${p > 0.5 ? " high" : ""}" title="${p.toFixed(2)}"><i style="width:${(p * 100).toFixed(0)}%"></i></div></td></tr>`;
        }).join("")}</table></details>`
    : `<div class="hint">No segments: Whisper found no speech.</div>`;
  return `<div class="tiles">${tiles}</div><div class="chips">${chips}</div>${segs}`;
}

// ---------- Dataset announcements ----------
const secs = dur => { const m = String(dur || "").match(/^(\d+):(\d+(?:\.\d+)?)$/); return m ? +m[1] * 60 + +m[2] : null; };
const mmss = s => s == null ? "?" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

async function loadClips() {
  const list = await (await fetch("/api/demo/clips")).json();
  clips = Object.fromEntries(list.map(c => [c.clip_id, c]));
  clipList = list;
  renderClips();
  renderFailures();
}

const norm = s => String(s || "").trim().toLowerCase();
// Clips whose recorded journey equals origin -> destination (case-insensitive, trimmed).
const clipsOnJourney = (list, origin, destination) => list.filter(c =>
  c.journey && norm(c.journey.origin) === norm(origin) && norm(c.journey.destination) === norm(destination));
const NO_CLIPS_MSG = "No recorded announcements for this journey: record your own announcement below.";

// Rebuild the picker from the current journey fields: no journey = all clips; journey = only its clips.
function renderClips() {
  const origin = $("from").value, destination = $("to").value;
  const journeySet = norm(origin) && norm(destination);
  const option = c => {
    const name = (c.title || c.clip_id).replace(/\.(wav|mp3|flac)$/i, "");
    const start = +c.seg_start || 0, end = c.seg_end ? +c.seg_end : secs(c.duration);  // length the model hears
    // Clips without a human reference are still worth demoing; just flag that there's no WER for them.
    const noRef = c.reference ? "" : " (⚠ no ground truth)";
    return `<option value="${esc(c.clip_id)}">${esc(name)} (${mmss(end == null ? null : end - start)}) · ${esc(c.clip_id)}${noRef}</option>`;
  };
  const byRec = (a, b) => { const i = x => RECOMMENDED.includes(x.clip_id) ? RECOMMENDED.indexOf(x.clip_id) : 1e9; return i(a) - i(b); };
  const keep = $("clip").value;
  const sel = $("clip");
  sel.disabled = false;
  if (!clipList.length) {
    sel.innerHTML = '<option value="">no announcements found: run python scripts/download_data.py</option>';
  } else if (journeySet) {
    const match = clipsOnJourney(clipList, origin, destination).sort(byRec);  // stable: keeps list order otherwise
    if (!match.length) { sel.innerHTML = `<option value="">${esc(NO_CLIPS_MSG)}</option>`; sel.disabled = true; }
    else sel.innerHTML = '<option value="">choose an announcement…</option>' +
      `<optgroup label="Announcements on this journey">${match.map(option).join("")}</optgroup>`;
  } else {
    const recommended = RECOMMENDED.filter(id => clips[id]).map(id => clips[id]);
    const rest = clipList.filter(c => !RECOMMENDED.includes(c.clip_id));
    sel.innerHTML = '<option value="">choose an announcement…</option>' +
      (recommended.length ? `<optgroup label="Recommended">${recommended.map(option).join("")}</optgroup>` : "") +
      `<optgroup label="All clips">${rest.map(option).join("")}</optgroup>`;
  }
  sel.value = keep;
  if (sel.value !== keep) sel.value = "";
  $("play").disabled = !clips[sel.value];
}

function selectClip(id) {
  $("clip").value = clips[id] ? id : "";
  $("play").disabled = !clips[id];
  const j = clips[id] && clips[id].journey;
  if (j) setJourney(j.origin, j.destination);
}

// ---------- Journey + route hint ----------
async function setJourney(origin, destination) {
  $("from").value = origin; $("to").value = destination;
  route = null;
  renderClips();
  updateCompareUI();
  $("routebox").hidden = true;
  if (!origin.trim() || !destination.trim()) { $("routemsg").textContent = ""; return; }
  $("routemsg").textContent = "looking up route…";
  try {
    const r = await fetch(`/api/route?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || r.status);
    if ($("from").value.trim() !== origin.trim() || $("to").value.trim() !== destination.trim()) return;  // user moved on
    route = d;
    $("routemsg").textContent = d.partial ? `Partial route hint: ${d.note}.` : "";
    $("routehint").textContent = "Route hint: " + d.hint;
    $("routebox").hidden = false;
    updateCompareUI();
  } catch (e) {
    $("routemsg").textContent = e.message;
  }
}

async function loadRoutes() {
  try {
    const list = await (await fetch("/api/routes")).json();
    $("routechips").innerHTML = list.map((r, i) =>
      `<button class="ghost chipbtn" data-i="${i}">${esc(r.origin)} → ${esc(r.destination)}</button>`).join("");
    $("routechips").onclick = e => {
      const r = list[e.target.dataset && e.target.dataset.i];
      if (r) setJourney(r.origin, r.destination);
    };
  } catch (e) { /* presets are optional */ }
}
$("from").onchange = $("to").onchange = () => setJourney($("from").value, $("to").value);
let typingTimer = null;
$("from").oninput = $("to").oninput = () => { clearTimeout(typingTimer); typingTimer = setTimeout(renderClips, 250); };
$("clearjourney").onclick = () => setJourney("", "");

// Play: start the audio AND the transcription at the same time, like hearing it on the train.
function playClip() {
  const c = clips[$("clip").value];
  if (!c) return;
  const runId = newResultSet();
  const src = "/audio/" + c.audio_path, s0 = +c.seg_start || 0, s1 = c.seg_end ? +c.seg_end : null;
  const mk = ctx => { const f = buildForm(null, null, ctx); f.append("clip_id", c.clip_id); return f; };
  const card = addCard(runId, "Announcement");
  // The API trims labelled clips to seg_start..seg_end; play exactly that part.
  card.player.setSource(src, s0, s1);
  card.player.play();
  card.transcribe(mk, $("context").checked && hasJourney());   // Compare adds the other run itself
}

// ---------- Microphone ----------
let recorder = null, recStart = 0, recTimer = null;

async function toggleRecording() {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  current.cards.forEach(c => c.player.stop());          // don't record our own playback
  let stream;
  try {
    // Browser clean-up off: echo cancellation would erase a clip played from this computer's
    // speakers, and noise suppression would be a hidden denoiser.
    stream = await navigator.mediaDevices.getUserMedia(
      {audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  } catch (e) {
    $("recinfo").textContent = "Microphone blocked or missing: " + e.message;
    return;
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";
  recorder = new MediaRecorder(stream, type ? {mimeType: type} : {});
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());          // release the mic
    clearInterval(recTimer);
    $("rec").classList.remove("on");
    $("rec").textContent = "● Record";
    lastRecording = new Blob(chunks, {type: recorder.mimeType});
    $("recinfo").textContent = `${((Date.now() - recStart) / 1000).toFixed(1)} s recorded`;
    $("simulate").disabled = false;
    $("simulate").title = "Hear and transcribe your recording as if it came through a train PA";
    transcribeRecording();                              // stop speaking -> transcribe
  };
  recorder.start();
  recStart = Date.now();
  $("rec").classList.add("on");
  $("rec").textContent = "■ Stop";
  recTimer = setInterval(() => $("recinfo").textContent = `recording… ${((Date.now() - recStart) / 1000).toFixed(0)} s`, 250);
}

function transcribeRecording() {
  const runId = newResultSet();
  const rec = lastRecording, name = `mic.${extFor(rec)}`;
  const card = addCard(runId, "Your voice");
  card.player.setSource(URL.createObjectURL(rec));
  card.transcribe(ctx => buildForm(rec, name, ctx), $("context").checked && hasJourney());
}

// Simulate my PA: play your voice, then straight away the train-PA version; transcribe both.
async function simulatePA() {
  if (!lastRecording) return;
  const rec = lastRecording;
  const runId = newResultSet();
  const voice = addCard(runId, "Your voice");
  const pa = addCard(runId, "Through the train PA", "pa");
  voice.player.setSource(URL.createObjectURL(rec));
  pa.status("making it sound like a train…");

  let voiceDone = false, paBlob = null, paStarted = false;
  const playPAWhenReady = () => {
    if (voiceDone && paBlob && !paStarted && runId === current.id) { paStarted = true; pa.player.play(); }
  };
  voice.player.onDone = () => { voiceDone = true; playPAWhenReady(); };
  voice.player.play();

  // 1. Ask the server for the PA version (fast: no model involved).
  const settings = {snr_db: +$("snr").value, pa_filter: $("pa").checked};
  try {
    const f = new FormData();
    f.append("audio", rec, `mic.${extFor(rec)}`);
    f.append("snr_db", settings.snr_db);
    f.append("pa_filter", settings.pa_filter);
    const r = await fetch("/api/simulate", {method: "POST", body: f});
    if (!r.ok) throw new Error((await r.json()).detail || r.status);
    paBlob = await r.blob();
  } catch (e) {
    if (runId === current.id) pa.error(e.message);
  }
  if (runId !== current.id) return;
  if (paBlob) {
    pa.player.setSource(URL.createObjectURL(paBlob));
    pa.status("waiting…");
    playPAWhenReady();
  }

  // 2. Transcribe both, one after the other (the server runs one at a time anyway).
  const ctx = $("context").checked && hasJourney();
  await voice.transcribe(c => buildForm(rec, `mic.${extFor(rec)}`, c), ctx);
  if (paBlob && runId === current.id) await pa.transcribe(c => buildForm(paBlob, "pa.wav", c), ctx, {simulated: settings});
}

// ---------- Analysis panel + evidence ----------
function renderFailures() {
  const link = id => clips[id]
    ? `<a data-clip="${esc(id)}">${esc(id)}</a>`
    : `<span class="missing" title="not available: audio not downloaded, or labelled noise only / unusable">${esc(id)}</span>`;
  $("failures").innerHTML = "<tr><th>Failure<th>Clips<th>What happened</tr>" +
    FAILURES.map(([f, ids, what]) => `<tr><td>${esc(f)}<td>${ids.map(link).join(", ")}<td>${esc(what)}</tr>`).join("");
}

$("failures").onclick = e => {
  const id = e.target.dataset && e.target.dataset.clip;
  if (!id) return;
  selectClip(id);
  $("clip").scrollIntoView({behavior: "smooth", block: "center"});
};
$("analysis").onchange = () => {
  document.body.classList.toggle("analysis", $("analysis").checked);
  $("side").hidden = !$("analysis").checked;
};
$("compare").onchange = updateCompareUI;
$("clip").onchange = () => selectClip($("clip").value);
$("play").onclick = playClip;
$("rec").onclick = toggleRecording;
$("simulate").onclick = simulatePA;
if (!navigator.mediaDevices || !window.MediaRecorder) {
  $("rec").disabled = true;
  $("recinfo").textContent = "Recording needs a browser with microphone access (http://127.0.0.1 or https).";
}
loadClips();
loadRoutes();
