import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_ENV,
  applyAccount,
  pickAccount,
  withAccountFailover
} from "../plugins/codex/scripts/lib/switcheroo.mjs";

const fakeRun = (answer) => () => answer;
const picked = (name) => ({ name, home: `/homes/${name}`, weeklyLeftPct: 80 });

test("pickAccount: routing is off without switcheroo or accounts, and loud when nothing is usable", () => {
  assert.equal(pickAccount([], fakeRun({ error: { code: "ENOENT" } })), null);
  assert.equal(pickAccount([], fakeRun({ status: 0, stdout: '{"unmanaged":true}' })), null);
  assert.deepEqual(pickAccount([], fakeRun({ status: 0, stdout: JSON.stringify(picked("lp96")) })), picked("lp96"));
  assert.throws(
    () => pickAccount([], fakeRun({ status: 1, stdout: '{"error":"no codex account with headroom left"}' })),
    /no codex account with headroom left/
  );
});

test("applyAccount: an explicit CODEX_HOME wins, a parent's pick is inherited, otherwise switcheroo decides", () => {
  const never = () => assert.fail("must not re-pick");
  assert.equal(applyAccount({ CODEX_HOME: "/mine" }, never), null);
  assert.equal(applyAccount({ CODEX_HOME: "/homes/a", [ACCOUNT_ENV]: "a" }, never).inherited, true);

  const env = {};
  applyAccount(env, () => picked("lp96"));
  assert.equal(env.CODEX_HOME, "/homes/lp96");
  assert.equal(env[ACCOUNT_ENV], "lp96");
});

test("withAccountFailover: a usage-limit failure retries once on the next account; other failures do not", async () => {
  const env = { CODEX_HOME: "/homes/a", [ACCOUNT_ENV]: "a" };
  const homes = [];
  const run = async () => {
    homes.push(env.CODEX_HOME);
    return homes.length === 1 ? { status: 1, error: { message: "You've hit your usage limit." } } : { status: 0 };
  };
  const logs = [];
  const result = await withAccountFailover(run, { env, pick: (exclude) => (exclude.includes("a") ? picked("b") : null), log: (l) => logs.push(l) });

  assert.equal(result.status, 0);
  assert.deepEqual(homes, ["/homes/a", "/homes/b"]);
  assert.match(logs[0], /a hit its usage limit — retrying once on b/);

  let calls = 0;
  await withAccountFailover(async () => ({ status: 1, error: { message: "boom" }, calls: ++calls }), { env, pick: () => picked("c"), log: () => {} });
  assert.equal(calls, 1);
});
