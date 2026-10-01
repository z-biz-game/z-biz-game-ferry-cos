// Sound. One AudioContext, created lazily on the first gesture (a context built before any
// gesture starts life "suspended" on iOS and never wakes up), and one rule that makes the mute
// switch honest: while the game is not audible, **no oscillator is ever created** and the
// context itself is suspended. Setting a gain to 0 would keep the whole graph running — that is
// the fake mute this file exists to avoid.
//
// Audibility is a product of two independent switches, both supplied by js/main.js:
//   audible = !muted && !paused
// so pausing the river also stops the lantern-song, and un-pausing while muted stays silent.

const NOTES = {
  board: [523.25], // 上船：一枚 C5
  unboard: [392.0],
  depart: [329.63, 493.88], // 离岸：E4 后跟一个上五度
  land: [440.0, 329.63],
  reject: [138.59], // 被规则拒绝：低音，短
  win: [523.25, 659.25, 783.99, 1046.5],
  ui: [659.25],
};

let ctx = null;
let muted = false;
let paused = false;
let lastError = null;

function ensure() {
  if (ctx) return ctx;
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    ctx = null;
  }
  return ctx;
}

function call(ac, name) {
  // The node-test harnesses stub AudioContext with only what a browser strictly needs; a missing
  // suspend()/resume() must degrade to "sound works, mute still refuses to make nodes".
  const fn = ac && ac[name];
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(ac);
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    return null;
  }
}

// Suspended is the *state*, not a gain value: nothing schedules, nothing runs.
function sync() {
  if (!ctx) return;
  if (audible()) {
    if (ctx.state === 'suspended') call(ctx, 'resume');
  } else if (ctx.state === 'running') {
    call(ctx, 'suspend');
  }
}

function audible() {
  return !muted && !paused;
}

function tone(ac, freq, at, dur, peak, type) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type || 'triangle';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  return osc;
}

export const audio = {
  // Called from a real gesture (pointerdown / keydown / click) so the context is born unlocked.
  unlock() {
    const ac = ensure();
    if (!ac) return false;
    sync();
    return true;
  },

  play(name) {
    const seq = NOTES[name];
    if (!seq) return false;
    if (!audible()) {
      // The honest part: a muted or paused game never touches the graph. `blocked` is the number
      // a test reads to prove the refusal happened at the graph, not at a gain node.
      audio.stats.blocked += 1;
      return false;
    }
    const ac = ensure();
    if (!ac) return false;
    if (ac.state === 'suspended') call(ac, 'resume');
    const t0 = ac.currentTime + 0.001;
    seq.forEach((f, i) => tone(ac, f, t0 + i * 0.075, name === 'win' ? 0.34 : 0.16, 0.16, name === 'reject' ? 'sawtooth' : 'triangle'));
    audio.stats.played += 1;
    audio.stats.lastAt = t0;
    return true;
  },

  setMuted(v) {
    muted = !!v;
    sync();
    audio.stats.muted = muted;
    return muted;
  },

  setPaused(v) {
    paused = !!v;
    sync();
    return paused;
  },

  isMuted() { return muted; },
  isPaused() { return paused; },
  audible,
  state() {
    return {
      hasContext: !!ctx,
      contextState: ctx ? String(ctx.state) : 'none',
      muted,
      paused,
      error: lastError,
    };
  },
  // Read by window.ferry so "the mute is real" can be re-proved from outside instead of asserted.
  stats: { played: 0, blocked: 0, muted: false, lastAt: 0 },
};
