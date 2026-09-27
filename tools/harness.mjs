// Tiny zero-dep test harness: every tools/../test/*.mjs suite prints the same shape so
// verify.sh can aggregate them.

const rows = [];

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    // `HARNESS_STACK=1 node test/x.test.mjs` for the throw site; the one-line detail is what
    // verify.sh and CI print, and a stack would bury the other rows.
    const detail = process.env.HARNESS_STACK && err && err.stack ? String(err.stack) : String((err && err.message) || err);
    rows.push({ test: name, pass: false, detail });
  }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

export function run() {
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  console.log(`rows: ${rows.length} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}
