#!/usr/bin/env node
// Fon jarayoni: hook shuni detached qilib ishga tushiradi va darhol chiqadi.
// Shu sababli 2 ta LLM chaqiruvi (~5-15 s) chatni umuman sekinlashtirmaydi.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { send } from "../lib/send.js";

const jobPath = process.argv[2];
if (!jobPath) process.exit(0);

const LOG = path.join(os.homedir(), ".chatmanager", "worker.log");

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* log yozilmasa ham ish to'xtamaydi */ }
}

try {
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  fs.unlinkSync(jobPath);

  const { status, body } = await send(job.url, job.token, job.payload);

  if (status === 409 && body?.error === "not_linked") {
    log(`not_linked ${job.payload.external_id} — 'npx chatmanager link' bajaring`);
  } else if (status >= 400) {
    log(`HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
  } else {
    log(
      `ok applied=${body.applied ?? 0} skipped=${body.skipped ?? body.skipped_reason ?? 0}` +
        ` items=${body.items ?? 0} cost=${body.cost_usd ?? 0} ${body.duration_ms ?? 0}ms`,
    );
  }
} catch (err) {
  log(`error ${err?.message ?? err}`);
}

process.exit(0);
