const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { execSync } = require("child_process");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const RPC_URL = "https://studio.genlayer.com/api";

globalThis.fetch = (url, opts = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = Object.assign({}, opts.headers || {});
    if (!headers["User-Agent"] && !headers["user-agent"]) {
      headers["User-Agent"] = BROWSER_UA;
    }
    if (body && !headers["content-length"] && !headers["Content-Length"]) {
      headers["content-length"] = body.length;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) h.append(k, item);
            } else if (v !== undefined) {
              h.set(k, String(v));
            }
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || "",
            headers: h,
            text: async () => text,
            json: async () => JSON.parse(text),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ROOT_DIR = path.resolve(__dirname, "..");
const STATE_FILE = path.join(__dirname, "state.json");
const ROOT_MANIFEST_FILE = path.join(ROOT_DIR, "release_manifest.json");
const ARTIFACT_MANIFEST_FILE = path.join(ROOT_DIR, "artifacts", "release_manifest.json");
const RUNNER = "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6";
const REPO_PREFIX = "https://raw.githubusercontent.com/Kanezar3/Cure-Latch/";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function normalizeOnChainCode(codeResp) {
  if (typeof codeResp !== "string") return "";
  if (codeResp.startsWith("0x")) {
    return Buffer.from(codeResp.slice(2), "hex").toString("utf8");
  }
  return codeResp;
}

function normalizeReturn(val) {
  if (typeof val === "string") {
    const s = val.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s;
  }
  return val;
}

async function rpcCall(method, params) {
  const resp = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await resp.json();
  if (data.error) {
    throw new Error(`RPC ${method} error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function getBalanceWei(address) {
  const hex = await rpcCall("eth_getBalance", [address, "latest"]);
  return BigInt(hex).toString();
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

async function waitForFinalized(client, hash, label, expectFailure = false) {
  let acceptedSeen = false;
  const observedStatuses = [];
  const maxAttempts = 150;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tx = await client.getTransaction({ hash });
      const status = String(tx.statusName || tx.status || "");
      if (status && observedStatuses[observedStatuses.length - 1] !== status) {
        observedStatuses.push(status);
      }
      if (
        ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "1", "2", "3", "4", "5", "6"].includes(status)
      ) {
        acceptedSeen = true;
      }
      if (status === "FINALIZED" || status === "7") {
        const lr = tx.consensus_data?.leader_receipt?.[0] || {};
        const execResult = lr.execution_result || tx.txExecutionResultName || "";
        const rawPayload = lr.result?.payload?.readable ?? lr.result?.payload ?? "";
        const returnPayload = normalizeReturn(rawPayload);
        const stderr = lr.genvm_result?.stderr || lr.error || "";
        const votes = tx.consensus_data?.votes || {};
        if (!acceptedSeen && votes && Object.keys(votes).length > 0) {
          acceptedSeen = true;
        }
        const resultName = tx.resultName || tx.result_name || String(tx.result || "");
        const contractAddress =
          tx.to_address || tx.contract_address || (tx.data && tx.data.contract_address) || "";

        const isSuccess = ["SUCCESS", "FINISHED_WITH_RETURN"].includes(execResult);
        const isError = ["ERROR", "FINISHED_WITH_ERROR"].includes(execResult);

        console.log(
          `[${label}] tx=${hash} | acceptedSeen=${acceptedSeen} | statuses=${observedStatuses.join("->")} | result=${resultName} | leader_exec=${execResult} | ret=${JSON.stringify(returnPayload)} | err=${stderr || "none"}`
        );

        if (!expectFailure && !isSuccess) {
          throw new Error(
            `[${label}] Expected leader SUCCESS, got ${execResult}: stderr=${stderr} payload=${JSON.stringify(returnPayload)}`
          );
        }
        if (expectFailure && !isError) {
          throw new Error(
            `[${label}] Expected leader ERROR, got ${execResult}: payload=${JSON.stringify(returnPayload)}`
          );
        }

        return {
          step: label,
          tx_hash: hash,
          explorer_url: `https://explorer-studio.genlayer.com/tx/${hash}`,
          accepted_seen: acceptedSeen,
          observed_statuses: observedStatuses,
          final_status: status,
          consensus_result: resultName,
          leader_execution_result: execResult,
          return_or_error: returnPayload || stderr || "",
          stderr: stderr || null,
          votes,
          expected_failure: expectFailure,
          contract_address: contractAddress,
        };
      }
      if (["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(status)) {
        throw new Error(`[${label}] Terminal non-finalized status ${status} on ${hash}`);
      }
    } catch (err) {
      if (err.message && (err.message.includes("Expected leader") || err.message.includes("Terminal non-finalized"))) {
        throw err;
      }
      console.warn(`  [Poll attempt ${i + 1} warning for ${label}]: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 3500));
  }
  throw new Error(`[${label}] Timeout waiting for FINALIZED on ${hash}`);
}

async function readWithRetry(client, address, functionName, args = [], retries = 6) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      lastErr = err;
      console.warn(`  [readContract ${functionName} attempt ${i}]: ${err.message || err}`);
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  throw lastErr;
}

async function sendAndVerify(
  client,
  contractAddress,
  functionName,
  args,
  label,
  expectFailure = false,
  valueWei = 0n,
  expectedErrSubstr = null,
  retries = 5
) {
  let hash = null;
  let lastErr = null;
  for (let i = 1; i <= retries; i++) {
    try {
      hash = await client.writeContract({
        address: contractAddress,
        functionName,
        args,
        value: valueWei,
      });
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`  [writeContract ${label} attempt ${i}]: ${err.message || err}`);
      if (i < retries) await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  if (!hash) {
    throw new Error(`Failed to send ${label}: ${lastErr?.message || lastErr}`);
  }
  const rec = await waitForFinalized(client, hash, label, expectFailure);
  if (expectedErrSubstr && !String(rec.return_or_error).includes(expectedErrSubstr)) {
    throw new Error(`[${label}] Expected '${expectedErrSubstr}' in error, got: ${rec.return_or_error}`);
  }
  return rec;
}

async function main() {
  const commitSha = execSync("git rev-parse HEAD", { cwd: ROOT_DIR }).toString("utf8").trim();
  const blobSha = execSync("git rev-parse HEAD:contracts/cure_latch.py", { cwd: ROOT_DIR })
    .toString("utf8")
    .trim();

  const contractPath = path.join(ROOT_DIR, "contracts", "cure_latch.py");
  const contractBytes = fs.readFileSync(contractPath);
  const contractCode = contractBytes.toString("utf8");
  const contractSha256 = sha256Hex(contractBytes);

  const evidenceFiles = {
    a1_defect: "evidence/lot_a1_defect_overlay.json",
    a1_cure: "evidence/lot_a1_cure_recalibrated.json",
    b2_compliant: "evidence/lot_b2_compliant_metrology.json",
    c3_regression: "evidence/lot_c3_cure_regression.json",
  };

  const evidenceMeta = {};
  for (const [k, rel] of Object.entries(evidenceFiles)) {
    const raw = fs.readFileSync(path.join(ROOT_DIR, rel));
    evidenceMeta[k] = {
      path: rel,
      bytes: raw.length,
      sha256: sha256Hex(raw),
      raw_url: `${REPO_PREFIX}${commitSha}/${rel}`,
    };
  }

  let state = loadState();
  if (!state.keys) {
    const keys = {};
    for (const role of ["supplier", "buyer", "auditor", "attacker"]) {
      const pk = generatePrivateKey();
      const acc = createAccount(pk);
      keys[role] = { privateKey: pk, address: acc.address };
    }
    state = saveState({ keys });
  }

  const roles = {};
  for (const role of ["supplier", "buyer", "auditor", "attacker"]) {
    const account = createAccount(state.keys[role].privateKey);
    const client = createClient({ chain: studionet, account });
    roles[role] = { address: account.address, account, client };
  }

  // Fund ephemeral accounts once via sim_fundAccount for real payable native transfers
  if (!state.funded) {
    const funding = {};
    for (const role of ["supplier", "buyer", "auditor", "attacker"]) {
      const addr = roles[role].address;
      await rpcCall("sim_fundAccount", [addr, 100000]);
      funding[role] = await getBalanceWei(addr);
      console.log(`Funded ${role} (${addr}) -> balance=${funding[role]} wei`);
    }
    state = saveState({ funded: true, initialBalances: funding });
  }

  console.log("Deploy commit:", commitSha);
  console.log("Contract blob:", blobSha);
  console.log("Contract sha256:", contractSha256);

  if (!state.contractAddress) {
    const deployHash = await roles.supplier.client.deployContract({
      code: contractCode,
      args: [],
    });
    const deployTx = await waitForFinalized(roles.supplier.client, deployHash, "DEPLOY", false);
    const contractAddress = deployTx.contract_address;
    if (!contractAddress) {
      throw new Error("Could not extract deployed contract address from receipt");
    }
    const onChainCodeRaw = await roles.supplier.client.getContractCode(contractAddress);
    const onChainCode = normalizeOnChainCode(onChainCodeRaw);
    const onChainSha256 = sha256Hex(Buffer.from(onChainCode, "utf8"));
    const byteIdentical = onChainSha256 === contractSha256;
    console.log("Deployed CureLatch contract at:", contractAddress);
    console.log("Deployed source byte-identical to local/Git file:", byteIdentical);
    if (!byteIdentical) {
      throw new Error(`Deployed source mismatch: local=${contractSha256} onchain=${onChainSha256}`);
    }
    state = saveState({
      contractAddress,
      deployTx,
      onChainSha256,
      byteIdentical,
      txs: state.txs || [],
      readbacks: state.readbacks || {},
    });
  }

  const contractAddress = state.contractAddress;
  const txs = state.txs || [];
  const readbacks = state.readbacks || {};

  function writeManifests() {
    const probePath = path.join(ROOT_DIR, "artifacts", "runner_probe.json");
    const probeData = fs.existsSync(probePath) ? JSON.parse(fs.readFileSync(probePath, "utf8")) : null;
    const manifest = {
      contract_name: "CureLatch",
      display_name: "Cure Latch",
      network: "studionet",
      chain_id: 61999,
      rpc_url: RPC_URL,
      contract_address: contractAddress,
      explorer_contract_url: `https://explorer-studio.genlayer.com/address/${contractAddress}`,
      repo_url: "https://github.com/Kanezar3/Cure-Latch",
      commit_sha: commitSha,
      contract_blob_sha: blobSha,
      contract_sha256: contractSha256,
      on_chain_code_sha256: state.onChainSha256,
      deployed_source_byte_identical: state.byteIdentical,
      pinned_contract_url: `https://github.com/Kanezar3/Cure-Latch/blob/${commitSha}/contracts/cure_latch.py`,
      pinned_contract_raw_url: `${REPO_PREFIX}${commitSha}/contracts/cure_latch.py`,
      runner: RUNNER,
      runner_probe: probeData,
      toolchain: {
        node: process.version,
        "genlayer-js": "1.2.0",
      },
      constructor_args: [],
      deploy_tx: state.deployTx,
      accounts: {
        supplier: roles.supplier.address,
        buyer: roles.buyer.address,
        auditor: roles.auditor.address,
        attacker: roles.attacker.address,
      },
      evidence_fixtures: evidenceMeta,
      transactions: txs,
      readbacks,
    };
    fs.mkdirSync(path.dirname(ARTIFACT_MANIFEST_FILE), { recursive: true });
    const jsonOut = JSON.stringify(manifest, null, 2) + "\n";
    fs.writeFileSync(ROOT_MANIFEST_FILE, jsonOut, "utf8");
    fs.writeFileSync(ARTIFACT_MANIFEST_FILE, jsonOut, "utf8");
  }

  async function runStep(stepName, fn) {
    if (txs.find((t) => t.step === stepName)) {
      console.log(`[SKIP] ${stepName} already recorded.`);
      return;
    }
    const txRec = await fn();
    txs.push(txRec);
    saveState({ txs, readbacks });
    writeManifests();
  }

  const TECH_SPEC =
    "3nm GAA Fab Lot Tolerance: EUV overlay error <= 1.2nm; Metal-1 interconnect bridge shorts == 0 per die; thermal dopant activation >= 94.0%.";

  // X1: Open covenant with zero escrow balance (proves zero-stranding non-payable guard)
  await runStep("X1_INSUFFICIENT_ESCROW_BALANCE", async () => {
    const rec = await sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "open_covenant",
      ["cov_a1", roles.buyer.address, 1000, 1500, 1800, 3600, TECH_SPEC, REPO_PREFIX],
      "X1_INSUFFICIENT_ESCROW_BALANCE",
      true,
      0n,
      "INSUFFICIENT_ESCROW_BALANCE"
    );
    readbacks.after_X1_accounting = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_accounting_state", [])
    );
    if (readbacks.after_X1_accounting.contract_balance !== 0) {
      throw new Error("Non-zero contract balance after X1");
    }
    return rec;
  });

  // S0A: Supplier deposits 1100 wei native escrow (1000 for cov_a1 + 100 for cov_b2)
  await runStep("S0A_DEPOSIT_SUPPLIER", async () => {
    return sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "deposit_escrow",
      [],
      "S0A_DEPOSIT_SUPPLIER",
      false,
      1100n
    );
  });

  // S0B: Buyer deposits 110 wei native escrow (100 for cov_a1 + 10 for cov_b2)
  await runStep("S0B_DEPOSIT_BUYER", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "deposit_escrow",
      [],
      "S0B_DEPOSIT_BUYER",
      false,
      110n
    );
  });

  // S1: Open cov_a1 locking 1000 wei bond from supplier escrow
  await runStep("S1_OPEN_COV_A1", async () => {
    const rec = await sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "open_covenant",
      ["cov_a1", roles.buyer.address, 1000, 1500, 1800, 3600, TECH_SPEC, REPO_PREFIX],
      "S1_OPEN_COV_A1",
      false,
      0n
    );
    readbacks.after_S1_cov_a1 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_a1"])
    );
    return rec;
  });

  // X2: Insufficient inspection stake (< 10% ceiling)
  await runStep("X2_INSUFFICIENT_STAKE", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "file_defect_notice",
      ["cov_a1", 99, "Overlay shift 2.4nm.", evidenceMeta.a1_defect.raw_url, evidenceMeta.a1_defect.sha256],
      "X2_INSUFFICIENT_STAKE",
      true,
      0n,
      "INSUFFICIENT_INSPECTION_STAKE"
    );
  });

  // X3: Unpinned /main/ URL rejected
  await runStep("X3_UNPINNED_URL", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "file_defect_notice",
      ["cov_a1", 100, "Overlay shift 2.4nm.", `${REPO_PREFIX}main/evidence/lot_a1_defect_overlay.json`, evidenceMeta.a1_defect.sha256],
      "X3_UNPINNED_URL",
      true,
      0n,
      "INVALID_EVIDENCE_URL"
    );
  });

  // X4: Foreign repo prefix rejected
  await runStep("X4_FOREIGN_REPO_URL", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "file_defect_notice",
      [
        "cov_a1",
        100,
        "Overlay shift 2.4nm.",
        `https://raw.githubusercontent.com/Attacker/FakeRepo/${commitSha}/evidence/lot_a1_defect_overlay.json`,
        evidenceMeta.a1_defect.sha256,
      ],
      "X4_FOREIGN_REPO_URL",
      true,
      0n,
      "REPO_PREFIX_MISMATCH"
    );
  });

  // X5: Unauthorized non-buyer filing defect notice
  await runStep("X5_UNAUTHORIZED_FILE", async () => {
    return sendAndVerify(
      roles.attacker.client,
      contractAddress,
      "file_defect_notice",
      ["cov_a1", 100, "Spoof notice.", evidenceMeta.a1_defect.raw_url, evidenceMeta.a1_defect.sha256],
      "X5_UNAUTHORIZED_FILE",
      true,
      0n,
      "UNAUTHORIZED_CALLER"
    );
  });

  // S2: Buyer files cov_a1 defect notice locking 100 wei stake from buyer escrow
  await runStep("S2_FILE_DEFECT_A1", async () => {
    const rec = await sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "file_defect_notice",
      [
        "cov_a1",
        100,
        "WAFER-LOT-2026-A1 exhibits 2.4nm EUV lithography overlay misalignment at Field R4-C2.",
        evidenceMeta.a1_defect.raw_url,
        evidenceMeta.a1_defect.sha256,
      ],
      "S2_FILE_DEFECT_A1",
      false,
      0n
    );
    readbacks.after_S2_cov_a1 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_a1"])
    );
    return rec;
  });

  // X6: Premature Round 2 cure tender before Round 1 concludes
  await runStep("X6_PREMATURE_CURE_TENDER", async () => {
    return sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "submit_cure_tender",
      ["cov_a1", "Premature cure.", evidenceMeta.a1_cure.raw_url, evidenceMeta.a1_cure.sha256],
      "X6_PREMATURE_CURE_TENDER",
      true,
      0n,
      "INVALID_COVENANT_STATE"
    );
  });

  // S3: Round 1 permissionless adjudication -> BREACH_LATCHED (LITHOGRAPHY_OVERLAY)
  await runStep("S3_ROUND1_BREACH_LATCH_A1", async () => {
    const rec = await sendAndVerify(
      roles.auditor.client,
      contractAddress,
      "adjudicate_defect_notice",
      ["cov_a1"],
      "S3_ROUND1_BREACH_LATCH_A1",
      false
    );
    readbacks.after_S3_cov_a1 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_a1"])
    );
    if (
      readbacks.after_S3_cov_a1.status !== "BREACH_LATCHED" ||
      readbacks.after_S3_cov_a1.latched_defect_domain !== "LITHOGRAPHY_OVERLAY"
    ) {
      throw new Error("UNEXPECTED_ROUND1_S3: " + JSON.stringify(readbacks.after_S3_cov_a1));
    }
    return rec;
  });

  // X7: Replay Round 1 adjudication blocked
  await runStep("X7_REPLAY_ROUND1", async () => {
    return sendAndVerify(
      roles.attacker.client,
      contractAddress,
      "adjudicate_defect_notice",
      ["cov_a1"],
      "X7_REPLAY_ROUND1",
      true,
      0n,
      "ROUND1_ALREADY_CONCLUDED"
    );
  });

  // X8: Round 2 replaying Round 1 evidence URL/hash blocked
  await runStep("X8_REPLAY_ROUND1_EVIDENCE_IN_ROUND2", async () => {
    return sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "submit_cure_tender",
      ["cov_a1", "Replayed R1 report.", evidenceMeta.a1_defect.raw_url, evidenceMeta.a1_defect.sha256],
      "X8_REPLAY_ROUND1_EVIDENCE_IN_ROUND2",
      true,
      0n,
      "REPLAYED_ROUND1_EVIDENCE"
    );
  });

  // S4: Supplier submits distinct Round 2 cure tender
  await runStep("S4_SUBMIT_CURE_A1", async () => {
    const rec = await sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "submit_cure_tender",
      [
        "cov_a1",
        "ASML Twinscan NXE stage recalibrated & Metal-0/Via-0 re-patterned: overlay reduced to 0.68nm, 0 shorts, 95.3% activation.",
        evidenceMeta.a1_cure.raw_url,
        evidenceMeta.a1_cure.sha256,
      ],
      "S4_SUBMIT_CURE_A1",
      false
    );
    readbacks.after_S4_cov_a1 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_a1"])
    );
    return rec;
  });

  // S5: Round 2 permissionless adjudication -> CURE_VERIFIED
  await runStep("S5_ROUND2_CURE_VERIFIED_A1", async () => {
    const rec = await sendAndVerify(
      roles.auditor.client,
      contractAddress,
      "adjudicate_cure_tender",
      ["cov_a1"],
      "S5_ROUND2_CURE_VERIFIED_A1",
      false
    );
    readbacks.after_S5_cov_a1 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_a1"])
    );
    if (readbacks.after_S5_cov_a1.status !== "CURED_CLOSED") {
      throw new Error("UNEXPECTED_ROUND2_S5: " + JSON.stringify(readbacks.after_S5_cov_a1));
    }
    return rec;
  });

  // S6: Supplier withdraws 850 wei via real emit_transfer
  await runStep("S6_WITHDRAW_SUPPLIER_A1", async () => {
    const balBefore = await getBalanceWei(roles.supplier.address);
    const rec = await sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "withdraw_payout",
      [],
      "S6_WITHDRAW_SUPPLIER_A1",
      false
    );
    const balAfter = await getBalanceWei(roles.supplier.address);
    readbacks.after_S6_supplier_eoa = {
      before_wei: balBefore,
      after_wei: balAfter,
      delta_wei: (BigInt(balAfter) - BigInt(balBefore)).toString(),
    };
    return rec;
  });

  // S7: Buyer withdraws 250 wei via real emit_transfer
  await runStep("S7_WITHDRAW_BUYER_A1", async () => {
    const balBefore = await getBalanceWei(roles.buyer.address);
    const rec = await sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "withdraw_payout",
      [],
      "S7_WITHDRAW_BUYER_A1",
      false
    );
    const balAfter = await getBalanceWei(roles.buyer.address);
    readbacks.after_S7_buyer_eoa = {
      before_wei: balBefore,
      after_wei: balAfter,
      delta_wei: (BigInt(balAfter) - BigInt(balBefore)).toString(),
    };
    readbacks.after_S7_accounting = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_accounting_state", [])
    );
    return rec;
  });

  // S7B: Supplier deposits 100 wei escrow for Path B covenant cov_b2
  await runStep("S7B_DEPOSIT_SUPPLIER_B2", async () => {
    return sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "deposit_escrow",
      [],
      "S7B_DEPOSIT_SUPPLIER_B2",
      false,
      100n
    );
  });

  // S7C: Buyer deposits 10 wei escrow for Path B covenant cov_b2
  await runStep("S7C_DEPOSIT_BUYER_B2", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "deposit_escrow",
      [],
      "S7C_DEPOSIT_BUYER_B2",
      false,
      10n
    );
  });

  // S8: Open Path B covenant cov_b2 (100 wei bond from supplier escrow)
  await runStep("S8_OPEN_COV_B2", async () => {
    return sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "open_covenant",
      ["cov_b2", roles.buyer.address, 100, 1500, 1800, 3600, TECH_SPEC, REPO_PREFIX],
      "S8_OPEN_COV_B2",
      false,
      0n
    );
  });

  // S9: Buyer files frivolous notice against compliant WAFER-LOT-2026-B2
  await runStep("S9_FILE_COMPLIANT_B2", async () => {
    return sendAndVerify(
      roles.buyer.client,
      contractAddress,
      "file_defect_notice",
      [
        "cov_b2",
        10,
        "Alleged fabrication spec breach on WAFER-LOT-2026-B2.",
        evidenceMeta.b2_compliant.raw_url,
        evidenceMeta.b2_compliant.sha256,
      ],
      "S9_FILE_COMPLIANT_B2",
      false,
      0n
    );
  });

  // S10: Round 1 rejects frivolous claim -> REJECTED_NO_BREACH (slashes 10 wei stake to supplier)
  await runStep("S10_ROUND1_REJECT_NO_BREACH_B2", async () => {
    const rec = await sendAndVerify(
      roles.auditor.client,
      contractAddress,
      "adjudicate_defect_notice",
      ["cov_b2"],
      "S10_ROUND1_REJECT_NO_BREACH_B2",
      false
    );
    readbacks.after_S10_cov_b2 = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_covenant", ["cov_b2"])
    );
    if (readbacks.after_S10_cov_b2.status !== "NO_BREACH_CLOSED") {
      throw new Error("UNEXPECTED_ROUND1_S10: " + JSON.stringify(readbacks.after_S10_cov_b2));
    }
    return rec;
  });

  // S11: Supplier withdraws 110 wei (100 bond + 10 slashed buyer stake)
  await runStep("S11_WITHDRAW_SUPPLIER_B2", async () => {
    const balBefore = await getBalanceWei(roles.supplier.address);
    const rec = await sendAndVerify(
      roles.supplier.client,
      contractAddress,
      "withdraw_payout",
      [],
      "S11_WITHDRAW_SUPPLIER_B2",
      false
    );
    const balAfter = await getBalanceWei(roles.supplier.address);
    readbacks.after_S11_supplier_eoa = {
      before_wei: balBefore,
      after_wei: balAfter,
      delta_wei: (BigInt(balAfter) - BigInt(balBefore)).toString(),
    };
    readbacks.after_S11_final_accounting = JSON.parse(
      await readWithRetry(roles.supplier.client, contractAddress, "get_accounting_state", [])
    );
    return rec;
  });

  writeManifests();
  console.log("ALL CURELATCH LIVE DEMO STEPS COMPLETED! Manifest:", ROOT_MANIFEST_FILE);
}

main().catch((err) => {
  console.error("LIVE DEMO FAILED:", err);
  process.exit(1);
});
