import React, { useEffect, useMemo, useRef, useState } from "react";
import { RiTa } from "rita";
import "./styles.css";

/* ========== Speech helpers ========== */
declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}
type SpeechRecognition = any;

function useSpeechSupport() {
  return useMemo(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition), []);
}
function createRecognizer(): SpeechRecognition | null {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec: SpeechRecognition = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/* ========== Seeded RNG ========== */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, arr: T[], fallback: T) =>
  arr.length ? arr[Math.floor(rand() * arr.length)] : fallback;

/* ========== RiTa-powered helpers ========== */
function syllablesInWord(word: string) {
  if (!word || !/[a-z]/i.test(word)) return 0;
  const sylStr = RiTa.syllables(word);
  if (!sylStr || typeof sylStr !== "string") return 0;
  const n = sylStr.split("/").filter(Boolean).length;
  return n > 0 ? n : 1;
}
function tokenizePOS(text: string) {
  const tokens: string[] = RiTa.tokenize(text || "");
  // @ts-ignore RiTa.pos accepts string[] at runtime
  const pos: string[] = RiTa.pos(tokens);
  return { tokens, pos };
}
function imageryWords(text: string) {
  const { tokens, pos } = tokenizePOS(text);
  const keep: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    const tag = (pos[i] || "").toLowerCase();
    if ((tag.startsWith("nn") || tag.startsWith("jj")) && !["other","another"].includes(t)) {
      keep.push(t);
    }
  }
  return keep;
}

/* ========== Topic lock ========== */
type TopicKey = "beach" | "forest" | "mountain" | "snow" | "city" | "generic";
const TOPIC_KEYWORDS: Record<TopicKey, string[]> = {
  beach: ["beach","ocean","sea","sand","sandy","dune","tide","wave","waves","surf","shore","sunblock","sunglasses","volleyball","seagull","pelican","pier"],
  forest: ["forest","woods","pine","pines","fir","trail","moss","fern","ferns","brook"],
  mountain: ["mountain","peak","peaks","ridge","summit","alpine","scree","cliff"],
  snow: ["snow","ice","frost","winter","icicle","blizzard","white","hush"],
  city: ["city","street","streets","subway","traffic","neon","pavement","market","downtown","skyline"],
  generic: []
};
const TOPIC_FILLERS: Record<TopicKey, { f1: string[]; f2: string[]; nouns: string[]; banned?: string[]; kigo?: string[] }> = {
  beach: { f1:["warm","bright","soft","salt","cool","clear"], f2:["sunlit","silver","quiet"],
    nouns:["ocean","sea","shore","sand","dune","dunes","tide","tides","wave","waves","foam","surf","shell","shells","seagull","seagulls","sunglasses","sunblock","volleyball","umbrella","boardwalk","pier"],
    banned:["snow","ice","winter","icicle","frost","drifts","white","hush"], kigo:["hot sand","salt wind","bright noon","summer heat"] },
  forest: { f1:["green","soft","moss","pine","fern"], f2:["quiet","shadow"],
    nouns:["pines","moss","fern","ferns","trail","shade","needles","trunk","leaf","leaves","understory","brook"], kigo:["spring rain","green shade"] },
  mountain:{ f1:["thin","high","cold","clear"], f2:["silent","autumn"],
    nouns:["ridge","peaks","summit","scree","cliff","crag","alpine"], kigo:["autumn wind","cold moon"] },
  snow:    { f1:["white","cold","still"], f2:["winter","silent"],
    nouns:["snow","drifts","ice","icicle","frost","tracks","breath"], kigo:["winter dusk","snow hush","cold moon"] },
  city:    { f1:["neon","warm","late"], f2:["silver","quiet"],
    nouns:["street","streets","traffic","neon","pavement","window","windows","market","skyline"], kigo:["summer heat","night lights"] },
  generic: { f1:["still","soft","near","calm","slow"], f2:["quiet","silver","softly"],
    nouns:["river","stones","reeds","shore","forest","wind","shadow","moon","water"] }
};
function scoreTopic(tokens: string[]): TopicKey {
  const scores: Record<TopicKey, number> = { beach:0, forest:0, mountain:0, snow:0, city:0, generic:0 };
  const lower = tokens.map(t => t.toLowerCase());
  (Object.keys(TOPIC_KEYWORDS) as TopicKey[]).forEach(k => {
    const keys = TOPIC_KEYWORDS[k];
    scores[k] = keys.reduce((s, kw) => s + (lower.includes(kw) ? 2 : 0) + (lower.some(t => t.includes(kw)) ? 1 : 0), 0);
  });
  const best = (Object.entries(scores) as [TopicKey, number][]).sort((a,b) => b[1]-a[1])[0];
  return best && best[1] > 0 ? best[0] : "generic";
}

/* ========== Natural packers ========== */
const GLUE_WORDS = ["the","a","in","on","by","with","of","to","and","at","near","under","over","through","into","from","for","as","where","along","over"];
const GLUE_SET = new Set(GLUE_WORDS.map(w => w.toLowerCase()));
const isGlue = (w: string) => GLUE_SET.has(w.toLowerCase());

function packNatural(pool: string[], target: number, topic: TopicKey, rand: () => number, minWords: number) {
  const words: string[] = [];
  let syl = 0;
  const imagerySorted = [...pool].sort((a, b) => syllablesInWord(a) - syllablesInWord(b));
  const glueSorted = [...GLUE_WORDS].sort((a, b) => syllablesInWord(a) - syllablesInWord(b));
  const maxAttempts = 36;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    words.length = 0; syl = 0;
    const preferGlue = () => (words.length > 0 && rand() < 0.42);
    let guard = 0;
    while (syl < target && guard++ < 160) {
      const addGlue = preferGlue();
      const source = addGlue ? glueSorted : imagerySorted;
      if (addGlue && words.length > 0 && isGlue(words[words.length - 1])) continue;
      const fits = source.filter(w => syllablesInWord(w) > 0 && syl + syllablesInWord(w) <= target);
      if (fits.length === 0) {
        const alt = (!addGlue ? glueSorted : imagerySorted).filter(w => syl + syllablesInWord(w) <= target);
        if (!alt.length) break;
        const w = pick(rand, alt, alt[0]); words.push(w); syl += syllablesInWord(w);
      } else {
        const short = fits.filter(w => syllablesInWord(w) === 1);
        const two = fits.filter(w => syllablesInWord(w) === 2);
        const pickPool = short.length ? short : (two.length ? two : fits);
        const w = pick(rand, pickPool, pickPool[0]); words.push(w); syl += syllablesInWord(w);
      }
    }
    if (syl !== target) continue;
    const imageryCount = words.filter(w => !isGlue(w)).length;
    const glueCount = words.length - imageryCount;
    if (words.length >= minWords && imageryCount >= Math.ceil(minWords * 0.6) && glueCount <= Math.ceil(words.length * 0.5)) {
      return words;
    }
  }
  return null;
}
function packExact(pool: string[], target: number, topic: TopicKey, rand: () => number) {
  const { f1, f2 } = TOPIC_FILLERS[topic] || TOPIC_FILLERS.generic;
  const fillers = [...f1, ...f2];
  for (let attempt = 0; attempt <= 5; attempt++) {
    const shift = attempt * 3 + Math.floor(rand() * 3);
    const rotated = pool.length ? pool.slice(shift).concat(pool.slice(0, shift)) : [];
    const line: string[] = [];
    let used = new Set<number>();
    let syl = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < rotated.length && syl < target; i++) {
        if (used.has(i)) continue;
        const w = rotated[i];
        const s = syllablesInWord(w);
        if (s === 0) continue;
        if (syl + s <= target) { line.push(w); syl += s; used.add(i); }
      }
      if (syl === target) break;
      if (syl < target) {
        const need = target - syl;
        const exact = fillers.filter(w => syllablesInWord(w) === need);
        if (exact.length) { line.push(pick(rand, exact, exact[0])); syl = target; break; }
        if (need >= 2) {
          const twos = fillers.filter(w => syllablesInWord(w) === 2);
          if (twos.length) { line.push(pick(rand, twos, twos[0])); syl += 2; }
        } else {
          const ones = fillers.filter(w => syllablesInWord(w) === 1);
          if (ones.length) { line.push(pick(rand, ones, ones[0])); syl += 1; }
        }
      }
    }
    if (syl === target) return line;
  }
  return null;
}

/* ========== Compose strict 5–7–5 ========== */
function composeHaikuRiTa(text: string, seed: number) {
  const rand = mulberry32(seed || 1);
  const rawTokens = (text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const topic = scoreTopic(rawTokens);
  const banned = new Set((TOPIC_FILLERS[topic]?.banned || []).map(w => w.toLowerCase()));
  const pool = imageryWords(text).filter(w => !banned.has(w))
    .concat(TOPIC_FILLERS[topic]?.nouns || TOPIC_FILLERS.generic.nouns);
  const seen = new Set<string>();
  const uniquePool = pool.filter(w => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const kigo = TOPIC_FILLERS[topic]?.kigo || [];
  const kigoTokens = (kigo.length && rand() < 0.5) ? pick(rand, kigo, kigo[0]).split(" ") : [];
  const workingPool = [...kigoTokens, ...uniquePool];
  const L1 = packNatural(workingPool, 5, topic, rand, 3) || packExact(workingPool, 5, topic, rand);
  const L2 = packNatural(workingPool, 7, topic, rand, 4) || packExact(workingPool, 7, topic, rand);
  const L3 = packNatural(workingPool, 5, topic, rand, 3) || packExact(workingPool, 5, topic, rand);
  if (L1 && L2 && L3) return [L1.join(" "), L2.join(" "), L3.join(" ")].join("\n");
  return fallbackLoose(text);
}
function fallbackLoose(text: string) {
  const pool = imageryWords(text);
  const lines = [5,7,5].map(t => {
    const out: string[] = []; let syl = 0;
    for (const w of pool) { const s = syllablesInWord(w); if (syl + s <= t) { out.push(w); syl += s; } if (syl === t) break; }
    return out.join(" ");
  });
  return lines.join("\n");
}
function countLine(line: string) {
  return line.split(/\s+/).filter(Boolean).reduce((s, w) => s + syllablesInWord(w), 0);
}
function count575(haiku: string) {
  const [a="",b="",c=""] = haiku.split("\n");
  return [countLine(a), countLine(b), countLine(c)];
}

/* ========== React App ========== */
export default function App() {
  const speechSupported = useSpeechSupport();
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const [haikus, setHaikus] = useState<string[]>([]);
  const [selectedHaiku, setSelectedHaiku] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [lastSource, setLastSource] = useState<string>("");
  const [regenCount, setRegenCount] = useState(0);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const recRef = useRef<SpeechRecognition | null>(null);
  const timerRef = useRef<number | null>(null);

  // IMPORTANT: Always show Start/Stop if the browser supports speech
  const showMicUI = speechSupported; // (no longer gated on recRef.current)

  useEffect(() => {
    // No eager recognizer creation; we'll build a fresh one on Start
    return () => {
      try { recRef.current?.abort(); } catch {}
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  function startListening() {
    setError(null);
    setTranscript("");
    setInterim("");
    setHaikus([]);
    setSelectedHaiku(null);
    setSeconds(0);

    // Always build a fresh recognizer on Start so we never carry a "busy" instance
    try { recRef.current?.abort(); } catch {}
    recRef.current = createRecognizer();
    if (!recRef.current) {
      setError("Speech recognition not supported in this browser.");
      return;
    }

    // Wire handlers
    recRef.current.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript || "";
        if (res.isFinal) finalText += text + " ";
        else interimText += text + " ";
      }
      if (finalText) setTranscript(prev => (prev + " " + finalText).replace(/\s+/g, " ").trim());
      setInterim(interimText.trim());
    };
    recRef.current.onerror = (e: any) => {
      setError(e?.error ? String(e.error) : "speech_error");
      stopListening();
    };
    recRef.current.onend = () => {
      if (listening) {
        try { recRef.current?.start(); } catch {}
      }
    };

    setListening(true);

    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setSeconds(prev => {
        const next = prev + 1;
        if (next >= 60) stopListening();
        return next;
      });
    }, 1000);

    try {
      recRef.current.start();
    } catch {
      setError("Could not start microphone. Check permissions.");
      stopListening();
    }
  }

  function stopListening() {
    setListening(false);
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    try { recRef.current?.stop(); } catch {}
  }

  function clearAll() {
    stopListening();
    setTranscript("");
    setInterim("");
    setSeconds(0);
    setHaikus([]);
    setSelectedHaiku(null);
    setError(null);
    setLastSource("");
    setRegenCount(0);
  }

  function generateHaikus() {
    const base = (transcript + " " + interim).trim();
    if (!base) return;
    const h1 = composeHaikuRiTa(base, 3);
    const h2 = composeHaikuRiTa(base, 7);
    const h3 = composeHaikuRiTa(base, 13);
    setHaikus([h1, h2, h3]);
    setSelectedHaiku(null);
    setLastSource(base);
    setRegenCount(0);
  }

  function regenerateFromLast() {
    const source = (selectedHaiku?.trim() || lastSource || (transcript + " " + interim).trim());
    if (!source) return;
    const offset = regenCount * 3;
    const h1 = composeHaikuRiTa(source, 5 + offset);
    const h2 = composeHaikuRiTa(source, 9 + offset);
    const h3 = composeHaikuRiTa(source, 15 + offset);
    setHaikus([h1, h2, h3]);
    setRegenCount(c => c + 1);
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  async function copyWithNotice(text: string) {
    try { await navigator.clipboard.writeText(text); setCopiedPrompt(true); setTimeout(() => setCopiedPrompt(false), 1200); } catch {}
  }
  async function openFirefly() {
    if (!selectedHaiku) return;
    await copyWithNotice(selectedHaiku);
    const url = `https://firefly.adobe.com/?prompt=${encodeURIComponent(selectedHaiku)}`;
    window.open(url, "_blank");
  }
  async function openExpress() {
    if (!selectedHaiku) return;
    await copyWithNotice(selectedHaiku);
    const url = `https://express.adobe.com/?text=${encodeURIComponent(selectedHaiku)}`;
    window.open(url, "_blank");
  }

  const canGenerate = useMemo(() => !!(transcript || interim), [transcript, interim]);
  const safeSeconds = clamp(seconds, 0, 60);

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <div>
            <div className="title">Haiku</div>
            <div className="subtitle">Strict 5–7–5 with RiTa syllables; natural phrasing.</div>
          </div>
          <div className="small">Best in Chrome • Uses Web Speech API</div>
        </div>

        <div className="grid grid-2">
          {/* Left */}
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                {showMicUI ? (
                  <>
                    <button className="btn" onClick={startListening} disabled={listening}>Start</button>
                    <button className="btn secondary" onClick={stopListening} disabled={!listening}>Stop</button>
                  </>
                ) : (
                  <span className="small">Speech recognition not supported. Use the text box below.</span>
                )}
                <button className="btn secondary" onClick={clearAll}>Clear</button>
              </div>
              <div className="small timer" aria-live="polite">{safeSeconds}s / 60s</div>
            </div>

            {error && <div style={{ marginTop: 10 }} className="small error" role="alert">Mic error: {error}</div>}

            <div style={{ marginTop: 12 }}>
              <div className="small" style={{ marginBottom: 6 }}>Transcript (live)</div>
              <div className="input mono">
                {(transcript + (interim ? " " + interim : "")).trim() || "—"}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="small">Or type/paste a memory:</div>
                <button className="btn secondary" onClick={() => copy((transcript + " " + interim).trim())}>Copy Transcript</button>
              </div>
              <textarea
                className="textArea"
                placeholder="Type a memory here…"
                rows={5}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
              />
            </div>

            <div className="footer">
              <button className="btn primary" onClick={generateHaikus} disabled={!canGenerate}>Generate Haikus</button>
            </div>
          </div>

          {/* Right */}
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div className="small">Choose one haiku to continue</div>
              <div className="row" style={{ gap: 8 }}>
                {copiedPrompt && <span className="badge">Copied!</span>}
                {selectedHaiku && <span className="badge">Selected</span>}
              </div>
            </div>

            {haikus.length === 0 ? (
              <div className="small dim">Your haikus will appear here after you generate them.</div>
            ) : (
              <>
                <div className="grid grid-3">
                  {haikus.map((h, i) => {
                    const [s1, s2, s3] = count575(h);
                    const ok = (s1 === 5 && s2 === 7 && s3 === 5);
                    return (
                      <div
                        key={i}
                        className={`card haiku ${selectedHaiku === h ? "selected" : ""}`}
                        onClick={() => setSelectedHaiku(h)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedHaiku(h); }}
                      >
                        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                          <div className="small">Haiku {i + 1}</div>
                          {selectedHaiku === h && <span className="badge">Selected</span>}
                        </div>

                        <div className="mono haikuText">{h}</div>

                        {/* Optional: show counts
                        <div className={`syllables ${ok ? "ok" : "bad"}`}>
                          {s1} / {s2} / {s3}
                        </div>
                        */}

                        <div className="footer" style={{ justifyContent: "center", gap: 8 }}>
                          <button className="btn secondary" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(h); }}>
                            Copy
                          </button>
                          <button className="btn secondary" onClick={(e) => { e.stopPropagation(); setSelectedHaiku(h); }}>
                            Select
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="footer actions">
                  <button className="btn" onClick={regenerateFromLast}>Regenerate</button>
                  {selectedHaiku && (
                    <div className="row" style={{ gap: 10 }}>
                      <button className="btn red" onClick={openFirefly}>Visualize in Adobe Firefly</button>
                      <button className="btn red" onClick={openExpress}>Stylize in Adobe Express</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="small dim" style={{ marginTop: 16 }}>
          Guaranteed 5–7–5 syllables. Start is available immediately after refresh.
        </div>
      </div>
    </div>
  );
}
