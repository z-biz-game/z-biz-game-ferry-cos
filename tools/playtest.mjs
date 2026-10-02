// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). No Playwright,
// no dependencies.
// env: CDP_PORT (devtools port, default 9340), BASE_URL (page to attach to, default
//      http://127.0.0.1:5180/), GATE_SELFTEST=1 (every report this process emits carries one
//      deliberately wrong expectation, so the gate can be shown to go red — 阴性自证: run
//      `GATE_SELFTEST=1 bash tools/verify.sh` and check it exits non-zero with that row named;
//      a gate that never rejects a planted failure is not a gate)
// usage:
//   node tools/playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node tools/playtest.mjs nav   <url>          # navigate the attached page somewhere else
//   node tools/playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval  '@boot'        # | @play | @routes | @save | @pointer | @readback
//   node tools/playtest.mjs leg   mouse|touch|keys  # one real-input channel, driven from Node
//   node tools/playtest.mjs witness               # print the current document's identity (one line)
//   node tools/playtest.mjs reload                # a real Page.reload, waited on
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// `@pointer` is the aggregate of the three input legs (see INPUT_LEGS); `leg <channel>` runs one of
// them alone while editing it. `@readback` is the consumer of witness/reload and needs them in
// order: a leg first (any of the three leaves crossings on record), then `witness` to capture the
// document id, then `WITNESS='<that json>' eval @readback` — that eval navigates, so what it reads
// back is a new document. `@save` is NOT a valid predecessor: its last rows wipe the archive.
//
// Every report is one line: `RESULT {"rows":[{test,pass,detail}...],"fail":[...]}`, plus the
// pretty JSON when REPORT_JSON=1. tools/verify.sh counts the braces of the first object on the
// captured stream rather than parsing a whole line: headless Chrome can append its own text to the
// line a console log lands on, and a truncated payload would read as "this leg has no failures".
const PORT = process.env.CDP_PORT || 9340;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a fresh
// about:blank tab when pointed at any other origin (GitHub Pages included).
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5180/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const SELFTEST = process.env.GATE_SELFTEST === '1';
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // One place emits, so a report cannot escape the self-test plant by being produced some other
  // way. Page-side suites and Node-side input legs both arrive here as { rows }.
  const emit = (value) => {
    value.rows = value.rows || [];
    if (SELFTEST) {
      value.rows.push({ test: 'GATE_SELFTEST 种下的错期望（1 应当等于 2）', pass: 1 === 2, detail: 'planted red' });
    }
    value.fail = value.rows.filter((r) => !r.pass).map((r) => r.test);
    console.log('RESULT ' + JSON.stringify(value));
    if (process.env.REPORT_JSON === '1') console.log(JSON.stringify(value, null, 2));
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network: a
  // fixed sleep is long enough for a localhost server and too short for GitHub Pages, where it
  // made an innocent deployment look broken (`window.ferry` still undefined, canvas still the
  // unstyled 300x150 default). The floor keeps the local case as fast as it was.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.ferry && window.ferry.state && window.ferry.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'reload') {
    // Plumbing, not a report: the proof that this was a real new document belongs to @readback,
    // which gets handed the timeOrigin captured before this call (see the usage block above).
    const before = await runJS('performance.timeOrigin');
    await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
    const ready = await waitShell(200);
    const after = await runJS('performance.timeOrigin').catch(() => null);
    console.log(`reloaded shell=${ready ? 'ready' : 'MISSING'} timeOrigin ${before} -> ${after}`);
    if (!ready || after === null || after === before) process.exit(1);
  } else if (cmd === 'witness') {
    console.log(JSON.stringify(await runJS('JSON.stringify({t:performance.timeOrigin,u:location.href})'))
      .replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  } else if (cmd === 'leg') {
    emit(await INPUT_LEGS[arg](cdp, sessionId, runJS));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      // `@pointer` is the browser gate's name for the whole real-input surface: it runs the three
      // channels in order and reports them as one, because tools/verify.sh drives one `eval` per
      // scenario and counts the rows it gets back. `leg <channel>` runs exactly one of them.
      if (name === 'pointer') {
        const all = { rows: [] };
        for (const [chan, fn] of Object.entries(INPUT_LEGS)) {
          try {
            const v = await fn(cdp, sessionId, runJS);
            for (const r of v.rows) all.rows.push({ ...r, test: `${chan} · ${r.test}` });
          } catch (err) {
            all.rows.push({ test: `${chan} · leg threw`, pass: false, detail: String(err.message).slice(0, 300) });
          }
        }
        emit(all);
        process.exit(all.fail.length ? 1 : 0);
      }
      if (!SCENARIOS[name]) {
        console.log('RESULT ' + JSON.stringify({ rows: [{ test: `@${name} is not a scenario`, pass: false, detail: 'have: ' + Object.keys(SCENARIOS).join(', ') }], fail: [`@${name} is not a scenario`] }));
        process.exit(1);
      }
      // A leg that compares itself against a pre-navigation witness has to be handed that witness
      // by Node, because nothing survives the reload except what gets written back in.
      if (process.env.WITNESS) await runJS(`window.__witness=${process.env.WITNESS};'ok'`);
      let value;
      try {
        value = await runJS(SCENARIOS[name]);
      } catch (err) {
        const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
        value = { rows: JSON.parse(dumped) };
        value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
      }
      emit(value);
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
      if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
    }
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one thing a page-side script cannot do: real input. These legs go through Chrome's own
// mouse, touch and keyboard over CDP, at coordinates the renderer itself publishes
// (`rolePoint`/`boatPoint`), so what gets asserted is the finger-to-rule wiring in js/view.js —
// that a drag really boards, that a click on the hull really casts off, and that a refusal really
// costs nothing. Injecting JS to move the boat would prove `depart()` and nothing else.
//
// Three legs, three event channels, one kit: `mouse` sends Input.dispatchMouseEvent, `touch` sends
// Input.dispatchTouchEvent, `keys` sends Input.dispatchKeyEvent. A leg that fell back to the
// channel it shares with another leg would print a green that belongs to somebody else.
async function makeKit(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
  const touch = async (x, y, x2, y2) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }],
    }, sessionId);
    if (x2 !== undefined) {
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{
            x: Math.round(x + ((x2 - x) * i) / 8),
            y: Math.round(y + ((y2 - y) * i) / 8),
            radiusX: 6, radiusY: 6, force: 1, id: 1,
          }],
        }, sessionId);
      }
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(50);
  };
  const tap = (x, y) => touch(x, y);
  // keyDown with `text` is what reaches a window keydown listener; the code/virtual-key fields are
  // what a page that filters on them would see, so a letter key and Space each get their own.
  // Space and Escape are the two that cannot use `text`: Chrome rejects any text that is not a
  // single character, and ' ' as text arrives as a keypress on the focused button instead of the
  // window listener. Those two go as rawKeyDown, which still delivers keydown with ev.key set.
  const key = (k, code, vk, type = 'keyDown') => cdp.send('Input.dispatchKeyEvent', {
    type, key: k, code: code || 'Key' + k.toUpperCase(),
    windowsVirtualKeyCode: vk || k.toUpperCase().charCodeAt(0),
    ...(type === 'keyDown' ? { text: k } : {}),
  }, sessionId);
  const S = () => runJS('window.ferry.state');
  const point = (expr) => runJS(`window.ferry.${expr}`);
  const short = (id) => runJS(`window.ferry.names()[${id}]`);

  // The crossing glide is cosmetic, but `down()` ignores input while it runs so that one click
  // cannot count twice. Poll it instead of sleeping: no timing constant to get wrong.
  async function settle(budget = 5000) {
    const deadline = Date.now() + budget;
    for (;;) {
      const busy = await runJS('window.ferry.state.busy');
      if (!busy) return true;
      if (Date.now() > deadline) return false;
      await sleep(40);
    }
  }

  async function drag(from, to, steps = 8) {
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved',
        Math.round(from.x + ((to.x - from.x) * i) / steps),
        Math.round(from.y + ((to.y - from.y) * i) / steps), 1);
    }
    await mouse('mouseReleased', to.x, to.y, 0);
    await sleep(50);
  }

  async function press(p) {
    await mouse('mousePressed', p.x, p.y, 1);
    await mouse('mouseReleased', p.x, p.y, 0);
    await sleep(50);
  }

  // A real click on a real DOM control, at the coordinates the browser gave it.
  async function clickEl(id) {
    const box = await runJS(`(() => { const b = document.getElementById('${id}').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await press(box);
  }

  async function board(id) {
    const rp = await point(`rolePoint(${id})`);
    const bp = await point('boatPoint()');
    await drag(rp, { x: bp.x, y: bp.y });
    return { rp, bp };
  }

  async function load(hash) {
    await runJS(`window.ferry.load('${hash}'); 'ok'`);
    await settle();
  }

  return { rows, rec, mouse, touch, tap, key, S, point, short, settle, drag, press, clickEl, board, load };
}

async function mouseLeg(cdp, sessionId, runJS) {
  const { rows, rec, S, point, short, settle, drag, press, clickEl, board, load } =
    await makeKit(cdp, sessionId, runJS);

  // ---- the control surface actually exists -----------------------------------------
  const ids = await runJS("['lot','modes','totals','crumbs','readout','legend','hintline','curtain','stars','verdict','tally','undo','hint','restart','share','shelf','wipe','toast','next','again'].map((i) => [i, !!document.getElementById(i)])");
  rec('every control the shell reaches for exists', ids.length === 20 && ids.every(([, on]) => on), Object.fromEntries(ids));

  // ---- a par-3 'ferry' crossing, entirely by mouse ---------------------------------
  await load('#/lot/shoal-03');
  const start = await S();
  rec('the pointer lot loads with a certified par of 3 under the boatman law',
    start.id === 'shoal-03' && start.par === 3 && start.law === 'ferry' && start.trips === 0, start);
  const plan = await runJS('window.ferry.plan()');
  rec('the route the page plans is exactly the printed par', plan.length === start.par, { plan, par: start.par });
  const seats = await runJS('window.ferry.state.roles === 3 && [0,1,2].every((i) => !!window.ferry.rolePoint(i))');
  rec('every role reports a point a finger can press', seats === true, seats);
  const bp0 = await point('boatPoint()');
  rec('the hull starts drawn at the near dock', bp0.bank === 0 && bp0.x < (await runJS('window.innerWidth / 2')), bp0);

  let counted = 0;
  for (const cargo of plan) {
    for (const id of cargo) {
      const before = await S();
      const nm = await short(id);
      await board(id);
      const after = await S();
      rec(`drag ${nm} onto the boat boards it and costs no single trip`,
        after.boat.indexOf(id) >= 0 && after.trips === before.trips, { before: before.boat, after: after.boat, trips: after.trips });
    }
    const before = await S();
    const hull = await point('boatPoint()');
    await press(hull);
    const settled = await settle();
    const after = await S();
    counted++;
    rec(`click ${counted}: one press on the hull is exactly one single trip`,
      settled && after.trips === before.trips + 1 && after.boat.length === 0, { before: before.trips, after: after.trips, busy: after.busy });
    const bp = await point('boatPoint()');
    const dock = await point(`dockPoint(${after.bank})`);
    rec(`after click ${counted} the hull is drawn on the far side, not merely counted`,
      bp.bank === after.bank && Math.abs(bp.x - dock.x) <= 2 && bp.bank !== before.bank
        // The drawn centre has to have *travelled*: a hull that spans the channel parks both docks
        // on the same pixel, and then this row would pass while the river showed nothing moving.
        && Math.abs(bp.x - hull.x) >= 24, { bp, dock, from: before.bank, travelled: Math.abs(bp.x - hull.x) });
    if (cargo.length === 1) {
      rec("under 'ferry' the boatman crossing alone is legal and counts one single trip",
        after.trips === before.trips + 1 && after.fault === null, { cargo, trips: after.trips });
    }
  }
  rec(`the mouse plays the whole certified route (${plan.length} single trips, no more)`,
    counted === start.par && (await runJS('window.ferry.state.done')), { counted, par: start.par });
  const win = await S();
  rec('the win card goes up at par with three stars',
    win.curtain && win.stars === '★★★' && win.verdict === '分毫不差', { stars: win.stars, verdict: win.verdict });
  const record = await runJS('window.ferry.store.record(window.ferry.state.id)');
  rec('the mouse-run is on record at par and flagged perfect',
    record && record.best === start.par && record.perfect === true, record);

  // ---- the same lot, cleared by a real click on 重开 --------------------------------
  await clickEl('restart');
  const back = await S();
  rec('重开 by mouse clears the count, the crew and the card',
    back.trips === 0 && back.boat.length === 0 && !back.curtain && back.hints === 0, back);

  // ---- refusals must not count, and must not move anyone ---------------------------
  await load('#/lot/shoal-04'); // 艄公船, capacity 3, four roles
  await board(0);
  await board(1);
  await board(2);
  const full = await S();
  rec('the boat fills to exactly its capacity', full.boat.length === 3 && full.trips === 0, full);
  await board(3);
  const over = await S();
  rec('a fourth role is refused by a real drag: capacity holds and nothing is counted',
    over.boat.length === 3 && over.trips === 0 && over.fault && over.fault.why === 'over',
    { boat: over.boat, trips: over.trips, fault: over.fault });

  // Drag one crew member back onto the bank: unloading also costs nothing.
  const aboardPt = await point('rolePoint(2)');
  const bankPt = await runJS('(() => { const b = document.getElementById("lot").getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()');
  await drag(aboardPt, bankPt);
  const freed = await S();
  rec('dragging a role off the boat unloads it and costs no single trip',
    freed.boat.indexOf(2) < 0 && freed.trips === 0 && freed.boat.length === 2, freed);

  // ---- the teaching point, by mouse -------------------------------------------------
  await clickEl('restart');
  await board(0);
  await board(3); // 客商: leaving 狼 and 羊 together on the near bank
  const hull2 = await point('boatPoint()');
  await press(hull2);
  const bad = await S();
  rec('a crossing that would strand a conflicting pair is refused by mouse and names both roles',
    bad.trips === 0 && bad.fault && bad.fault.why === 'conflict' && bad.fault.where === 'departure'
      && bad.fault.roles.slice().sort().join(',') === '1,2' && bad.boat.length === 2,
    { fault: bad.fault, trips: bad.trips, boat: bad.boat });
  rec('the panel says it out loud in the model’s own words',
    /拒绝|出事/.test(bad.line) && /狼|羊/.test(bad.line), bad.line);

  // ---- far bank, open water, and the other boat law --------------------------------
  // One legal trip first, so somebody really is across: 艄公 + 羊 go, 狼 + 客商 stay.
  await clickEl('restart');
  await board(0);
  await board(2);
  await press(await point('boatPoint()'));
  await settle();
  const crossed = await S();
  rec('a legal mouse crossing moves exactly the crew that was aboard',
    crossed.trips === 1 && crossed.right.join(',') === '0,2' && crossed.left.join(',') === '1,3', crossed);

  const farId = crossed.left[0];
  const b0 = await S();
  await board(farId);
  const a0 = await S();
  rec('a role on the far bank cannot be dragged into the boat and nothing counts',
    a0.trips === b0.trips && a0.boat.length === b0.boat.length && a0.fault && a0.fault.why === 'far',
    { farId, before: b0.boat, after: a0.boat, fault: a0.fault });

  // "Open water" has to be proved, not assumed: the middle of the canvas is exactly where a role
  // column would be painted if the far bank's grid were centred on the channel instead of on the
  // sand, and a press there then legitimately boards somebody. This computes the candidate from the
  // geometry the renderer publishes and checks it against the same reach js/view.js hit-tests with.
  const water = await runJS(`(() => {
    const f = window.ferry;
    const b = document.getElementById('lot').getBoundingClientRect();
    const bp = f.boatPoint();
    const reach = f.reach();
    const hull = { x0: bp.left - reach, x1: bp.left + bp.w + reach, y0: bp.cy - bp.h / 2 - reach, y1: bp.cy + bp.h / 2 + reach };
    const p = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height * 0.12) };
    let near = Infinity;
    for (let i = 0; i < f.state.roles; i++) {
      const rp = f.rolePoint(i);
      near = Math.min(near, Math.hypot(p.x - rp.x, p.y - rp.y));
    }
    return { p, near: Math.round(near), reach: Math.round(reach), hull,
      onHull: p.x >= hull.x0 && p.x <= hull.x1 && p.y >= hull.y0 && p.y <= hull.y1 };
  })()`);
  rec('the point about to be pressed really is open water: no role within reach, no hull under it',
    water.near > water.reach && water.onHull === false, water);
  const wBefore = await S();
  await press(water.p);
  const wAfter = await S();
  rec('pressing the open water in place does nothing',
    wAfter.trips === wBefore.trips && wAfter.boat.length === wBefore.boat.length && wAfter.bank === wBefore.bank,
    { at: water.p, trips: [wBefore.trips, wAfter.trips], boat: [wBefore.boat, wAfter.boat], bank: [wBefore.bank, wAfter.bank] });

  await load('#/lot/shoal-02'); // 自由船, two roles, par 1
  const freeHull = await point('boatPoint()');
  await press(freeHull);
  const empty = await S();
  rec("under 'free' a click on an empty boat is refused and costs no single trip",
    empty.trips === 0 && empty.law === 'free' && empty.fault && empty.fault.why === 'empty', empty);
  await board(0);
  await board(1);
  await press(await point('boatPoint()'));
  await settle();
  const doneFree = await S();
  rec("under 'free' the two of them row over together: one trip, everyone across",
    doneFree.trips === 1 && doneFree.done && doneFree.right.length === 2, doneFree);

  // ---- the other crossing gesture: haul the hull across the river -------------------
  await load('#/lot/shoal-01'); // 艄公船, capacity 3, par 1
  await board(0);
  await board(1);
  await board(2);
  const h0 = await point('boatPoint()');
  const hDock1 = await point('dockPoint(1)');
  const travel = hDock1.x - h0.x;
  const small = { x: h0.x + Math.round((hDock1.x - h0.x) * 0.2), y: h0.y };
  rec('the docks are far enough apart that "haul the boat to the far bank" is a gesture at all',
    travel >= 60 && Math.abs(travel * 0.2) > 6 && Math.abs(travel * 0.2) < travel * 0.45,
    { travel, shortHaul: Math.round(travel * 0.2), from: h0.x, to: hDock1.x });
  await drag(h0, small);
  const half = await S();
  rec('a haul that stops short of the far bank casts nobody off',
    half.trips === 0 && half.boat.length === 3,
    { trips: half.trips, boat: half.boat, travel, dragged: Math.round(travel * 0.2), done: half.done });
  const h1 = await point('boatPoint()');
  await drag(h1, { x: hDock1.x, y: h1.y });
  await settle();
  const hauled = await S();
  rec('dragging the boat across counts exactly one single trip and wins the lot',
    hauled.trips === 1 && hauled.done, hauled);
  return { rows };
}

// The keyboard channel: js/main.js:450-463 maps u/h/r/Space onto the same DOM buttons the mouse
// clicks, and Space onto `departNow()` — the very door a press on the hull uses. Each row below is
// produced by an Input.dispatchKeyEvent and by nothing else. Boarding has no keyboard gesture in
// this game, so where a row needs crew aboard the *setup* borrows the pointer drag from the kit and
// the row says so in its own name: what is asserted stays in this channel.
async function keysLeg(cdp, sessionId, runJS) {
  const { rows, rec, S, point, short, settle, press, board, load, key } =
    await makeKit(cdp, sessionId, runJS);

  // ---- h / r with an untouched lot --------------------------------------------------
  await load('#/lot/shoal-01');
  await key('h');
  await sleep(140);
  const hh = await S();
  rec('the h key hints through the same door as the button',
    hh.hints === 1 && /提示/.test(hh.line) && /艄公/.test(hh.line), { hints: hh.hints, line: hh.line });
  await key('r');
  await sleep(140);
  const hr = await S();
  rec('the r key restarts and takes the hint tally back with it',
    hr.trips === 0 && hr.boat.length === 0 && hr.hints === 0, hr);

  // ---- Space is the crossing gesture, not a decoration ------------------------------
  await load('#/lot/shoal-02'); // 自由船, two roles, par 1
  await key(' ', 'Space', 32, 'rawKeyDown');
  await sleep(160);
  const emptyKey = await S();
  rec("Space on an empty boat reaches depart() and is refused under 'free' without counting",
    emptyKey.trips === 0 && emptyKey.law === 'free' && emptyKey.fault && emptyKey.fault.why === 'empty',
    emptyKey);
  await board(0);
  await board(1);
  await key(' ', 'Space', 32, 'rawKeyDown');
  await sleep(60);
  await settle();
  const crossed0 = await S();
  rec('Space rows the loaded boat: one single trip, everyone across (crew boarded by pointer, no keyboard gesture exists for it)',
    crossed0.trips === 1 && crossed0.done === true && crossed0.right.length === 2, crossed0);
  const card = await S();
  rec('the win card is up after that crossing, which is what Escape will be pressed against',
    card.curtain === true && card.done === true, card);
  await key('Escape', 'Escape', 27, 'rawKeyDown');
  await sleep(140);
  const afterEsc = await S();
  rec('the escape key closes the curtain', afterEsc.curtain === false && afterEsc.done === true, afterEsc);

  // ---- u takes a key-crossed trip back ----------------------------------------------
  await load('#/lot/shoal-01');
  await board(0);
  await board(1);
  await key(' ', 'Space', 32, 'rawKeyDown');
  await sleep(60);
  await settle();
  const t1 = await S();
  rec('two of the three aboard still cross legally by Space and cost one trip',
    t1.trips === 1 && t1.done === false && t1.right.join(',') === '0,1', t1);
  await key('u');
  await sleep(140);
  const t2 = await S();
  rec('the u key takes that single trip back', t2.trips === 0 && t2.done === false && t2.boat.length === 0, t2);
  await board(0);
  await board(1);
  await board(2);
  const t3 = await S();
  rec('three drags fill the boat to its capacity', t3.boat.length === 3 && t3.trips === 0, t3);
  await key('r');
  await sleep(140);
  const t4 = await S();
  rec('the r key restarts: count, crew and hint tally cleared',
    t4.trips === 0 && t4.boat.length === 0 && t4.hints === 0, t4);
  await key('u');
  await sleep(140);
  const t5 = await S();
  rec('u with nothing left to undo costs nothing and moves nobody',
    t5.trips === 0 && t5.boat.length === 0 && t5.left.length === 3, { trips: t5.trips, boat: t5.boat, left: t5.left, last: await short(0) });
  return { rows };
}

// The touch channel: the same three gestures a finger gives on a phone — drag a role onto the hull,
// tap the hull, haul the hull across — sent as Input.dispatchTouchEvent and nothing else. Chrome
// turns these into pointer events with `pointerType: 'touch'`, so a row that fell back to
// dispatchMouseEvent here would be proving the mouse path twice and the touch path not at all.
async function touchLeg(cdp, sessionId, runJS) {
  const { rows, rec, S, point, settle, touch, tap, load } = await makeKit(cdp, sessionId, runJS);
  // Local helpers only ever send touch events: this leg must not reach for the mouse kit.
  const tboard = async (id) => {
    const rp = await point(`rolePoint(${id})`);
    const bp = await point('boatPoint()');
    await touch(rp.x, rp.y, bp.x, bp.y);
    return { rp, bp };
  };
  const thaul = async (from, to) => touch(from.x, from.y, to.x, to.y);

  await load('#/lot/shoal-03'); // 艄公船, capacity 3, par 3
  const start = await S();
  const plan = await runJS('window.ferry.plan()');
  rec('the touch lot loads with a certified par of 3 and a route to match it',
    start.id === 'shoal-03' && start.par === 3 && start.trips === 0 && plan.length === start.par, { start, plan });

  let counted = 0;
  for (const cargo of plan) {
    for (const id of cargo) {
      const before = await S();
      const nm = await point(`names()[${id}]`);
      await tboard(id);
      const after = await S();
      rec(`finger drags ${nm} onto the hull and it boards, no single trip spent`,
        after.boat.indexOf(id) >= 0 && after.trips === before.trips, { before: before.boat, after: after.boat });
    }
    const before = await S();
    const hull = await point('boatPoint()');
    await tap(hull.x, hull.y);
    await settle();
    const after = await S();
    counted++;
    rec(`finger tap ${counted}: one tap on the hull is exactly one single trip`,
      after.trips === before.trips + 1 && after.boat.length === 0 && after.bank !== before.bank,
      { before: before.trips, after: after.trips, bank: [before.bank, after.bank] });
  }
  const won = await S();
  rec(`the finger plays the whole certified route and no further (${plan.length} single trips)`,
    counted === start.par && won.done === true, { counted, par: start.par, trips: won.trips });
  rec('the win card goes up on the touch run too', won.curtain === true && won.stars === '★★★', { curtain: won.curtain, stars: won.stars });
  const rec0 = await runJS('window.ferry.store.record(window.ferry.state.id)');
  rec('the touch-run is on record at par and flagged perfect',
    !!rec0 && rec0.best === start.par && rec0.perfect === true, rec0);

  // ---- capacity and refusal, by finger ----------------------------------------------
  await load('#/lot/shoal-04'); // 艄公船, capacity 3, four roles
  for (const id of [0, 1, 2]) await tboard(id);
  const full = await S();
  rec('three fingers-worth of drags fill the boat to exactly its capacity',
    full.boat.length === 3 && full.trips === 0, full);
  await tboard(3);
  const over = await S();
  rec('a fourth role is refused by a real touch drag: capacity holds and nothing is counted',
    over.boat.length === 3 && over.trips === 0 && over.fault && over.fault.why === 'over',
    { boat: over.boat, trips: over.trips, fault: over.fault });
  const aboardPt = await point('rolePoint(2)');
  const bankPt = await runJS(`(() => { const b = document.getElementById('lot').getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`);
  await thaul(aboardPt, bankPt);
  const freed = await S();
  rec('dragging a role back onto the bank by touch unloads it and costs no single trip',
    freed.boat.indexOf(2) < 0 && freed.trips === 0 && freed.boat.length === 2, freed);

  // ---- a haul that stops short, and one that arrives --------------------------------
  await load('#/lot/shoal-01'); // 艄公船, capacity 3, par 1
  for (const id of [0, 1, 2]) await tboard(id);
  const h0 = await point('boatPoint()');
  const hDock1 = await point('dockPoint(1)');
  const travel = hDock1.x - h0.x;
  rec('the docks are far enough apart that "haul the boat to the far bank" is a touch gesture at all',
    travel >= 60 && Math.abs(travel * 0.2) > 6 && Math.abs(travel * 0.2) < travel * 0.45,
    { travel, shortHaul: Math.round(travel * 0.2) });
  await thaul(h0, { x: h0.x + Math.round(travel * 0.2), y: h0.y });
  const half = await S();
  rec('a touch haul that stops short of the far bank casts nobody off and counts nothing',
    half.trips === 0 && half.boat.length === 3 && half.done === false,
    { trips: half.trips, boat: half.boat, dragged: Math.round(travel * 0.2) });
  const h1 = await point('boatPoint()');
  await thaul(h1, { x: hDock1.x, y: h1.y });
  await settle();
  const hauled = await S();
  rec('the full touch haul across the river counts exactly one single trip and wins the lot',
    hauled.trips === 1 && hauled.done === true, hauled);
  return { rows };
}

// Three channels, one report: `tools/verify.sh` runs the browser suite as `eval @pointer`, so this
// is where the legs get aggregated. Each row carries its channel in its name — a green from the
// mouse path and a green from the touch path must not read as the same line.
const INPUT_LEGS = { mouse: mouseLeg, touch: touchLeg, keys: keysLeg };

// In-page suites. Each returns { rows: [{ test, pass, detail }] }.
const SCENARIOS = {
  boot: `(async () => {
    const f = window.ferry;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    rec('the shell boots straight into a crossing', f && f.version === 1 && f.state.mode === 'campaign' && !!f.state.id, f && f.state);
    const c = document.getElementById('lot');
    rec('the canvas has real pixels, not the 300x150 default', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    const lit = (() => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    })();
    rec('the river was actually painted (water, banks, hull)', lit > 200, { litSamples: lit });
    const pool = f.pool;
    rec('the baked pool loaded', pool && pool.lots >= 24, pool && pool.lots);
    const bands = Object.values(pool.byTier);
    rec('four bands, each with both dimensions measured', bands.length === 4 && bands.every((t) => t.n > 0 && t.parMin <= t.parMax && t.rolesMin >= 2 && t.statesMax > 0), pool.byTier);
    rec('the bands do not overlap', (() => {
      const order = Object.keys(pool.byTier);
      const sorted = order.slice().sort((a, b) => pool.byTier[a].parMin - pool.byTier[b].parMin);
      for (let i = 1; i < sorted.length; i++) if (pool.byTier[sorted[i - 1]].parMax >= pool.byTier[sorted[i]].parMin) return false;
      return true;
    })(), Object.keys(pool.byTier));
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints the boat law, par, trips used and the optimal route count',
      /船的法/.test(readout) && /最少/.test(readout) && /单程/.test(readout) && /最优路线/.test(readout) && /第几渡/.test(readout), readout);
    rec('the panel prints the route hash for this lot', /#\\/(c|lot|daily|random)/.test(document.getElementById('crumbs').textContent), document.getElementById('crumbs').textContent);
    rec('the legend lists every role of the cast', document.querySelectorAll('#legend .chip').length === f.state.roles, { chips: document.querySelectorAll('#legend .chip').length, roles: f.state.roles });
    rec("the browser's own BFS agrees with the printed par", f.plan().length === f.state.par, { plan: f.plan().length, par: f.state.par });
    rec('no ghost: the hook exposes the pool, the laws and the store', !!(f.pool && f.laws && f.store && f.laws.ferry && f.laws.free), f.laws);
    return { rows };
  })()`,

  play: `(async () => {
    const f = window.ferry;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const url = (p) => new URL(p, location.href).href;

    f.store.reset();
    f.load('#/lot/shoal-03'); await sleep(120);
    rec('a lot loads with a certified par and a planned route of the same length',
      f.state.par === 3 && f.plan().length === 3 && f.state.routes === 2, f.state);

    // The measurement the whole repo rests on, re-run here in the browser from the serialized
    // data file: every printed par and every printed route count, recomputed by BFS.
    const { solve } = await import(url('./js/core/solve.js'));
    const { LOTS } = await import(url('./js/data/lots.js'));
    const bad = [];
    for (const row of LOTS) {
      const r = solve(row.spec, { limit: 200000 });
      if (!r.ok || r.par !== row.par || r.routes !== row.routes || r.truncated) {
        bad.push({ id: row.id, par: r.par, want: row.par, routes: r.routes, wantRoutes: row.routes, truncated: r.truncated });
      }
    }
    rec('all ' + LOTS.length + ' baked lines re-solve from the serialized spec to the printed par, route count and no truncation',
      LOTS.length >= 24 && bad.length === 0, bad);

    // The two boat laws, each with its own assertion, through the same doors as a finger.
    f.load('#/lot/shoal-03'); await sleep(120);
    const p = f.plan();
    f.play([p[0]]);
    const before = f.state.trips;
    f.board(0);
    const solo = f.cross();
    rec("under 'ferry' the boatman crossing alone is legal and costs exactly one single trip",
      solo.ok === true && solo.cargo.length === 1 && f.state.trips === before + 1, { solo, before, after: f.state.trips });

    f.load('#/lot/shoal-02'); await sleep(120);
    const empty = f.cross();
    rec("under 'free' an empty boat is refused and costs nothing",
      empty.ok === false && empty.why === 'empty' && f.state.trips === 0 && f.state.boat.length === 0, empty);

    f.load('#/lot/shoal-06'); await sleep(120); // 自由船, capacity 2, three roles
    f.board(0); f.board(1);
    const over = f.board(2);
    rec('over capacity is refused: the boat keeps its crew and no trip is counted',
      over.ok === false && over.why === 'over' && f.state.boat.length === 2 && f.state.trips === 0, { over, boat: f.state.boat });
    f.unboard(1);
    const room = f.board(2);
    rec('making room lets the third role aboard, still without a trip', room.ok === true && f.state.trips === 0, room);

    f.load('#/lot/shoal-04'); await sleep(120);
    f.board(0); f.board(3);
    const bad2 = f.cross();
    rec('a crossing that strands 狼+羊 is refused and says which two roles, on which bank, at which moment',
      bad2.ok === false && bad2.why === 'conflict' && bad2.where === 'departure'
        && bad2.conflict.roles.slice().sort().join(',') === '1,2' && f.state.trips === 0,
      { why: bad2.why, where: bad2.where, roles: bad2.conflict && bad2.conflict.roles, trips: f.state.trips });

    f.load('#/lot/shoal-03'); await sleep(120);
    const waste = [[0, 2], [0], [0], [0], [0, 1]];
    const res = f.play(waste);
    rec('a legal but wasteful five-trip route still lands, at two stars',
      res.done === true && f.state.trips === 5 && f.state.stars === '★★☆' && f.state.verdict === '稳操渡桨',
      { steps: res.steps, trips: f.state.trips, stars: f.state.stars, verdict: f.state.verdict });

    f.load('#/lot/shoal-03'); await sleep(120);
    f.play(f.plan());
    rec('the win card counts trips, par and route lines from the measurement',
      f.state.done && /你的/.test(D('tally').textContent) && /最优路线/.test(D('tally').textContent), D('tally').textContent);

    f.load('#/lot/shoal-03'); await sleep(150);
    const h = f.hintOnce();
    rec('the hint names who to load and the searched remainder',
      h.hints === 1 && /提示/.test(h.line) && /还需 3 单程/.test(h.line) && /艄公/.test(h.line), h);

    f.load('#/lot/ford-01'); await sleep(150);
    const t1 = f.play(f.plan().slice(0, 1)).trips;
    const undid = f.undoStep();
    rec('退回 takes the single trip back to zero', t1 === 1 && undid === 0, { t1, undid });
    return { rows };
  })()`,

  routes: `(async () => {
    const f = window.ferry;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const url = (p) => new URL(p, location.href).href;

    f.store.reset();
    f.load('#/c/7'); await sleep(140);
    rec('#/c/7 is the seventh crossing', f.state.index === 7 && f.state.mode === 'campaign' && f.state.trips === 0, f.state);
    f.load('#/c/99999'); await sleep(140);
    rec('a huge index clamps to the last crossing', f.state.index === f.state.levels, { index: f.state.index, levels: f.state.levels });
    f.load('#/c/0'); await sleep(140);
    rec('index zero clamps up to one', f.state.index === 1, f.state.index);

    f.load('#/daily'); await sleep(140);
    const daily = f.state.id;
    const day = f.state.daily;
    f.load('#/c/1'); await sleep(140);
    f.load('#/daily'); await sleep(140);
    rec('the daily route is the same crossing twice', f.state.mode === 'daily' && f.state.id === daily, { first: daily, again: f.state.id });
    rec('the daily label carries the date', new RegExp('^每日迷津 · \\\\d{4}-\\\\d{2}-\\\\d{2}$').test(f.state.label), f.state.label);
    const { LOTS } = await import(url('./js/data/lots.js'));
    const seed = f.seedOf('daily|' + day);
    rec('the daily crossing is LOTS[hashSeed("daily|YYYY-MM-DD") % n], recomputed here from the data file',
      f.state.id === LOTS[seed % LOTS.length].id && f.state.seed.indexOf(String(seed)) >= 0,
      { day, seed, want: LOTS[seed % LOTS.length].id, got: f.state.id, printed: f.state.seed });
    rec('the panel prints the #/daily route', /#\\/daily/.test(f.state.hash), f.state.hash);

    for (const tier of Object.keys(f.pool.byTier)) {
      f.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      const first = f.state.id;
      f.load('#/c/1'); await sleep(140);
      f.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      rec('#/random/' + tier + ' stays in its band and repeats itself',
        f.state.tier === tier && f.state.id === first, { tier: f.state.tier, id: f.state.id, first });
    }
    f.load('#/random'); await sleep(240);
    rec('a bare #/random mints a token into the URL', /^#\\/random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);

    f.load('#/c/5'); await sleep(140);
    const sample = f.state.id;
    f.load('#/c/1'); await sleep(140);
    f.load('#/lot/' + sample); await sleep(140);
    rec('#/lot/<id> opens that crossing', f.state.id === sample && f.state.mode === 'lot', { want: sample, got: f.state.id });
    rec('#/lot/<id> prints the route in the panel', f.state.hash === '#/lot/' + sample, f.state.hash);
    f.load('#/lot/not-a-real-lot'); await sleep(140);
    rec('an unknown lot id falls back instead of blanking the river', !!f.state.id && f.state.mode === 'lot' && f.state.par >= 1, f.state);

    f.load('#/lot/shoal-02'); await sleep(140);
    rec('the printed law follows the data, not the other way round', f.state.law === 'free' && /自由船/.test(f.state.readout), { law: f.state.law });
    f.load('#/lot/shoal-03'); await sleep(140);
    rec('an identical cast under the other law reads differently', f.state.law === 'ferry' && /艄公船/.test(f.state.readout), { law: f.state.law });
    return { rows };
  })()`,

  save: `(async () => {
    const f = window.ferry;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'ferry.save.v1';

    f.store.reset();
    f.load('#/c/1'); await sleep(160);
    rec('a wiped save is empty', Object.keys(f.store.records).length === 0 && f.store.unlocked === 1, { unlocked: f.store.unlocked, stats: f.store.stats });

    f.hintOnce();
    f.play(f.plan());
    await sleep(160);
    const hinted = f.store.record(f.state.id);
    rec('a hinted run is billed and is NOT granted the perfect flag',
      hinted.best === f.state.par && hinted.perfect === false && f.store.stats.hints === 1 && f.store.stats.perfect === 0,
      { hinted, hints: f.store.stats.hints, perfect: f.store.stats.perfect });
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage, not only memory', !!(raw && raw.records[f.state.id] && raw.records[f.state.id].best === 1), raw && Object.keys(raw.records || {}));
    rec('clearing the first crossing unlocks the second', f.store.unlocked === 2 && raw.unlocked === 2, { unlocked: f.store.unlocked });
    const shelf2 = D('shelf').querySelector("button[data-index='2']");
    rec('the shelf lets crossing 2 be clicked', !!shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML);

    // best only goes down, perfect only goes in, plays only goes up — the three monotonicities
    // test/storage.test.mjs pins in the abstract, here against a real browser record.
    f.load('#/lot/shoal-03'); await sleep(160);
    f.play([[0, 2], [0], [0], [0], [0, 1]]); // five legal trips where three would do
    await sleep(160);
    const sloppy = f.store.record('shoal-03');
    rec('over par records the number but not the flag',
      sloppy.best === 5 && sloppy.perfect === false && f.store.stats.perfect === 0, { sloppy, perfect: f.store.stats.perfect });
    f.load('#/lot/shoal-03'); await sleep(160);
    f.play(f.plan());
    await sleep(160);
    const tight = f.store.record('shoal-03');
    rec('matching par later takes the record down and earns the flag',
      tight.best === 3 && tight.perfect === true && tight.plays === 2 && f.store.stats.perfect === 1, { tight, perfect: f.store.stats.perfect });
    f.load('#/lot/shoal-03'); await sleep(160);
    f.play([[0, 2], [0], [0], [0], [0, 1]]);
    await sleep(160);
    const again = f.store.record('shoal-03');
    rec('a worse replay never takes the record up and the flag stays put',
      again.best === 3 && again.perfect === true && again.plays === 3 && f.store.stats.perfect === 1, { again, perfect: f.store.stats.perfect });

    f.load('#/daily'); await sleep(160);
    const day = f.state.daily;
    f.play(f.plan());
    await sleep(160);
    const mark = f.store.dailyDone(day);
    rec('today is logged once crossed', !!mark && mark.id === f.state.id, { day, mark });
    rec('the shelf says today is done', /今天已渡/.test(D('shelf').textContent), D('shelf').textContent.slice(0, 120));

    D('wipe').click(); await sleep(80);
    const armed = Object.keys(f.store.records).length;
    rec('the first wipe click only arms it', armed > 0, { armed });
    D('wipe').click(); await sleep(220);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(f.store.records).length === 0 && f.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(f.store.records), unlocked: f.store.unlocked, key: localStorage.getItem(KEY) });
    rec('the totals line follows the wipe', /已渡 0\\//.test(D('totals').textContent), D('totals').textContent);
    return { rows };
  })()`,
  // Reads back what the previous document wrote: the four rows below all live in a document that
  // `witness` + this call's own navigation put there, so a stale page cannot fake them.
  readback: `(async () => {
    const f = window.ferry;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const w = window.__witness;
    rec('the harness handed this document a witness from the one before it', !!w && typeof w.t === 'number' && typeof w.u === 'string', { witness: w || null, here: performance.timeOrigin });
    rec('this is a new document, not the same one re-read', !!w && performance.timeOrigin !== w.t, { before: w && w.t, after: performance.timeOrigin });
    rec('the shell rebuilt itself in it (hook, route, lot)', !!(f && f.version === 1 && f.state && f.state.id && f.pool && f.pool.lots >= 24), f && f.state && { id: f.state.id, mode: f.state.mode, lots: f.pool.lots });
    const records = Object.keys(f.store.records);
    rec('the save written before the reload is still there after it', records.length > 0, { records: records.length, sample: f.store.records[records[0]] || null, key: localStorage.getItem('ferry.save.v1') ? 'present' : 'absent' });
    return { rows };
  })()`,

};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
