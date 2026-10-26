import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0x39DdFaEbcFcDEA9973eA5dE4eF5A615DDE767eBb";
const EXPLORER = `https://explorer-studio.genlayer.com/address/${CONTRACT}`;
const KEY_SLOT = "glossaryguard.keys";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let logTimer;
function log(msg) {
  const box = $("log");
  box.textContent = msg;
  box.style.display = "block";
  clearTimeout(logTimer);
  logTimer = setTimeout(() => (box.style.display = "none"), 8000);
}

function loadKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SLOT) || "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && k) : [];
  } catch {
    return [];
  }
}

let keys = loadKeys();
if (!keys.length) {
  keys = [generatePrivateKey()];
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
}
let active = 0;
let account = createAccount(keys[0]);
let me = String(account.address);
let client = createClient({ chain: studionet, account });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "");

function useKey(i) {
  active = i;
  account = createAccount(keys[i]);
  me = String(account.address);
  client = createClient({ chain: studionet, account });
  paintKey();
  refresh();
}

function paintKey() {
  const sel = $("acting");
  sel.replaceChildren();
  keys.forEach((k, i) => {
    const o = el("option", "", `key ${i + 1} · ${short(String(createAccount(k).address))}`);
    o.value = String(i);
    sel.append(o);
  });
  sel.value = String(active);
  $("addr").textContent = short(me);
  $("walletchip").textContent = `key ${active + 1} · ${short(me)}`;
}

$("contractlink").textContent = short(CONTRACT);
$("contractlink").href = EXPLORER;
paintKey();
$("acting").onchange = (e) => useKey(Number(e.target.value) || 0);

$("genkey").onclick = () => {
  keys.push(generatePrivateKey());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
  log("new key added");
};

$("importkey").onclick = () => {
  const k = prompt("Private key (0x…)");
  if (!k) return;
  keys.push(k.trim());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
};

const SAMPLE = {
  source: "Add the item to your cart, continue to checkout, and you will get an invoice by email. You can ask for a refund within 30 days.",
  target: "Thêm sản phẩm vào giỏ hàng, tiếp tục thanh toán và bạn sẽ nhận được hoá đơn qua email. Bạn có thể yêu cầu hoàn tiền trong vòng 30 ngày.",
  wrong: "Thêm sản phẩm vào giỏ, tiếp tục mua và bạn sẽ nhận được hoá đơn qua email. Bạn có thể yêu cầu hoàn tiền trong vòng 30 ngày.",
  glossary: "cart => giỏ hàng\ncheckout => thanh toán\ninvoice => hoá đơn\nrefund => hoàn tiền",
};

$("sample").onclick = () => {
  $("src").value = SAMPLE.source;
  $("tgt").value = SAMPLE.wrong;
  $("gloss").value = SAMPLE.glossary;
  log("sample loaded: two terms are weakened (giỏ, mua)");
};

async function read(functionName, args) {
  return reader.readContract({ address: CONTRACT, functionName, args });
}

async function send(functionName, args) {
  log(`${functionName}: signing`);
  const hash = await client.writeContract({ address: CONTRACT, functionName, args, value: 0n });
  log(`${functionName}: ${hash.slice(0, 12)}… waiting for the round`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 });
  const leader = (receipt && receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  if (String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR") {
    throw new Error("the contract refused this call");
  }
  log(`${functionName}: done`);
  await refresh();
  return hash;
}

function when(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

function actionButton(label, cls, fn) {
  const b = el("button", `small ${cls}`, label);
  b.onclick = async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      log(String((e && e.message) || e).slice(0, 220));
    } finally {
      b.disabled = false;
    }
  };
  return b;
}

function renderStats(stats) {
  const host = $("stats");
  host.replaceChildren();
  const grades = (stats && stats.grades) || {};
  const cells = [
    ["Reviews", (stats && stats.jobs) || 0],
    ["Checks", (stats && stats.checks) || 0],
    ["Pass", grades.pass || 0],
    ["Fail", grades.fail || 0],
  ];
  for (const [label, value] of cells) {
    const box = el("div", "stat");
    box.append(el("span", "", label));
    box.append(el("b", "num", String(value)));
    host.append(box);
  }
}

function renderTerms(job) {
  const table = el("table", "terms");
  const head = el("tr");
  ["#", "glossary term", "required"].forEach((h) => head.append(el("th", "", h)));
  table.append(head);
  const missing = new Set(job.violations || []);
  for (const term of job.terms || []) {
    const row = el("tr", missing.has(term.n) ? "miss" : "");
    row.append(el("td", "num", String(term.n)));
    const cell = el("td", "", term.source);
    row.append(cell);
    const req = el("td", "", term.translation);
    if (missing.has(term.n)) req.append(el("span", "tag", "missing"));
    else if (job.checks > 0) req.append(el("span", "tag ok", "used"));
    row.append(req);
    table.append(row);
  }
  return table;
}

function renderTexts(job) {
  const box = el("div", "texts");
  const left = el("div", "textbox");
  left.append(el("span", "", "source"));
  left.append(document.createTextNode(job.source_text));
  const right = el("div", "textbox");
  right.append(el("span", "", "translation"));
  right.append(document.createTextNode(job.target_text));
  box.append(left, right);
  return box;
}

async function loadHistory(card, jobId) {
  const box = el("div", "history");
  box.append(el("div", "", "loading…"));
  card.append(box);
  try {
    const history = await read("checks_of", [jobId]);
    box.replaceChildren();
    if (!history.length) box.append(el("div", "", "no checks yet"));
    for (const check of history) {
      const line = el("div", "line");
      const missing = (check.violations || []).length ? ` · missing ${check.violations.join(", ")}` : "";
      line.append(document.createTextNode(`#${check.seq} · ${check.grade} · ${check.fluency}${missing} · ${when(check.checked_at)} · ${short(check.caller)}`));
      box.append(line);
    }
  } catch (e) {
    box.replaceChildren(el("div", "", String((e && e.message) || e).slice(0, 160)));
  }
}

function renderJob(job) {
  const card = el("div", "job");
  const head = el("div", "meta");
  head.append(el("span", `pill ${job.grade || "none"}`, job.checks ? job.grade : "unchecked"));
  if (job.checks) head.append(el("span", `pill ${job.fluency}`, `fluency ${job.fluency}`));
  head.append(el("span", "pill", `${job.term_count} terms`));
  head.append(el("span", "pill", `${job.checks} check${job.checks === 1 ? "" : "s"}`));
  card.append(head);

  card.append(el("h3", "", `${job.id} · ${job.owner === me ? "your review" : short(job.owner)}`));
  card.append(renderTerms(job));
  if (job.checks) {
    card.append(el("div", "kv", `missing ${job.violation_count} of ${job.term_count} · graded by the contract at check #${job.latest_seq}`));
    if (job.reason) {
      const reason = el("div", "reason");
      reason.append(el("b", "", "why"));
      reason.append(document.createTextNode(job.reason));
      card.append(reason);
    }
  }
  card.append(renderTexts(job));

  const actions = el("div", "actions");
  actions.append(actionButton(job.checks ? "Run another check" : "Run the check", "primary", () => send("check_job", [job.id])));
  actions.append(actionButton("History", "", () => loadHistory(card, job.id)));
  card.append(actions);
  return card;
}

function showBanner(message) {
  const box = $("banner");
  box.replaceChildren();
  box.append(document.createTextNode(message));
  const retry = el("button", "", "Retry");
  retry.onclick = () => {
    box.style.display = "none";
    refresh();
  };
  box.append(retry);
  box.style.display = "flex";
}

async function refresh() {
  try {
    const [jobs, stats] = await Promise.all([read("list_jobs", [0, 30]), read("stats", [])]);
    $("banner").style.display = "none";
    renderStats(stats || {});
    const host = $("jobs");
    host.replaceChildren();
    if (!jobs || !jobs.length) {
      const empty = el("div", "card");
      empty.append(el("div", "hint", "No review yet. Fill the sample and create one."));
      host.append(empty);
    }
    for (const job of jobs || []) host.append(renderJob(job));
    $("jobsub").textContent = `${(jobs || []).length} on this contract, newest first.`;
  } catch (e) {
    const message = String((e && e.message) || e);
    if (/rate limit/i.test(message)) {
      showBanner("The public Studio RPC is rate limited right now, so the review list could not be read. The reviews are on chain, not in this tab.");
    } else {
      showBanner(`Could not read the contract: ${message.slice(0, 140)}`);
    }
    log("read failed, see the banner above");
  }
}

$("create").onclick = async () => {
  const button = $("create");
  const source = $("src").value.trim();
  const target = $("tgt").value.trim();
  const glossary = $("gloss").value.trim();
  if (!source || !target || !glossary) {
    log("source, translation and glossary are all required");
    return;
  }
  const id = `rev-${Date.now().toString(36)}`;
  button.disabled = true;
  try {
    await send("create_job", [id, source, target, glossary]);
    $("src").value = "";
    $("tgt").value = "";
    $("gloss").value = "";
  } catch (e) {
    log(String((e && e.message) || e).slice(0, 220));
  } finally {
    button.disabled = false;
  }
};

refresh();
setInterval(refresh, 45000);
