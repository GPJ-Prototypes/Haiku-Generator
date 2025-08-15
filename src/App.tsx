import React, { useEffect, useMemo, useRef, useState } from "react";

function useSpeechSupport() {
  const supported = useMemo(() => {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);
  return supported;
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function wordsFrom(text: string): string[] {
  return (text || "")
    .replace(/[^\w'’\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function linesFromWords(words: string[], pattern: number[]): string[] {
  const result: string[] = [];
  let idx = 0;
  for (const count of pattern) {
    const slice = words.slice(idx, idx + count);
    result.push(slice.join(" "));
    idx += count;
  }
  return result;
}

function simpleHaikuFrom(text: string, seed: number): string {
  const w = wordsFrom(text);
  if (w.length < 5) return [text.trim(), "", ""].join("\n");
  // Deterministic offset based on seed
  const pattern = [5, 7, 5];
  const total = pattern.reduce((a, b) => a + b, 0);
  const maxStart = Math.max(0, w.length - total);
  const start = maxStart === 0 ? 0 : (seed % (maxStart + 1));
  const sliced = w.slice(start, start + total);
  const [l1, l2, l3] = linesFromWords(sliced, pattern);
  return [l1, l2, l3].map(s => s.trim()).join("\n");
}

export default function App() {
  const speechSupported = useSpeechSupport();
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [haikus, setHaikus] = useState<string[]>([]);
  const [selectedHaiku, setSelectedHaiku] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognition | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    recRef.current = createRecognizer();
    if (recRef.current) {
      recRef.current.onresult = (e: any) => {
        let finalText = "";
        let interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const text = res[0].transcript;
          if (res.isFinal) {
            finalText += text + " ";
          } else {
            interimText += text + " ";
          }
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
          // Some browsers auto-end; auto-restart if still within 60s
          try { recRef.current?.start(); } catch { /* ignore */ }
        }
      };
    }
    return () => {
      recRef.current?.abort();
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startListening() {
    setError(null);
    setTranscript("");
    setInterim("");
    setHaikus([]);
    setSelectedHaiku(null);
    setSeconds(0);
    setListening(true);

    // Timer up to 60s
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setSeconds(prev => {
        const next = prev + 1;
        if (next >= 60) {
          stopListening();
        }
        return next;
      });
    }, 1000);

    try {
      recRef.current?.start();
    } catch (e) {
      setError("Could not start microphone. Check permissions.");
      stopListening();
    }
  }

  function stopListening() {
    setListening(false);
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }

  function clearAll() {
    stopListening();
    setTranscript("");
    setInterim("");
    setSeconds(0);
    setHaikus([]);
    setSelectedHaiku(null);
    setError(null);
  }

  function generateHaikus() {
    const base = (transcript + " " + interim).trim();
    if (!base) return;
    const h1 = simpleHaikuFrom(base, 0);
    const h2 = simpleHaikuFrom(base, 7);
    const h3 = simpleHaikuFrom(base, 13);
    setHaikus([h1, h2, h3]);
    setSelectedHaiku(null);
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function openFirefly() {
    if (!selectedHaiku) return;
    const url = `https://firefly.adobe.com/?prompt=${encodeURIComponent(selectedHaiku)}`;
    window.open(url, "_blank");
  }

  function openExpress() {
    if (!selectedHaiku) return;
    const url = `https://express.adobe.com/?text=${encodeURIComponent(selectedHaiku)}`;
    window.open(url, "_blank");
  }

  const canGenerate = useMemo(() => {
    return !!(transcript || interim);
  }, [transcript, interim]);

  const safeSeconds = clamp(seconds, 0, 60);
  const showMicUI = speechSupported && !!recRef.current;

  return (
    <div className="container">
      <div className="header">
        <div>
          <div className="title">Memory → Haiku</div>
          <div className="subtitle">Speak for up to 60s. We’ll make 3 quick haiku options from your memory.</div>
        </div>
        <div className="small">Best in Chrome • Uses Web Speech API</div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="row" style={{justifyContent: "space-between"}}>
            <div className="row">
              {showMicUI ? (
                <>
                  <button
                    className="btn"
                    onClick={startListening}
                    disabled={listening}
                    aria-label="Start recording"
                  >
                    Start
                  </button>
                  <button
                    className="btn secondary"
                    onClick={stopListening}
                    disabled={!listening}
                    aria-label="Stop recording"
                  >
                    Stop
                  </button>
                </>
              ) : (
                <span className="small">Speech recognition not supported. Use the text box on the right.</span>
              )}
              <button className="btn secondary" onClick={clearAll}>Clear</button>
            </div>
            <div className="small timer" aria-live="polite">{safeSeconds}s / 60s</div>
          </div>

          {error && <div style={{marginTop: 10}} className="small" role="alert">Mic error: {error}</div>}

          <div style={{marginTop: 12}}>
            <div className="small" style={{marginBottom: 6}}>Transcript (live)</div>
            <div className="input mono" style={{minHeight: 120, background: "#fff"}}>
              {(transcript + (interim ? " " + interim : "")).trim() || "—"}
            </div>
          </div>

          <div style={{marginTop: 12}}>
            <div className="row" style={{justifyContent: "space-between"}}>
              <div className="small">Or type/paste a memory below (used if speech isn’t available):</div>
              <button
                className="btn secondary"
                onClick={() => copy((transcript + " " + interim).trim())}
                title="Copy transcript"
              >
                Copy Transcript
              </button>
            </div>
            <textarea
              placeholder="Type a memory here if your browser doesn’t support speech recognition…"
              rows={5}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </div>

          <div className="footer">
            <button className="btn" onClick={generateHaikus} disabled={!canGenerate}>Generate Haikus</button>
          </div>
        </div>

        <div className="card">
          <div className="row" style={{justifyContent: "space-between", marginBottom: 10}}>
            <div className="small">Choose one haiku to continue</div>
            {selectedHaiku && <span className="badge">Selected</span>}
          </div>

          {haikus.length === 0 ? (
            <div className="small">Your haikus will appear here after you generate them.</div>
          ) : (
            <>
              <div className="grid grid-3" style={{marginTop: 6}}>
                {haikus.map((h, i) => (
                  <div
                    key={i}
                    className={`card haiku ${selectedHaiku === h ? "selected" : ""}`}
                    onClick={() => setSelectedHaiku(h)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedHaiku(h); }}
                    style={{padding: 14}}
                  >
                    <div className="row" style={{justifyContent: "space-between", marginBottom: 6}}>
                      <div className="small">Haiku {i + 1}</div>
                      {selectedHaiku === h && <span className="badge">Selected</span>}
                    </div>
                    <div className="mono" style={{fontSize: 18}}>{h}</div>
                    <div className="footer" style={{justifyContent: "flex-start"}}>
                      <button className="btn secondary" onClick={(e) => { e.stopPropagation(); copy(h); }}>Copy</button>
                      <button className="btn secondary" onClick={(e) => { e.stopPropagation(); setSelectedHaiku(h); }}>Select</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="footer" style={{marginTop: 16}}>
                <button className="btn" onClick={generateHaikus}>Regenerate</button>
                {selectedHaiku && (
                  <>
                    <button className="btn red" onClick={openFirefly}>Visualize in Adobe Firefly</button>
                    <button className="btn red" onClick={openExpress}>Stylize in Adobe Express</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{marginTop: 16}} className="small">
        Note: Haikus here use a simple 5‑7‑5 <em>word</em> count for speed—not true syllables.
      </div>
    </div>
  );
}
