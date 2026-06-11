const sampleScript = `本日はお時間をいただき、ありがとうございます。

これから新しい企画についてご説明します。まず、現在の課題からお話しします。

次に、私たちが提案する解決策と、その効果をご紹介します。

最後に、今後の進め方をご説明します。どうぞよろしくお願いいたします。`;

const defaults = {
  script: sampleScript,
  fontSize: 42,
  lineHeight: 1.55,
  speed: 35,
  sensitivity: 3,
  mirror: false
};

const saved = JSON.parse(localStorage.getItem("teleprompter-settings") || "{}");
const state = { ...defaults, ...saved, currentIndex: 0, pacing: false, listening: false };
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);
let paragraphs = [];
let paceFrame = null;
let lastPaceTime = 0;
let recognition = null;
let shouldRestartRecognition = false;
let speechSegments = [];
let currentSpeechSegment = 0;
let speechHistory = "";
let currentSessionTranscript = "";
let pendingMatch = { segmentIndex: -1, count: 0 };

function saveState() {
  const { script, fontSize, lineHeight, speed, sensitivity, mirror } = state;
  localStorage.setItem("teleprompter-settings", JSON.stringify({ script, fontSize, lineHeight, speed, sensitivity, mirror }));
}

function sections() {
  return state.script.split(/\n+/).map((value) => value.trim()).filter(Boolean);
}

function renderScript() {
  elements.script.replaceChildren();
  paragraphs = sections();
  if (!paragraphs.length) paragraphs = ["「原稿」から原稿を入力してください。"];
  state.currentIndex = Math.min(state.currentIndex, paragraphs.length - 1);

  paragraphs.forEach((text, index) => {
    const paragraph = document.createElement("p");
    paragraph.className = `paragraph${index === state.currentIndex ? " current" : ""}`;
    paragraph.textContent = text;
    paragraph.dataset.index = index;
    paragraph.addEventListener("click", () => moveTo(index));
    elements.script.append(paragraph);
  });
  buildSpeechSegments();
}

function applySettings() {
  document.documentElement.style.setProperty("--font-size", `${state.fontSize}px`);
  document.documentElement.style.setProperty("--line-height", state.lineHeight);
  elements.script.classList.toggle("mirror", state.mirror);
  elements.fontSize.value = state.fontSize;
  elements.lineHeight.value = state.lineHeight;
  elements.speed.value = state.speed;
  elements.sensitivity.value = state.sensitivity;
  elements.mirror.checked = state.mirror;
  elements.fontSizeOutput.textContent = `${state.fontSize}px`;
  elements.lineHeightOutput.textContent = Number(state.lineHeight).toFixed(2);
  elements.speedOutput.textContent = `${state.speed}`;
  elements.sensitivityOutput.textContent = ["安定", "低め", "標準", "高め", "最高"][state.sensitivity - 1];
}

function setStatus(message) {
  elements.status.textContent = message;
}

function moveTo(index, smooth = true, syncSpeechPosition = true) {
  if (index < 0 || index >= paragraphs.length) return;
  state.currentIndex = index;
  if (syncSpeechPosition) {
    currentSpeechSegment = Math.max(0, speechSegments.findIndex((segment) => segment.paragraphIndex === index));
    pendingMatch = { segmentIndex: -1, count: 0 };
  }
  document.querySelector(".paragraph.current")?.classList.remove("current");
  const target = document.querySelector(`.paragraph[data-index="${index}"]`);
  target?.classList.add("current");
  target?.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "center" });
}

function togglePace() {
  state.pacing = !state.pacing;
  elements.paceButton.classList.toggle("active", state.pacing);
  elements.paceButton.querySelector(".icon").textContent = state.pacing ? "Ⅱ" : "▶";
  setStatus(state.pacing ? "一定速度でスクロール中" : "一時停止");

  if (state.pacing) {
    lastPaceTime = performance.now();
    paceFrame = requestAnimationFrame(runPace);
  } else {
    cancelAnimationFrame(paceFrame);
  }
}

function runPace(time) {
  if (!state.pacing) return;
  const elapsed = Math.min(40, time - lastPaceTime);
  elements.prompter.scrollTop += state.speed * elapsed / 1000;
  lastPaceTime = time;
  paceFrame = requestAnimationFrame(runPace);
}

function normalize(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[。、，．,.！？!?「」『』（）()・ー〜～\s]/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function ngrams(text, size = 2) {
  const result = new Set();
  for (let index = 0; index <= text.length - size; index += 1) {
    result.add(text.slice(index, index + size));
  }
  return result;
}

function similarity(spoken, candidate) {
  if (!spoken || !candidate) return 0;
  if (spoken.length >= 5 && (candidate.includes(spoken) || spoken.includes(candidate))) return 1;
  const spokenGrams = ngrams(spoken);
  const candidateGrams = ngrams(candidate);
  let overlap = 0;
  for (const gram of spokenGrams) if (candidateGrams.has(gram)) overlap += 1;
  const containment = overlap / Math.max(1, Math.min(spokenGrams.size, candidateGrams.size));
  const dice = (2 * overlap) / Math.max(1, spokenGrams.size + candidateGrams.size);
  return containment * 0.7 + dice * 0.3;
}

function splitForSpeech(text) {
  const sentences = text
    .split(/(?<=[。！？!?])|[、，,]\s*/)
    .map((value) => value.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [text];
}

function buildSpeechSegments() {
  speechSegments = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    splitForSpeech(paragraph).forEach((text) => {
      const normalized = normalize(text);
      if (normalized) speechSegments.push({ text, normalized, paragraphIndex });
    });
  });
  const firstInParagraph = speechSegments.findIndex((segment) => segment.paragraphIndex === state.currentIndex);
  currentSpeechSegment = Math.max(0, firstInParagraph);
}

function candidateText(index) {
  const previous = speechSegments[index - 1]?.normalized || "";
  const current = speechSegments[index]?.normalized || "";
  const next = speechSegments[index + 1]?.normalized || "";
  return [current, previous + current, current + next];
}

function transcriptVariants(text) {
  const normalized = normalize(text);
  const lengths = [18, 30, 48, 72, 110];
  return [...new Set(lengths.map((length) => normalized.slice(-length)).filter((value) => value.length >= 4))];
}

function followSpeech(transcripts) {
  if (!speechSegments.length) return;
  const variants = transcripts.flatMap(transcriptVariants);
  if (!variants.length) return;

  const start = Math.max(0, currentSpeechSegment - 3);
  const end = Math.min(speechSegments.length - 1, currentSpeechSegment + 12);
  let best = { segmentIndex: currentSpeechSegment, score: 0 };

  for (let segmentIndex = start; segmentIndex <= end; segmentIndex += 1) {
    let score = 0;
    for (const spoken of variants) {
      for (const candidate of candidateText(segmentIndex)) {
        score = Math.max(score, similarity(spoken, candidate));
      }
    }
    const distance = segmentIndex - currentSpeechSegment;
    if (distance >= 0 && distance <= 2) score += 0.06;
    if (distance > 6) score -= Math.min(0.12, (distance - 6) * 0.02);
    if (score > best.score) best = { segmentIndex, score };
  }

  const thresholds = [0.56, 0.48, 0.40, 0.33, 0.27];
  const threshold = thresholds[state.sensitivity - 1];
  if (best.score < threshold) return;

  if (pendingMatch.segmentIndex === best.segmentIndex) {
    pendingMatch.count += 1;
  } else {
    pendingMatch = { segmentIndex: best.segmentIndex, count: 1 };
  }

  const distance = best.segmentIndex - currentSpeechSegment;
  const confirmationsNeeded = distance > 4 ? 2 : 1;
  if (pendingMatch.count < confirmationsNeeded) return;

  currentSpeechSegment = best.segmentIndex;
  const paragraphIndex = speechSegments[best.segmentIndex].paragraphIndex;
  if (paragraphIndex !== state.currentIndex) moveTo(paragraphIndex, true, false);
  setStatus(`追従中: ${paragraphIndex + 1}/${paragraphs.length}（一致 ${Math.min(100, Math.round(best.score * 100))}%）`);
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const instance = new SpeechRecognition();
  instance.lang = "ja-JP";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 5;
  instance.onresult = (event) => {
    let sessionTranscript = "";
    const alternatives = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      sessionTranscript += result[0].transcript;
      for (let alternativeIndex = 0; alternativeIndex < result.length; alternativeIndex += 1) {
        alternatives.push(`${speechHistory} ${result[alternativeIndex].transcript}`);
      }
    }
    currentSessionTranscript = sessionTranscript;
    const fullTranscript = `${speechHistory} ${sessionTranscript}`;
    setStatus(`認識中: ${sessionTranscript.slice(-24)}`);
    followSpeech([fullTranscript, ...alternatives]);
  };
  instance.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") {
      setStatus(`音声認識エラー: ${event.error}`);
    }
  };
  instance.onend = () => {
    speechHistory = normalize(`${speechHistory}${currentSessionTranscript}`).slice(-180);
    currentSessionTranscript = "";
    if (shouldRestartRecognition) {
      setTimeout(() => {
        try { instance.start(); } catch {}
      }, 250);
    } else {
      state.listening = false;
      elements.speechButton.classList.remove("active");
    }
  };
  return instance;
}

function toggleSpeech() {
  if (!recognition) {
    setStatus("このブラウザは音声追従に対応していません");
    return;
  }
  state.listening = !state.listening;
  shouldRestartRecognition = state.listening;
  elements.speechButton.classList.toggle("active", state.listening);
  if (state.listening) {
    if (state.pacing) togglePace();
    setStatus("マイクの許可後、原稿を読み上げてください");
    speechHistory = "";
    currentSessionTranscript = "";
    pendingMatch = { segmentIndex: -1, count: 0 };
    try { recognition.start(); } catch {}
  } else {
    recognition.stop();
    setStatus("音声追従を停止しました");
  }
}

elements.editButton.addEventListener("click", () => {
  elements.scriptEditor.value = state.script;
  elements.editDialog.showModal();
});
elements.saveScriptButton.addEventListener("click", () => {
  state.script = elements.scriptEditor.value;
  state.currentIndex = 0;
  saveState();
  renderScript();
  elements.editDialog.close();
  moveTo(0, false);
});
elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
elements.paceButton.addEventListener("click", togglePace);
elements.speechButton.addEventListener("click", toggleSpeech);
elements.lockButton.addEventListener("click", () => {
  elements.controls.classList.add("hidden");
  elements.unlockButton.classList.remove("hidden");
  setStatus("操作をロック中");
});
elements.unlockButton.addEventListener("click", () => {
  elements.controls.classList.remove("hidden");
  elements.unlockButton.classList.add("hidden");
  setStatus("準備完了");
});
elements.resetPositionButton.addEventListener("click", () => moveTo(0));
elements.fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    setStatus("Safariでは共有メニューから表示を調整してください");
  }
});

for (const key of ["fontSize", "lineHeight", "speed", "sensitivity"]) {
  elements[key].addEventListener("input", (event) => {
    state[key] = Number(event.target.value);
    applySettings();
    saveState();
  });
}
elements.mirror.addEventListener("change", (event) => {
  state.mirror = event.target.checked;
  applySettings();
  saveState();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === " ") moveTo(Math.min(paragraphs.length - 1, state.currentIndex + 1));
  if (event.key === "ArrowUp") moveTo(Math.max(0, state.currentIndex - 1));
});

recognition = setupRecognition();
renderScript();
applySettings();
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
if (!recognition) {
  setStatus("音声追従非対応: 一定速度モードを利用できます");
} else if (isStandalone) {
  setStatus("音声追従はSafariタブでの利用を推奨します");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      setStatus("オフライン準備に失敗しました");
    });
  });
}
