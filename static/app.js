const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  ws: null,
};

/** @type {MediaStream | null} */
let cameraStream = null;
/** @type {ReturnType<typeof setInterval> | null} */
let cameraInterval = null;
/** @type {BarcodeDetector | null} */
let barcodeDetector = null;
const cameraSubmitAt = new Map();
let cameraFrameBusy = false;

let suppressWsToastUntil = 0;

function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  el.className = "toast " + (kind === "error" ? "error" : "ok");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function tickClock() {
  $("clock").textContent = new Date().toLocaleString();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!res.ok) {
    const msg = data?.detail;
    const err = typeof msg === "string" ? msg : Array.isArray(msg) ? msg.map((m) => m.msg).join(", ") : res.statusText;
    throw new Error(err || "Request failed");
  }
  return data;
}

function renderDashboard(d) {
  const pct = d.total_students ? Math.round((d.present_count / d.total_students) * 100) : 0;
  $("session-stats").innerHTML = `
    <strong>${escapeHtml(d.session.title)}</strong><br />
    Present: <strong>${d.present_count}</strong> / ${d.total_students} students (${pct}%)
  `;
  $("present-badge").textContent = String(d.present_count);
  const feed = $("feed");
  feed.innerHTML = "";
  for (const r of d.recent) {
    const div = document.createElement("div");
    div.className = "feed-item";
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(r.full_name)}</strong>
        <div class="sub">${escapeHtml(r.student_code)} · ${escapeHtml(r.status)}</div>
      </div>
      <div class="sub">${fmtTime(r.checked_in_at)}</div>
    `;
    feed.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadSessions(selectId = null) {
  const sessions = await api("/api/sessions");
  const sel = $("session-select");
  sel.innerHTML = "";
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = String(s.id);
    opt.textContent = s.title + (s.active ? "" : " (inactive)");
    sel.appendChild(opt);
  }
  if (sessions.length === 0) return;
  const pick = selectId != null ? String(selectId) : String(sessions[0].id);
  sel.value = pick;
  state.sessionId = Number(pick);
  await refreshDashboard();
}

async function refreshDashboard() {
  if (!state.sessionId) return;
  const d = await api(`/api/dashboard/${state.sessionId}`);
  renderDashboard(d);
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const pill = $("conn-pill");
  ws.onopen = () => {
    pill.textContent = "Real-time: live";
    pill.classList.remove("pill-off");
    pill.classList.add("pill-on");
  };
  ws.onclose = () => {
    pill.textContent = "Real-time: reconnecting…";
    pill.classList.add("pill-off");
    pill.classList.remove("pill-on");
    setTimeout(connectWs, 1200);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "check_in" && msg.dashboard?.session?.id === state.sessionId) {
      renderDashboard(msg.dashboard);
      const a = msg.attendance;
      if (Date.now() > suppressWsToastUntil) {
        toast(`${a.full_name} checked in`, "ok");
      }
    }
    if (msg.type === "sessions_changed") {
      loadSessions(state.sessionId).catch(() => {});
    }
    if (msg.type === "students_changed") {
      refreshDashboard().catch(() => {});
    }
  };
  state.ws = ws;
}

$("session-select").addEventListener("change", async (e) => {
  state.sessionId = Number(e.target.value);
  await refreshDashboard();
});

$("new-session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("new-session-title").value.trim();
  if (!title) return;
  try {
    const s = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title, description: null }),
    });
    $("new-session-title").value = "";
    await loadSessions(s.id);
    toast("Session created", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const student_code = $("student-code").value.trim();
  if (!student_code || !state.sessionId) return;
  try {
    suppressWsToastUntil = Date.now() + 900;
    const data = await api("/api/check-in", {
      method: "POST",
      body: JSON.stringify({ student_code, session_id: state.sessionId }),
    });
    $("student-code").value = "";
    await refreshDashboard();
    toast(`${data.full_name} checked in`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("student-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const student_code = $("st-code").value.trim();
  const full_name = $("st-name").value.trim();
  const email = $("st-email").value.trim() || null;
  try {
    await api("/api/students", {
      method: "POST",
      body: JSON.stringify({ student_code, full_name, email }),
    });
    $("st-code").value = "";
    $("st-name").value = "";
    $("st-email").value = "";
    toast("Student added", "ok");
    await refreshDashboard();
  } catch (err) {
    toast(err.message, "error");
  }
});

function setCameraStatus(msg) {
  $("camera-status").textContent = msg;
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
function parseStudentCodeFromScan(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed);
      const c = o.student_code ?? o.studentCode ?? o.code;
      if (typeof c === "string" && c.trim()) return c.trim();
    } catch {
      /* not JSON */
    }
  }
  const line = trimmed.split(/\r?\n/)[0].trim();
  if (/^[A-Za-z0-9_-]+$/.test(line) && line.length <= 64) return line;
  try {
    const u = new URL(trimmed);
    const q = u.searchParams.get("code") || u.searchParams.get("student_code");
    if (q && /^[A-Za-z0-9_-]+$/.test(q) && q.length <= 64) return q;
  } catch {
    /* not a URL */
  }
  return null;
}

async function tryCheckInFromCamera(code) {
  if (!state.sessionId) {
    toast("Select a session first", "error");
    return;
  }
  const now = Date.now();
  const prev = cameraSubmitAt.get(code);
  if (prev && now - prev < 2200) return;
  cameraSubmitAt.set(code, now);
  try {
    suppressWsToastUntil = Date.now() + 900;
    const data = await api("/api/check-in", {
      method: "POST",
      body: JSON.stringify({ student_code: code, session_id: state.sessionId }),
    });
    await refreshDashboard();
    toast(`${data.full_name} checked in (camera)`, "ok");
    setCameraStatus(`Recognized ${code} — checked in`);
  } catch (err) {
    toast(err.message, "error");
    setCameraStatus(err.message);
  }
}

async function sampleCameraFrame() {
  if (cameraFrameBusy || !cameraStream) return;
  cameraFrameBusy = true;
  try {
    const v = $("camera-video");
    if (!v.srcObject || v.readyState < 2 || v.videoWidth < 8) return;

    /** @type {string | null} */
    let extracted = null;

    if (barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(v);
        for (const c of codes) {
          extracted = parseStudentCodeFromScan(c.rawValue);
          if (extracted) break;
        }
      } catch {
        /* ignore frame errors */
      }
    }

    if (!extracted && typeof jsQR === "function") {
      const canvas = $("camera-canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const w = v.videoWidth;
      const h = v.videoHeight;
      const maxW = 640;
      const scale = w > maxW ? maxW / w : 1;
      const tw = Math.floor(w * scale);
      const th = Math.floor(h * scale);
      canvas.width = tw;
      canvas.height = th;
      ctx.drawImage(v, 0, 0, tw, th);
      try {
        const img = ctx.getImageData(0, 0, tw, th);
        const r = jsQR(img.data, tw, th, { inversionAttempts: "attemptBoth" });
        if (r?.data) extracted = parseStudentCodeFromScan(r.data);
      } catch {
        /* ignore */
      }
    }

    if (!extracted) return;
    await tryCheckInFromCamera(extracted);
  } finally {
    cameraFrameBusy = false;
  }
}

function cameraLoop() {
  void sampleCameraFrame();
}

async function startCamera() {
  if (cameraStream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("This browser does not support camera access", "error");
    setCameraStatus("Camera not supported");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    const v = $("camera-video");
    v.srcObject = cameraStream;
    await v.play();
    $("camera-start").disabled = true;
    $("camera-stop").disabled = false;
    barcodeDetector = null;
    if ("BarcodeDetector" in window) {
      try {
        barcodeDetector = new BarcodeDetector({
          formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "itf"],
        });
      } catch {
        barcodeDetector = null;
      }
    }
    setCameraStatus(barcodeDetector ? "Scanning (native + QR)…" : "Scanning (QR)…");
    cameraInterval = setInterval(cameraLoop, 400);
  } catch (err) {
    cameraStream = null;
    toast(err.message || "Camera permission denied", "error");
    setCameraStatus("Could not start camera");
  }
}

function stopCamera() {
  if (cameraInterval != null) {
    clearInterval(cameraInterval);
    cameraInterval = null;
  }
  barcodeDetector = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  const v = $("camera-video");
  v.srcObject = null;
  $("camera-start").disabled = false;
  $("camera-stop").disabled = true;
  setCameraStatus("Camera off");
}

$("camera-start").addEventListener("click", () => startCamera());
$("camera-stop").addEventListener("click", () => stopCamera());

(async function init() {
  setInterval(tickClock, 1000);
  tickClock();
  try {
    await loadSessions();
    connectWs();
  } catch (err) {
    toast("Cannot reach API. Run: python run.py", "error");
    $("conn-pill").textContent = "API offline";
  }
})();
