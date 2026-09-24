import { spawnSync } from "node:child_process";

/**
 * Account routing through claude-switcheroo (henderson-tech fork).
 *
 * Every Codex run bills the account `switcheroo codex pick` names — the one with
 * the most headroom — instead of whatever login `~/.codex` happens to hold. The
 * choice travels to child processes (task worker, broker, app-server) through
 * CODEX_HOME plus this marker, so a job keeps the account it started on.
 */
export const ACCOUNT_ENV = "SWITCHEROO_CODEX_ACCOUNT";

const USAGE_LIMIT_RE = /usage limit/i;

/**
 * Ask switcheroo for the best account. null when switcheroo is not installed:
 * the plugin then behaves exactly like upstream. Installed but nothing usable
 * throws — billing a guessed account is the failure this exists to prevent.
 */
export function pickAccount(exclude = [], run = spawnSync) {
  const args = ["codex", "pick", "--json"];
  if (exclude.length > 0) {
    args.push("--exclude", exclude.join(","));
  }

  const result = run("switcheroo", args, { encoding: "utf8", timeout: 30000 });
  if (result.error?.code === "ENOENT") {
    return null;
  }
  if (result.error) {
    throw new Error(`switcheroo codex pick failed: ${result.error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    throw new Error(`switcheroo codex pick returned no JSON: ${String(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }
  if (result.status !== 0 || parsed.error) {
    throw new Error(`switcheroo: ${parsed.error ?? `codex pick exited ${result.status}`}`);
  }
  // No switcheroo Codex account registered: nothing to route between.
  if (parsed.unmanaged) {
    return null;
  }
  if (!parsed.name || !parsed.home) {
    throw new Error("switcheroo codex pick returned no account.");
  }
  return parsed;
}

/**
 * Route this process (and everything it spawns) onto an account. A CODEX_HOME
 * set WITHOUT the marker is the caller's explicit choice and wins; one set WITH
 * it was picked by a parent run, so it is kept rather than re-picked.
 */
export function applyAccount(env = process.env, pick = pickAccount) {
  if (env[ACCOUNT_ENV]) {
    return { name: env[ACCOUNT_ENV], home: env.CODEX_HOME, inherited: true };
  }
  if (env.CODEX_HOME) {
    return null;
  }

  const account = pick();
  if (account) {
    env.CODEX_HOME = account.home;
    env[ACCOUNT_ENV] = account.name;
  }
  return account;
}

/** Move to the next account after the current one ran out; null when none is left or routing is off. */
export function failoverAccount(env = process.env, pick = pickAccount) {
  const current = env[ACCOUNT_ENV];
  if (!current) {
    return null;
  }

  let next;
  try {
    next = pick([current]);
  } catch {
    return null;
  }
  if (!next) {
    return null;
  }
  env.CODEX_HOME = next.home;
  env[ACCOUNT_ENV] = next.name;
  return next;
}

export function isUsageLimitFailure(result) {
  if (!result || result.status === 0) {
    return false;
  }
  const message = `${result.error?.message ?? ""}\n${result.stderr ?? ""}`;
  return USAGE_LIMIT_RE.test(message);
}

/**
 * Run a Codex turn; when it dies on the account's usage limit, retry it once on
 * the next account and say so. `run` must read CODEX_HOME at call time.
 */
export async function withAccountFailover(run, { env = process.env, pick = pickAccount, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const first = await run();
  if (!isUsageLimitFailure(first)) {
    return first;
  }

  const spent = env[ACCOUNT_ENV];
  const next = failoverAccount(env, pick);
  if (!next) {
    return first;
  }
  log(`codex account ${spent} hit its usage limit — retrying once on ${next.name} (${next.weeklyLeftPct ?? "?"}% weekly left)`);
  return run();
}
