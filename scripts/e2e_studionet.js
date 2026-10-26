#!/usr/bin/env node
/**
 * End to end run of GlossaryGuard on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * One real job: a short English source, a Vietnamese translation that reads fine
 * but breaks two of the four glossary terms, and one review round run by a second
 * account to show the review is permissionless.
 *
 *   create      the owner registers the source, the translation and the glossary
 *   check       a different account runs the round; the validators read the page
 *   duplicate   the same job id again: refused by the contract, nothing overwritten
 *   stats       jobs, checks and the grade tally
 *
 * Nothing is asserted about which terms the validator set flags — that is the
 * reading it was asked to do. The script prints what came back and compares it
 * with what a human reader of this fixture expects.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEYFILE = path.join(__dirname, ".e2e-keys.json");
function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { owner: generatePrivateKey(), reviewer: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const owner = createAccount(k.owner);
const reviewer = createAccount(k.reviewer || generatePrivateKey());
const ownerClient = createClient({ chain: studionet, account: owner });
const reviewerClient = createClient({ chain: studionet, account: reviewer });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Studio's RPC intermittently answers with an HTML error page or drops the
// connection; every write and receipt wait goes through this.
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(msg)) throw e;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function send(client, who, functionName, args) {
  console.log(`\n[${who}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 60)).join(", ")})`);
  const hash = await withRetry(
    () => client.writeContract({ address: ADDRESS, functionName, args, value: 0n }),
    "send"
  );
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 }),
    "receipt"
  );
  const verdict = refused(receipt) ? "refused by the contract" : "executed";
  console.log(`  ${receipt.status_name || receipt.status}  (${verdict})`);
  return { hash, refused: refused(receipt) };
}

async function write(client, who, functionName, args) {
  const { hash, refused: reverted } = await send(client, who, functionName, args);
  if (reverted) throw new Error(`${functionName} failed inside the contract`);
  return hash;
}

const read = (functionName, args) =>
  withRetry(() => reader.readContract({ address: ADDRESS, functionName, args }), "read");

// A page a real translator would hand back: fluent Vietnamese, two wrong terms.
const SOURCE = [
  "Add the item to your cart, continue to checkout, and you will receive an invoice by email.",
  "Refunds are available within 30 days of delivery.",
].join(" ");

const TRANSLATION = [
  "Thêm sản phẩm vào giỏ hàng, tiếp tục thanh toán và bạn sẽ nhận được biên lai qua email.",
  "Bạn có thể trả lại tiền trong vòng 30 ngày kể từ khi nhận hàng.",
].join(" ");

// Two terms are rendered as required (1, 2); two are not (3, 4).
const GLOSSARY = [
  "checkout => thanh toán",
  "cart => giỏ hàng",
  "invoice => hoá đơn",
  "refund => hoàn tiền",
].join("\n");

(async () => {
  const jobId = process.argv[3] || `page-${Date.now().toString(36)}`;
  console.log("contract", ADDRESS);
  console.log("job     ", jobId);
  console.log("owner   ", owner.address);
  console.log("reviewer", reviewer.address);

  console.log("\n[validators] glossary");
  console.log(GLOSSARY.replace(/^/gm, "  "));
  console.log("  expected by a human reader: terms 3 and 4 (invoice, refund)");

  await write(ownerClient, "owner", "create_job", [jobId, SOURCE, TRANSLATION, GLOSSARY]);

  let job = await read("get_job", [jobId]);
  console.log(`\n  terms ${job.term_count} | checks ${job.checks} | grade ${JSON.stringify(job.grade)}`);

  console.log("\n[reviewer] check_job (anyone may run a round)");
  const t0 = Date.now();
  await write(reviewerClient, "reviewer", "check_job", [jobId]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);

  job = await read("get_job", [jobId]);
  console.log(`  violated term ids: [${job.violations.join(", ")}]`);
  console.log(`  violations ${job.violation_count} | fluency ${job.fluency} | grade ${job.grade}`);
  console.log(`  caller of the round: ${job.caller}`);
  console.log(`  reason: ${job.reason}`);
  const expected = [3, 4];
  const same =
    job.violations.length === expected.length && job.violations.every((n, i) => n === expected[i]);
  console.log(
    same
      ? "  the validator set flagged exactly the two terms a human reader would"
      : "  note: the validator set read the page differently from the human fixture"
  );

  if (job.checks !== 1) throw new Error(`expected one stored check, got ${job.checks}`);
  if (!["pass", "minor", "fail"].includes(job.grade)) {
    throw new Error(`unexpected grade ${job.grade}`);
  }
  const cleared = await read("is_cleared", [jobId]);
  console.log(`  is_cleared: ${cleared}`);

  console.log("\n[guard] the same job id again");
  const { refused: reverted } = await send(ownerClient, "owner", "create_job", [
    jobId,
    SOURCE,
    TRANSLATION,
    GLOSSARY,
  ]);
  if (!reverted) throw new Error("a duplicate job id was accepted");
  job = await read("get_job", [jobId]);
  console.log(`  after the refusal: checks ${job.checks} | grade ${job.grade}`);
  if (job.checks !== 1) throw new Error("a refused create moved the job");

  console.log("\nhistory");
  for (const check of await read("checks_of", [jobId])) {
    console.log(
      `  seq ${check.seq} by ${check.caller.slice(0, 10)}… -> [${check.violations.join(", ")}] ` +
        `fluency ${check.fluency} grade ${check.grade}`
    );
  }

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));

  console.log(
    "\nRESULT: one job created, one consensus round stored, grade computed from the reported set, duplicate id refused"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
