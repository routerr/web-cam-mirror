/* eslint-disable no-console */

const app = document.querySelector("#app");

const state = {
  flavor: "espresso", // mocha | espresso | iced_latte | frappe
  stream: null,
  recorder: null,
  recordStartTs: 0,
  recordTimer: null,
  chunks: [],
  recordingMime: "",
  recordedBlob: null,
  recordedUrl: "",
  exports: new Map(), // key -> { blob, url }
};

const exportPresets = [
  { key: "orig", label: "原始版本", w: null, h: null, fps: null },
  { key: "1080p30", label: "1080p / 30 FPS", w: 1920, h: 1080, fps: 30 },
  { key: "720p30", label: "720p / 30 FPS", w: 1280, h: 720, fps: 30 },
  { key: "720p60", label: "720p / 60 FPS", w: 1280, h: 720, fps: 60 },
  { key: "480p30", label: "480p / 30 FPS", w: 854, h: 480, fps: 30 },
];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "style") {
      if (typeof v === "string") el.setAttribute("style", v);
      else if (v && typeof v === "object") Object.assign(el.style, v);
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === false || v === null || v === undefined) continue;
    else el.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}

function supportedMimeCandidates() {
  const list = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4", // Some browsers allow, many don't with MediaRecorder.
  ];
  if (!window.MediaRecorder) return [];
  return list.filter((m) => MediaRecorder.isTypeSupported(m));
}

function stopTracks(stream) {
  try {
    for (const t of stream.getTracks()) t.stop();
  } catch {
    // ignore
  }
}

function revokeUrl(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

function clearRecordingState() {
  state.chunks = [];
  state.recordingMime = "";
  state.recordStartTs = 0;
  state.recordedBlob = null;
  revokeUrl(state.recordedUrl);
  state.recordedUrl = "";

  for (const { url } of state.exports.values()) revokeUrl(url);
  state.exports.clear();

  const playback = document.querySelector("#playbackVideo");
  if (playback) {
    try {
      playback.pause?.();
      playback.removeAttribute("src");
      playback.load?.();
    } catch {
      // ignore
    }
  }

  renderPlaybackPanelVisibility();
  renderExports();
  renderStatus();
}

function renderPlaybackPanelVisibility() {
  const card = document.querySelector("#playbackCard");
  if (!card) return;
  card.style.display = state.recordedBlob ? "" : "none";
}

function applyExpectedPreviewAspectRatio() {
  // If the user specifies width/height, treat that as the intended output frame.
  // Otherwise default to 16:9 (matches the built-in export presets).
  const outW = Number(document.querySelector("#width")?.value || 0) || 0;
  const outH = Number(document.querySelector("#height")?.value || 0) || 0;

  let ar = "16 / 9";
  if (outW > 0 && outH > 0) ar = `${outW} / ${outH}`;

  document.documentElement.style.setProperty("--preview-ar", ar);
  document.documentElement.style.setProperty("--preview-fit", "contain");
}

async function enumerateDevicesSafe() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return navigator.mediaDevices.enumerateDevices();
}

function currentConstraintsFromUI() {
  const cameraId = document.querySelector("#cameraId")?.value || "";
  const micId = document.querySelector("#micId")?.value || "";
  const w = Number(document.querySelector("#width")?.value || 0) || null;
  const hgt = Number(document.querySelector("#height")?.value || 0) || null;
  const fps = Number(document.querySelector("#fps")?.value || 0) || null;

  const video = {
    deviceId: cameraId ? { exact: cameraId } : undefined,
    width: w ? { ideal: w } : undefined,
    height: hgt ? { ideal: hgt } : undefined,
    frameRate: fps ? { ideal: fps } : undefined,
  };

  const audio = {
    deviceId: micId ? { exact: micId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  return { video, audio };
}

async function startPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("此瀏覽器不支援 navigator.mediaDevices.getUserMedia。");
    return;
  }
  if (state.stream) stopPreview();

  const constraints = currentConstraintsFromUI();
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.stream = stream;

  const live = document.querySelector("#liveVideo");
  if (live) live.srcObject = stream;

  applyExpectedPreviewAspectRatio();
  await refreshDevicesAfterPermission();
  renderStatus();
}

function togglePreview() {
  if (state.stream) stopPreview();
  else startPreview();
}

function stopPreview() {
  if (!state.stream) return;
  // If the live video is currently in native Picture-in-Picture, close it too.
  // Do not await: this function is used by startPreview() as a fast sync cleanup.
  try {
    if (document.pictureInPictureElement) document.exitPictureInPicture?.().catch(() => {});
  } catch {
    // ignore
  }
  stopTracks(state.stream);
  state.stream = null;
  const live = document.querySelector("#liveVideo");
  if (live) live.srcObject = null;
  renderStatus();
}

async function refreshDevicesAfterPermission() {
  const devices = await enumerateDevicesSafe();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");

  const camSel = document.querySelector("#cameraId");
  const micSel = document.querySelector("#micId");
  if (!camSel || !micSel) return;

  const camPrev = camSel.value;
  const micPrev = micSel.value;

  camSel.textContent = "";
  micSel.textContent = "";

  camSel.append(h("option", { value: "" }, "預設相機"));
  for (const c of cams) camSel.append(h("option", { value: c.deviceId }, c.label || `Camera ${c.deviceId.slice(0, 6)}`));

  micSel.append(h("option", { value: "" }, "預設麥克風"));
  for (const m of mics) micSel.append(h("option", { value: m.deviceId }, m.label || `Mic ${m.deviceId.slice(0, 6)}`));

  if ([...camSel.options].some((o) => o.value === camPrev)) camSel.value = camPrev;
  if ([...micSel.options].some((o) => o.value === micPrev)) micSel.value = micPrev;
}

async function startRecording() {
  if (!state.stream) {
    alert("請先啟動預覽（允許相機與麥克風）");
    return;
  }
  if (!window.MediaRecorder) {
    alert("此瀏覽器不支援 MediaRecorder。");
    return;
  }

  clearRecordingState();

  const mimeSel = document.querySelector("#mimeType");
  const preferMime = mimeSel?.value || "";

  let opts = {};
  if (preferMime) opts.mimeType = preferMime;
  const rec = new MediaRecorder(state.stream, opts);
  state.recorder = rec;
  state.recordingMime = rec.mimeType || preferMime || "";

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.chunks.push(e.data);
  };
  rec.onerror = (e) => {
    console.error(e);
    alert("錄製發生錯誤，請查看 console。");
  };
  rec.onstop = () => {
    const blob = new Blob(state.chunks, { type: state.recordingMime || "video/webm" });
    state.recordedBlob = blob;
    state.recordedUrl = URL.createObjectURL(blob);

    const playback = document.querySelector("#playbackVideo");
    if (playback) playback.src = state.recordedUrl;
    renderPlaybackPanelVisibility();
    renderExports();
    renderStatus();
  };

  state.recordStartTs = Date.now();
  rec.start(250); // collect chunks periodically to keep memory usage smoother
  state.recordTimer = setInterval(renderStatus, 250);
  renderStatus();
}

function stopRecording() {
  if (!state.recorder) return;
  try {
    state.recorder.stop();
  } catch {
    // ignore
  }
  state.recorder = null;
  if (state.recordTimer) clearInterval(state.recordTimer);
  state.recordTimer = null;
  renderStatus();
}

function toggleRecording() {
  if (state.recorder) {
    stopRecording();
    return;
  }
  startRecording().catch((e) => {
    console.error(e);
    alert("啟動錄製失敗，請查看 console。");
    renderStatus();
  });
}

function deleteRecording() {
  if (state.recorder) {
    alert("錄製中無法刪除，請先停止錄製。");
    return;
  }
  if (!state.recordedBlob) return;
  if (!confirm("刪除目前的錄製與所有輸出版本？")) return;
  clearRecordingState();
}

async function togglePiP() {
  const live = document.querySelector("#liveVideo");
  if (!live) return;

  if (!document.pictureInPictureEnabled) {
    alert("此瀏覽器不支援 Picture-in-Picture。");
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await live.requestPictureInPicture();
    }
  } catch (e) {
    console.error(e);
    alert("PiP 操作失敗（可能需要先播放或有瀏覽器限制）。");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => revokeUrl(url), 2500);
}

function bestPlaybackElement() {
  return document.querySelector("#playbackVideo");
}

function drawContain(ctx, srcVideo, targetW, targetH) {
  // Preserve aspect ratio; letterbox with black bars when needed.
  const sw = srcVideo.videoWidth || targetW;
  const sh = srcVideo.videoHeight || targetH;
  if (!sw || !sh) return;

  const scale = Math.min(targetW / sw, targetH / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const dx = Math.round((targetW - dw) / 2);
  const dy = Math.round((targetH - dh) / 2);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(srcVideo, dx, dy, dw, dh);
}

async function transcodeViaCanvas({ w, h, fps, onProgress }) {
  const srcVideo = bestPlaybackElement();
  if (!srcVideo || !state.recordedUrl) throw new Error("no-source");

  // Ensure metadata is loaded.
  if (!Number.isFinite(srcVideo.duration) || srcVideo.duration === 0) {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("metadata-timeout")), 6000);
      srcVideo.onloadedmetadata = () => {
        clearTimeout(to);
        res();
      };
      srcVideo.onerror = () => {
        clearTimeout(to);
        rej(new Error("video-error"));
      };
      // Force reload in case src was just set.
      srcVideo.load?.();
    });
  }

  const targetW = w || srcVideo.videoWidth || 1280;
  const targetH = h || srcVideo.videoHeight || 720;
  const targetFps = fps || 30;

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("no-canvas");

  // Prefer taking audio from captureStream() to avoid WebAudio MediaElementSource limitations.
  // Fallback: WebAudio graph fed by a dedicated audio element (new element per export).
  let audioTrack = null;
  let audioTrackOwned = false;
  let audioCleanup = () => {};
  if (typeof srcVideo.captureStream === "function") {
    try {
      const s = srcVideo.captureStream();
      audioTrack = s?.getAudioTracks?.()?.[0] || null;
    } catch {
      audioTrack = null;
    }
  }
  if (!audioTrack) {
    try {
      const audioEl = document.createElement("audio");
      audioEl.src = state.recordedUrl;
      audioEl.preload = "auto";
      audioEl.muted = false;
      audioEl.volume = 0;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      const mediaSource = audioCtx.createMediaElementSource(audioEl);
      const gain = audioCtx.createGain();
      gain.gain.value = 0.0;
      mediaSource.connect(dest);
      mediaSource.connect(gain);
      gain.connect(audioCtx.destination);
      audioTrack = dest.stream.getAudioTracks()[0] || null;
      audioTrackOwned = true;

      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch {
          // ignore
        }
      }

      audioCleanup = async () => {
        try {
          audioEl.pause();
        } catch {
          // ignore
        }
        try {
          mediaSource.disconnect();
        } catch {
          // ignore
        }
        try {
          dest.disconnect();
        } catch {
          // ignore
        }
        try {
          await audioCtx.close();
        } catch {
          // ignore
        }
        try {
          if (srcVideo.__exportAudioEl === audioEl) srcVideo.__exportAudioEl = null;
        } catch {
          // ignore
        }
      };

      // Drive audio playback during export.
      srcVideo.__exportAudioEl = audioEl;
    } catch (e) {
      console.warn("Audio capture graph failed; export will be silent in some browsers.", e);
      audioTrack = null;
    }
  }

  const canvasStream = canvas.captureStream(targetFps);
  const outTracks = [...canvasStream.getVideoTracks()];
  if (audioTrack) outTracks.push(audioTrack);
  const mixedStream = new MediaStream(outTracks);

  const mimeCandidates = supportedMimeCandidates();
  const mimeType = mimeCandidates[0] || "video/webm";
  const recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopPromise = new Promise((res) => {
    recorder.onstop = res;
  });

  // Prepare playback
  const prevTime = srcVideo.currentTime;
  const prevMuted = srcVideo.muted;
  const prevVol = srcVideo.volume;

  srcVideo.pause();
  srcVideo.currentTime = 0;
  srcVideo.muted = false;
  srcVideo.volume = 0; // keep silent but allow audio graph to pull samples

  let rafId = 0;
  let done = false;

  const drawRaf = () => {
    if (done) return;
    try {
      drawContain(ctx, srcVideo, targetW, targetH);
      const p = srcVideo.duration ? Math.min(1, srcVideo.currentTime / srcVideo.duration) : 0;
      onProgress?.(p);
    } catch {
      // ignore draw errors (can happen during seek)
    }
    rafId = requestAnimationFrame(drawRaf);
  };

  const end = async () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(rafId);
    try {
      recorder.stop();
    } catch {
      // ignore
    }
    await stopPromise;
    stopTracks(canvasStream);
    // Only stop tracks we "own". Stopping a captureStream() audio track can break future exports in some browsers.
    if (audioTrackOwned && audioTrack) {
      try {
        audioTrack.stop();
      } catch {
        // ignore
      }
    }
    await audioCleanup();
    srcVideo.pause();
    srcVideo.currentTime = prevTime;
    srcVideo.muted = prevMuted;
    srcVideo.volume = prevVol;
  };

  srcVideo.onended = () => {
    end();
  };

  recorder.start(250);
  // If we created a dedicated audio element for export, play it in lockstep.
  const audioEl = srcVideo.__exportAudioEl || null;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch {
      // ignore
    }
  }

  // Safety timeout: if 'ended' never fires, stop after duration + buffer.
  const maxMs = Math.max(1500, Math.ceil((srcVideo.duration || 0) * 1000) + 4000);
  const kill = setTimeout(() => end(), maxMs);

  try {
    await srcVideo.play(); // requires user gesture; export is invoked by button click.
  } finally {
    // best-effort: start audio after video starts
    if (audioEl) {
      try {
        await audioEl.play();
      } catch {
        // ignore
      }
    }
  }

  if (typeof srcVideo.requestVideoFrameCallback === "function") {
    const onFrame = () => {
      if (done) return;
      try {
        drawContain(ctx, srcVideo, targetW, targetH);
        const p = srcVideo.duration ? Math.min(1, srcVideo.currentTime / srcVideo.duration) : 0;
        onProgress?.(p);
      } catch {
        // ignore
      }
      srcVideo.requestVideoFrameCallback(onFrame);
    };
    srcVideo.requestVideoFrameCallback(onFrame);
  } else {
    drawRaf();
  }

  await stopPromise;
  clearTimeout(kill);

  const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
  return { blob, mimeType: blob.type };
}

async function generateExport(preset) {
  if (!state.recordedBlob) {
    alert("目前沒有可輸出的錄影。");
    return;
  }

  if (preset.key === "orig") {
    downloadBlob(state.recordedBlob, `recording-original.${extFromMime(state.recordingMime)}`);
    return;
  }

  const row = document.querySelector(`[data-export-key="${preset.key}"]`);
  const bar = row?.querySelector(".progress > div");
  const btn = row?.querySelector("button");
  const info = row?.querySelector(".info");
  if (btn) btn.disabled = true;
  if (info) info.textContent = "轉檔中（在記憶體內進行）...";

  try {
    const { blob, mimeType } = await transcodeViaCanvas({
      w: preset.w,
      h: preset.h,
      fps: preset.fps,
      onProgress: (p) => {
        if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      },
    });

    const url = URL.createObjectURL(blob);
    const prev = state.exports.get(preset.key);
    if (prev?.url) revokeUrl(prev.url);
    state.exports.set(preset.key, { blob, url, mimeType });

    if (bar) bar.style.width = "100%";
    if (info) info.textContent = `完成：${prettyBytes(blob.size)} / ${mimeType || "video/webm"}`;
    renderExports();
  } catch (e) {
    console.error(e);
    if (info) info.textContent = "轉檔失敗（可能是瀏覽器限制或影片太大）。";
    if (bar) bar.style.width = "0%";
  } finally {
    if (btn) btn.disabled = false;
  }
}

function extFromMime(mime) {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "bin";
}

function prettyBytes(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function renderStatus() {
  const recTag = document.querySelector("#recTag");
  const liveTag = document.querySelector("#liveTag");
  const recDot = document.querySelector("#recDot");
  const recTime = document.querySelector("#recTime");

  if (liveTag) {
    liveTag.textContent = state.stream ? "Live: ON" : "Live: OFF";
  }
  if (recTag) {
    recTag.textContent = state.recorder ? "REC" : "IDLE";
  }
  if (recDot) {
    recDot.className = `dot ${state.recorder ? "rec" : ""}`;
  }
  if (recTime) {
    recTime.textContent = state.recorder ? fmtMs(Date.now() - state.recordStartTs) : "00:00";
  }

  const recToggle = document.querySelector("#recToggle");
  const previewToggle = document.querySelector("#previewToggle");
  const pipBtn = document.querySelector("#pipBtn");
  const delBtn = document.querySelector("#deleteRec");
  const fsBtn = document.querySelector("#fullscreenPlayback");

  if (recToggle) {
    const recording = !!state.recorder;
    recToggle.textContent = recording ? "停止" : "開始錄製";
    recToggle.className = recording ? "btn" : "btn danger";
    // When recording, allow stopping even if stream is in a weird state.
    recToggle.disabled = recording ? false : !state.stream;
  }
  if (previewToggle) {
    const on = !!state.stream;
    previewToggle.textContent = on ? "關閉預覽" : "啟動預覽（要權限）";
    previewToggle.className = on ? "btn" : "btn primary";
    previewToggle.disabled = on && !!state.recorder;
  }
  if (pipBtn) pipBtn.disabled = !state.stream;
  if (delBtn) delBtn.disabled = !state.recordedBlob || !!state.recorder;
  if (fsBtn) fsBtn.disabled = !state.recordedUrl;
}

function renderMimeOptions() {
  const sel = document.querySelector("#mimeType");
  if (!sel) return;
  const candidates = supportedMimeCandidates();
  sel.textContent = "";
  if (!window.MediaRecorder) {
    sel.append(h("option", { value: "" }, "（MediaRecorder 不可用）"));
    return;
  }
  if (candidates.length === 0) {
    sel.append(h("option", { value: "" }, "（找不到可用格式，將使用瀏覽器預設）"));
    return;
  }
  for (const m of candidates) sel.append(h("option", { value: m }, m));
}

function renderExports() {
  const box = document.querySelector("#exports");
  if (!box) return;
  box.textContent = "";

  if (!state.recordedBlob) {
    box.append(h("div", { class: "hint" }, "錄影結束後，這裡會出現不同解析度 / FPS 的輸出選項。"));
    return;
  }

  const meta = h(
    "div",
    { class: "okBox" },
    h("div", {}, "已錄製完成（仍在記憶體中，未上傳、未寫入檔案系統）。"),
    h(
      "div",
      { class: "hint" },
      `原始大小：`,
      h("span", { class: "mono" }, prettyBytes(state.recordedBlob.size)),
      state.recordingMime ? ` / ${state.recordingMime}` : ""
    )
  );
  box.append(meta);

  const list = h("div", { class: "list" });

  for (const preset of exportPresets) {
    const exp = state.exports.get(preset.key);
    const infoText =
      preset.key === "orig"
        ? "不轉檔，直接下載原始錄製。"
        : exp?.blob
          ? `已生成：${prettyBytes(exp.blob.size)} / ${exp.mimeType || "video/webm"}`
          : "將用 Canvas + MediaRecorder 重新錄一份（可調解析度 / FPS）。";

    const downloadBtn =
      exp?.blob && preset.key !== "orig"
        ? h(
            "button",
            {
              class: "btn primary",
              onclick: () => downloadBlob(exp.blob, `recording-${preset.key}.${extFromMime(exp.mimeType)}`),
            },
            "下載"
          )
        : null;

    const row = h(
      "div",
      { class: "exportItem", "data-export-key": preset.key },
      h(
        "div",
        { class: "title" },
        h("strong", {}, preset.label),
        h("span", { class: "info" }, infoText)
      ),
      h("div", { class: "progress" }, h("div", {})),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "btn", onclick: () => generateExport(preset) },
          preset.key === "orig" ? "下載原始" : exp?.blob ? "重新生成" : "生成"
        ),
        downloadBtn
      )
    );

    list.append(row);
  }

  box.append(list);
}

function render() {
  const hasGum = !!navigator.mediaDevices?.getUserMedia;
  const hasMR = !!window.MediaRecorder;

  document.documentElement.dataset.flavor = state.flavor;

  app.textContent = "";

  app.append(
    h(
      "div",
      { class: "wrap" },
      h(
        "div",
        { class: "topbar" },
        h(
          "div",
          { class: "brand" },
          h("h1", {}, "Browser 錄影錄音（In-Memory）"),
          h(
            "p",
            {},
            "全程在瀏覽器內：讀取相機與麥克風、即時預覽 + 浮動畫中畫、錄製/停止，並在錄製後用記憶體轉出不同解析度/FPS 版本下載。"
          )
        ),
        h(
          "div",
          { class: "theme" },
          h(
            "div",
            { class: "pill" },
            h("label", {}, "Theme"),
            h(
              "select",
              {
                onchange: (e) => {
                  state.flavor = e.target.value;
                  document.documentElement.dataset.flavor = state.flavor;
                },
              },
              h("option", { value: "iced_latte", selected: state.flavor === "iced_latte" }, "Iced Latte"),
              h("option", { value: "frappe", selected: state.flavor === "frappe" }, "Frappé"),
              h("option", { value: "mocha", selected: state.flavor === "mocha" }, "Mocha"),
              h("option", { value: "espresso", selected: state.flavor === "espresso" }, "Espresso")
            )
          )
        )
      ),
      h(
        "div",
        { class: "grid" },
        h(
          "div",
          { class: "card" },
          h(
            "header",
            {},
            h("h2", {}, "Preview"),
            h("div", { class: "meta" }, h("span", { class: "tag" }, h("span", { id: "liveTag" }, "Live: OFF")))
          ),
          h(
            "div",
            { class: "body" },
            !hasGum
              ? h("div", { class: "warnBox" }, "此瀏覽器不支援 getUserMedia，無法使用相機/麥克風。")
              : null,
            !hasMR
              ? h(
                  "div",
                  { class: "warnBox" },
                  "此瀏覽器不支援 MediaRecorder（常見於部分 Safari / iOS 版本）。你仍可預覽，但無法錄製。"
                )
              : null,
            h(
              "div",
              { class: "videoStage" },
              h("video", { id: "liveVideo", playsinline: "true", autoplay: "true", muted: "true" })
            ),
            h(
              "div",
              { class: "row", style: { marginTop: "12px" } },
              h(
                "button",
                {
                  id: "previewToggle",
                  class: state.stream ? "btn" : "btn primary",
                  onclick: togglePreview,
                },
                state.stream ? "關閉預覽" : "啟動預覽（要權限）"
              ),
              h(
                "button",
                { id: "pipBtn", class: "btn", onclick: togglePiP, title: "使用瀏覽器 Picture-in-Picture 浮動視窗" },
                "PiP 浮動視窗"
              ),
              h("span", { class: "tag" }, h("span", { id: "recDot", class: "dot" }), h("span", { id: "recTag" }, "IDLE")),
              h("span", { class: "tag mono" }, h("span", { id: "recTime" }, "00:00"))
            ),
            h(
              "div",
              { class: "hint", style: { marginTop: "10px" } },
              "提示：相機/麥克風需在安全環境（https 或 localhost）。浮動視窗需瀏覽器支援 Picture-in-Picture。"
            )
          )
        ),
        h(
          "div",
          { class: "card" },
          h("header", {}, h("h2", {}, "Controls"), h("div", { class: "meta" }, "Devices / Constraints / Record")),
          h(
            "div",
            { class: "body" },
            h(
              "div",
              { class: "row" },
              h(
                "div",
                { class: "field" },
                h("label", { for: "cameraId" }, "相機"),
                h("select", { id: "cameraId" }, h("option", { value: "" }, "預設相機"))
              ),
              h(
                "div",
                { class: "field" },
                h("label", { for: "micId" }, "麥克風"),
                h("select", { id: "micId" }, h("option", { value: "" }, "預設麥克風"))
              )
            ),
            h(
              "div",
              { class: "row" },
              h(
                "div",
                { class: "field small" },
                h("label", { for: "width" }, "目標寬（ideal）"),
                h("input", { id: "width", type: "number", min: "0", placeholder: "例如 1920（留空=自動）" })
              ),
              h(
                "div",
                { class: "field small" },
                h("label", { for: "height" }, "目標高（ideal）"),
                h("input", { id: "height", type: "number", min: "0", placeholder: "例如 1080（留空=自動）" })
              ),
              h(
                "div",
                { class: "field small" },
                h("label", { for: "fps" }, "目標 FPS（ideal）"),
                h("input", { id: "fps", type: "number", min: "0", placeholder: "例如 60（留空=自動）" })
              )
            ),
            h(
              "div",
              { class: "row" },
              h(
                "div",
                { class: "field" },
                h("label", { for: "mimeType" }, "錄製格式（MediaRecorder mimeType）"),
                h("select", { id: "mimeType" })
              )
            ),
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  id: "recToggle",
                  class: state.recorder ? "btn" : "btn danger",
                  onclick: toggleRecording,
                },
                state.recorder ? "停止" : "開始錄製"
              ),
              h(
                "button",
                {
                  id: "fullscreenPlayback",
                  class: "btn",
                  onclick: () => {
                    const v = bestPlaybackElement();
                    if (v && state.recordedUrl) v.requestFullscreen?.();
                  },
                },
                "播放全螢幕"
              )
            )
          )
        )
      ),
      h(
        "div",
        { id: "playbackCard", class: "card", style: { marginTop: "16px" } },
        h(
          "header",
          {},
          h("h2", {}, "Playback + Export"),
          h(
            "div",
            { class: "row", style: { justifyContent: "flex-end" } },
            h("div", { class: "meta" }, "In-memory variants"),
            h("button", { id: "deleteRec", class: "btn", onclick: deleteRecording }, "刪除 / Delete")
          )
        ),
        h(
          "div",
          { class: "body" },
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "field", style: { minWidth: "320px", flex: "1" } },
              h("label", {}, "錄製回放"),
              h("video", { id: "playbackVideo", controls: "true", playsinline: "true", style: "width:100%; border-radius: 14px; background:#000;" })
            )
          ),
          h("div", { id: "exports", style: { marginTop: "12px" } })
        )
      )
    )
  );

  renderMimeOptions();
  renderStatus();
  renderPlaybackPanelVisibility();
  applyExpectedPreviewAspectRatio();
  renderExports();

  // Try device list without prompting permission (labels will be empty until permission granted).
  refreshDevicesAfterPermission().catch(() => {});

  const widthEl = document.querySelector("#width");
  const heightEl = document.querySelector("#height");
  if (widthEl) widthEl.addEventListener("input", applyExpectedPreviewAspectRatio);
  if (heightEl) heightEl.addEventListener("input", applyExpectedPreviewAspectRatio);
}

render();
