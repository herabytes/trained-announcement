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
let lastRecording = null;  // the most recent mic recording (a Blob)

// ---------- Form fields shared by every transcription request ----------
function buildForm(audioBlob, filename) {
  const form = new FormData();
  form.append("journey", JSON.stringify({from: $("from").value, to: $("to").value, operator: $("operator").value}));
  form.append("denoise", $("denoise").checked);   // disabled in the UI for now (always false)
  form.append("context", $("context").checked);
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

// One message card: header with play button, the plain transcript, and a hidden .tech block.
function addCard(runId, who, cls = "") {
  const el = document.createElement("article");
  el.className = "msg " + cls;
  const when = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  el.innerHTML = `<div class="msg-head"><button class="playbtn" title="Play the audio this transcript came from">▶</button>
    <span class="who">${esc(who)}</span><span class="when">${when}</span></div>
    <div class="said"></div><div class="refbox"></div><div class="tech"></div>`;
  $("result").append(el);
  const card = {
    el,
    player: makePlayer(el.querySelector(".playbtn")),
    status(text) { el.querySelector(".said").innerHTML = `<div class="thinking">${esc(text)}</div>`; },
    error(msg) {
      el.classList.add("err");
      el.querySelector(".said").innerHTML = `<div class="lead">Sorry, that didn't work.</div><div class="hint">${esc(msg)}</div>`;
    },
    show(d, extra = {}) {
      el.querySelector(".said").innerHTML = d.text
        ? `<div class="lead">This is what was said:</div><div class="text">${esc(d.text)}</div>`
        : `<div class="lead">This is what was said:</div><div class="empty">Couldn't make out any speech.</div>`;
      el.querySelector(".refbox").innerHTML = refHtml(d.source && d.source.reference, d.reference_norm, d.text_norm);
      el.querySelector(".tech").innerHTML = techHtml(d, extra);
    },
    // POST the form to /api/transcribe and fill this card. Returns the response (or null).
    async transcribe(form, extra) {
      card.status("transcribing…");
      try {
        const r = await fetch("/api/transcribe", {method: "POST", body: form});
        const d = await r.json();
        if (runId !== current.id) return null;          // the user has moved on
        if (!r.ok) throw new Error(d.detail || r.status);
        card.show(d, extra);
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
    chip(`denoise ${d.denoise.applied ? "on" : "off"}`, d.denoise.applied),
    chip(`context hint ${d.context.applied ? "on" : "off"}`, d.context.applied),
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
  const option = c => {
    const name = (c.title || c.clip_id).replace(/\.(wav|mp3|flac)$/i, "");
    const start = +c.seg_start || 0, end = c.seg_end ? +c.seg_end : secs(c.duration);  // length the model hears
    return `<option value="${esc(c.clip_id)}">${esc(name)} (${mmss(end == null ? null : end - start)}) · ${esc(c.clip_id)}</option>`;
  };
  // Recommended clips first (in RECOMMENDED order, skipping any not downloaded), then everything else.
  const recommended = RECOMMENDED.filter(id => clips[id]).map(id => clips[id]);
  const rest = list.filter(c => !RECOMMENDED.includes(c.clip_id));
  $("clip").innerHTML = !list.length
    ? '<option value="">no announcements found: run python scripts/download_data.py</option>'
    : '<option value="">choose an announcement…</option>' +
      (recommended.length ? `<optgroup label="Recommended">${recommended.map(option).join("")}</optgroup>` : "") +
      `<optgroup label="All clips">${rest.map(option).join("")}</optgroup>`;
  renderFailures();
}

function selectClip(id) {
  $("clip").value = clips[id] ? id : "";
  $("play").disabled = !clips[id];
}

// Play: start the audio AND the transcription at the same time, like hearing it on the train.
function playClip() {
  const c = clips[$("clip").value];
  if (!c) return;
  const runId = newResultSet();
  const card = addCard(runId, "Announcement");
  // The API trims labelled clips to seg_start..seg_end; play exactly that part.
  card.player.setSource("/audio/" + c.audio_path, +c.seg_start || 0, c.seg_end ? +c.seg_end : null);
  card.player.play();
  const form = buildForm();
  form.append("clip_id", c.clip_id);
  card.transcribe(form);
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
  const card = addCard(runId, "Your voice");
  card.player.setSource(URL.createObjectURL(lastRecording));
  card.transcribe(buildForm(lastRecording, `mic.${extFor(lastRecording)}`));
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
  await voice.transcribe(buildForm(rec, `mic.${extFor(rec)}`));
  if (paBlob && runId === current.id) await pa.transcribe(buildForm(paBlob, "pa.wav"), {simulated: settings});
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
$("clip").onchange = () => selectClip($("clip").value);
$("play").onclick = playClip;
$("rec").onclick = toggleRecording;
$("simulate").onclick = simulatePA;
if (!navigator.mediaDevices || !window.MediaRecorder) {
  $("rec").disabled = true;
  $("recinfo").textContent = "Recording needs a browser with microphone access (http://127.0.0.1 or https).";
}
loadClips();
