// Live demo page: record or pick audio -> POST /api/transcribe -> show transcript + latency.
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

let clips = {};            // clip_id -> {title, reference, ...} from /api/demo/clips
let lastRecording = null;  // the most recent mic recording (a Blob)

// ---------- 1. Journey + options: collected into the form sent to the API ----------
function buildForm() {
  const form = new FormData();
  form.append("journey", JSON.stringify({from: $("from").value, to: $("to").value, operator: $("operator").value}));
  form.append("simulate", $("simulate").checked);
  form.append("snr_db", $("snr").value);
  form.append("pa_filter", $("pa").checked);
  form.append("denoise", $("denoise").checked);   // disabled in the UI for now (always false)
  form.append("context", $("context").checked);
  return form;
}

// ---------- 2a. Microphone (MediaRecorder) ----------
let recorder = null, recStart = 0, recTimer = null;

async function toggleRecording() {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  let stream;
  try {
    // Turn off the browser's own clean-up: echo cancellation would erase a clip played from this
    // computer's speakers, and noise suppression would be a hidden denoiser.
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
    stream.getTracks().forEach(t => t.stop());          // release the mic (browser icon goes away)
    clearInterval(recTimer);
    $("rec").classList.remove("on");
    $("rec").textContent = "● Record";
    lastRecording = new Blob(chunks, {type: recorder.mimeType});
    $("recaudio").src = URL.createObjectURL(lastRecording);
    $("recaudio").hidden = false;
    $("recsend").hidden = false;
    $("recinfo").textContent = `${((Date.now() - recStart) / 1000).toFixed(1)} s recorded`;
    sendRecording();                                    // turn-taking: stop speaking -> transcribe
  };
  recorder.start();
  recStart = Date.now();
  $("rec").classList.add("on");
  $("rec").textContent = "■ Stop and transcribe";
  recTimer = setInterval(() => $("recinfo").textContent = `recording… ${((Date.now() - recStart) / 1000).toFixed(0)} s`, 250);
}

function sendRecording() {
  if (!lastRecording) return;
  const ext = (lastRecording.type.match(/audio\/(\w+)/) || [, "webm"])[1];
  const form = buildForm();
  form.append("audio", lastRecording, `mic.${ext}`);
  transcribe(form, "Microphone");
}

// ---------- 2b. Dataset clip ----------
async function loadClips() {
  const list = await (await fetch("/api/demo/clips")).json();
  clips = Object.fromEntries(list.map(c => [c.clip_id, c]));
  const option = c => `<option value="${esc(c.clip_id)}">${esc(c.clip_id)} · ${esc(c.title || "")} (${esc(c.duration || "?")})</option>`;
  // Recommended clips first (in RECOMMENDED order, skipping any not downloaded), then everything else.
  const recommended = RECOMMENDED.filter(id => clips[id]).map(id => clips[id]);
  const rest = list.filter(c => !RECOMMENDED.includes(c.clip_id));
  $("clip").innerHTML = !list.length
    ? '<option value="">no clips found: run python scripts/download_data.py</option>'
    : '<option value="">pick a clip…</option>' +
      (recommended.length ? `<optgroup label="Recommended">${recommended.map(option).join("")}</optgroup>` : "") +
      `<optgroup label="All clips">${rest.map(option).join("")}</optgroup>`;
  renderFailures();
}

function selectClip(id) {
  $("clip").value = id;
  const c = clips[id];
  $("clipsend").disabled = !c;
  $("clipaudio").src = c ? "/audio/" + c.audio_path : "";
  $("clipinfo").innerHTML = !c ? "" :
    [c.kind && `kind: ${esc(c.kind.replace("_", " "))}`,
     (c.seg_start || c.seg_end) && `model hears only the labelled segment ${esc(c.seg_start || 0)}–${esc(c.seg_end || "end")} s`,
     c.reference ? `reference: “${esc(c.reference)}”` : "no human reference yet"].filter(Boolean).join("<br>");
}

function sendClip() {
  const id = $("clip").value;
  if (!id) return;
  const form = buildForm();
  form.append("clip_id", id);
  transcribe(form, id);
}

// ---------- 3. Call the API and show the result ----------
// One "current result" box (#result): each new transcription replaces what was there,
// and the "thinking…" state is shown in that same box while it runs.
let busy = false;

async function transcribe(form, label) {
  if (busy) return;
  busy = true;
  const started = Date.now();
  const thinking = () => $("result").innerHTML = `<div class="result"><div class="muted">${esc(label)}</div>
    <div class="text thinking">thinking… ${((Date.now() - started) / 1000).toFixed(1)} s</div></div>`;
  thinking();
  const tick = setInterval(thinking, 100);
  try {
    const r = await fetch("/api/transcribe", {method: "POST", body: form});
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || r.status);
    clearInterval(tick);
    showResult(label, data);
  } catch (e) {
    clearInterval(tick);
    $("result").innerHTML = `<div class="result err"><b>${esc(label)}</b>: ${esc(e.message)}</div>`;
  } finally {
    busy = false;
  }
}

function showResult(label, d) {
  const ref = d.source && d.source.reference;
  const sim = d.simulate ? `simulated train: ${d.simulate.snr_db} dB SNR${d.simulate.pa_filter ? " + PA filter" : ""}` : "";
  const heard = d.heard_wav_b64 ? `<div class="muted">what the model heard:</div><audio controls src="data:audio/wav;base64,${d.heard_wav_b64}"></audio>` : "";
  $("result").innerHTML = `
    <div class="result">
      <div class="muted">${esc(label)}${sim ? " · " + esc(sim) : ""}</div>
      <div class="text">${d.text ? esc(d.text) : '<span class="empty">(nothing: the model heard no speech)</span>'}</div>
      ${ref ? `<div class="ref muted">human reference: “${esc(ref)}”</div>` : ""}
      <div class="stats">
        <span>latency <b>${d.latency_s.toFixed(2)} s</b></span>
        <span>audio ${d.audio_s.toFixed(1)} s</span>
        <span>request total ${d.total_s.toFixed(2)} s${d.model_load_s > 0.05 ? ` (incl. ${d.model_load_s.toFixed(1)} s first-time model load)` : ""}</span>
        <span>${esc(d.model)}</span>
      </div>
      ${heard}
    </div>`;
}

// ---------- Evidence panel ----------
function renderFailures() {
  const link = id => clips[id]
    ? `<a data-clip="${esc(id)}">${esc(id)}</a>`
    : `<span class="missing" title="audio not downloaded">${esc(id)}</span>`;
  $("failures").innerHTML = "<thead><tr><th>Failure<th>Clips<th>What happened</tr></thead><tbody>" +
    FAILURES.map(([f, ids, what]) => `<tr><td>${esc(f)}<td>${ids.map(link).join(", ")}<td>${esc(what)}</tr>`).join("") + "</tbody>";
}

$("failures").onclick = e => {
  const id = e.target.dataset && e.target.dataset.clip;
  if (!id) return;
  selectClip(id);
  $("clip").scrollIntoView({behavior: "smooth", block: "center"});
};
$("rec").onclick = toggleRecording;
$("recsend").onclick = sendRecording;
$("clip").onchange = () => selectClip($("clip").value);
$("clipsend").onclick = sendClip;
if (!navigator.mediaDevices || !window.MediaRecorder) {
  $("rec").disabled = true;
  $("recinfo").textContent = "This browser can't record audio here (needs http://127.0.0.1 or https).";
}
loadClips();
