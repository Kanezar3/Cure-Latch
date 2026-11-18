const fs = require("fs");
const path = require("path");
const https = require("https");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

const PROBE_CODE = `# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *

class RunnerProbe(gl.Contract):
    val: str

    def __init__(self):
        self.val = "init"

    @gl.public.write
    def ping(self, msg: str) -> str:
        self.val = msg
        return f"PONG:{msg}"

    @gl.public.view
    def get_val(self) -> str:
        return self.val
`;

async function waitForFinalized(client, hash, label) {
  let acceptedSeen = false;
  for (let i = 0; i < 120; i++) {
    const tx = await client.getTransaction({ hash });
    const status = String(tx.statusName || tx.status || "");
    if (["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "1", "2", "3", "4", "5", "6"].includes(status)) {
      acceptedSeen = true;
    }
    if (status === "FINALIZED" || status === "7") {
      const lr = tx.consensus_data?.leader_receipt?.[0] || {};
      const execResult = lr.execution_result || tx.txExecutionResultName || "";
      const stderr = lr.genvm_result?.stderr || lr.error || "";
      const resultName = tx.resultName || tx.result_name || String(tx.result || "");
      console.log(
        `[${label}] FINALIZED | acceptedSeen=${acceptedSeen} | result=${resultName} | leader_exec=${execResult} | err=${stderr || "none"}`
      );
      return { tx, acceptedSeen, lr, execResult, stderr, resultName };
    }
    if (["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(status)) {
      throw new Error(`[${label}] Unexpected terminal status ${status}: ${JSON.stringify(tx)}`);
    }
    await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 3500));
  }
  throw new Error(`[${label}] Timeout waiting for FINALIZED on ${hash}`);
}

async function main() {
  const pk = generatePrivateKey();
  const account = createAccount(pk);
  const client = createClient({ chain: studionet, account });

  console.log("Probe account:", account.address);
  console.log("Chain ID:", await client.getChainId());

  console.log("Deploying RunnerProbe...");
  const deployHash = await client.deployContract({ code: PROBE_CODE, args: [] });
  const deployRes = await waitForFinalized(client, deployHash, "PROBE_DEPLOY");
  if (!["SUCCESS", "FINISHED_WITH_RETURN"].includes(deployRes.execResult)) {
    throw new Error("Probe deploy did not succeed: " + JSON.stringify(deployRes.lr));
  }

  const contractAddress =
    deployRes.tx.to_address || deployRes.tx.contract_address || deployRes.tx.data?.contract_address;
  console.log("Probe contract address:", contractAddress);

  const writeHash = await client.writeContract({
    address: contractAddress,
    functionName: "ping",
    args: ["probe_ok"],
    value: 0n,
  });
  const writeRes = await waitForFinalized(client, writeHash, "PROBE_WRITE");
  if (!["SUCCESS", "FINISHED_WITH_RETURN"].includes(writeRes.execResult)) {
    throw new Error("Probe write failed: " + JSON.stringify(writeRes.lr));
  }

  const readVal = await client.readContract({
    address: contractAddress,
    functionName: "get_val",
    args: [],
  });
  console.log("Probe read get_val():", readVal);
  if (readVal !== "probe_ok") {
    throw new Error(`Unexpected read value: ${readVal}`);
  }

  const outPath = path.resolve(__dirname, "..", "artifacts", "runner_probe.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        network: "studionet",
        chain_id: 61999,
        runner: "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6",
        probe_address: contractAddress,
        deploy_tx: deployHash,
        deploy_status: deployRes.tx.statusName || deployRes.tx.status,
        deploy_leader_exec: deployRes.execResult,
        write_tx: writeHash,
        write_status: writeRes.tx.statusName || writeRes.tx.status,
        write_leader_exec: writeRes.execResult,
        read_val: readVal,
      },
      null,
      2
    ) + "\n"
  );
  console.log("Probe verified and saved to", outPath);
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exit(1);
});
