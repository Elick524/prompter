const sampleScript = `本日はお時間をいただき、ありがとうございます。

これから新しい企画についてご説明します。まず、現在の課題からお話しします。

次に、私たちが提案する解決策と、その効果をご紹介します。

最後に、今後の進め方をご説明します。どうぞよろしくお願いいたします。`;

const defaults = {
  script: sampleScript,
  fontSize: 42,
  lineHeight: 1.55,
  speed: 35,
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

function saveState() {
  const { script, fontSize, lineHeight, speed, mirror } = state;
  localStorage.setItem("teleprompter-settings", JSON.stringify({ script, fontSize, lineHeight, speed, mirror }));
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
}

function applySettings() {
  document.documentElement.style.setProperty("--font-size", `${state.fontSize}px`);
  document.documentElement.style.setProperty("--line-height", state.lineHeight);
  elements.script.classList.toggle("mirror", state.mirror);
  elements.fontSize.value = state.fontSize;
  elements.lineHeight.value = state.lineHeight;
  elements.speed.value = state.speed;
  elements.mirror.checked = state.mirror;
  elements.fontSizeOutput.textContent = `${state.fontSize}px`;
  elements.lineHeightOutput.textContent = Number(state.lineHeight).toFixed(2);
  elements.speedOutput.textContent = `${state.speed}`;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function moveTo(index, smooth = true) {
  if (index < 0 || index >= paragraphs.length) return;
  state.currentIndex = index;
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
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
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
  if (candidate.includes(spoken) || spoken.includes(candidate)) return 1;
  const spokenGrams = ngrams(spoken);
  const candidateGrams = ngrams(candidate);
  let overlap = 0;
  for (const gram of spokenGrams) if (candidateGrams.has(gram)) overlap += 1;
  return overlap / Math.max(1, Math.min(spokenGrams.size, candidateGrams.size));
}

function followSpeech(transcript) {
  const spoken = normalize(transcript).slice(-60);
  if (spoken.length < 3) return;
  const start = Math.max(0, state.currentIndex - 2);
  const end = Math.min(paragraphs.length - 1, state.currentIndex + 8);
  let best = { index: state.currentIndex, score: 0 };

  for (let index = start; index <= end; index += 1) {
    const score = similarity(spoken, normalize(paragraphs[index]));
    if (score > best.score) best = { index, score };
  }
  if (best.score >= 0.34) moveTo(best.index);
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const instance = new SpeechRecognition();
  instance.lang = "ja-JP";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;
  instance.onresult = (event) => {
    let transcript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    setStatus(`認識中: ${transcript.slice(-24)}`);
    followSpeech(transcript);
  };
  instance.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") {
      setStatus(`音声認識エラー: ${event.error}`);
    }
  };
  instance.onend = () => {
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

for (const key of ["fontSize", "lineHeight", "speed"]) {
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
