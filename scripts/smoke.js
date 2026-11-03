#!/usr/bin/env node
const bases = {
  legs: process.env.LEGS_URL || "http://127.0.0.1:3001",
  hands: process.env.HANDS_URL || "http://127.0.0.1:3002",
  stomach: process.env.STOMACH_URL || "http://127.0.0.1:3003",
  eyes: process.env.EYES_URL || "http://127.0.0.1:3004",
  head: process.env.HEAD_URL || "http://127.0.0.1:3005",
};

function assert(condition, message, extra) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
    process.exit(1);
  }
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {
      // Process is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function request(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  if (text) payload = JSON.parse(text);
  return { status: response.status, payload, headers: response.headers };
}

async function until(label, fn) {
  let last;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(false, label, last);
}

async function main() {
  await Promise.all(Object.values(bases).map((base) => waitFor(`${base}/health`)));

  const legsHealth = await request(`${bases.legs}/health`);
  assert(legsHealth.headers.get("x-robot-service") === "legs", "legs identity header", legsHealth.payload);
  assert(legsHealth.headers.get("x-robot-track") === "v1", "legs track header");

  const charged = await request(`${bases.stomach}/api/energy/charge`, {
    method: "POST",
    body: { amount: 100 },
  });
  assert(charged.status === 200 && charged.payload.energy === 100, "charge to full", charged.payload);

  const walked = await request(`${bases.legs}/api/move`, { method: "POST", body: { action: "walk" } });
  assert(walked.status === 200 && walked.payload.posture === "walking", "legs walk", walked.payload);
  assert(walked.payload.power && walked.payload.power.link === "up", "legs reached the diamond", walked.payload);

  const stopped = await request(`${bases.legs}/api/move`, { method: "POST", body: { action: "stop" } });
  assert(stopped.status === 200 && stopped.payload.posture === "standing", "legs stop", stopped.payload);

  const waved = await request(`${bases.hands}/api/move`, { method: "POST", body: { action: "wave" } });
  assert(waved.status === 200 && waved.payload.gesture === "wave", "hands wave", waved.payload);

  const scanned = await request(`${bases.eyes}/api/scan`, { method: "POST", body: { scene: "lab" } });
  assert(scanned.status === 200 && scanned.payload.identified.length === 3, "eyes scan", scanned.payload);

  await until("head stored the sighting", async () => {
    const head = await request(`${bases.head}/api/status`);
    return head.payload.lastObservation && head.payload.lastObservation.scene === "lab";
  });

  const patrol = await request(`${bases.head}/api/command`, { method: "POST", body: { command: "patrol" } });
  assert(patrol.status === 200 && patrol.payload.ok === true, "head patrol", patrol.payload);
  assert(patrol.payload.transcript.length === 3, "patrol called three services", patrol.payload.transcript);

  const fleet = await request(`${bases.head}/api/fleet`);
  assert(fleet.status === 200, "fleet status", fleet.payload);
  for (const name of ["legs", "hands", "stomach", "eyes"]) {
    assert(fleet.payload.peers[name].ok === true, `${name} visible to the head`, fleet.payload.peers[name]);
  }

  const proxied = await request(`${bases.head}/api/parts/hands/move`, {
    method: "POST",
    body: { action: "rest" },
  });
  assert(proxied.status === 200 && proxied.payload.gesture === "rest", "head proxy to hands", proxied.payload);

  const blocked = await request(`${bases.head}/api/parts/legs/scan`, {
    method: "POST",
    body: { scene: "lab" },
  });
  assert(blocked.status === 404, "proxy rejects unknown routes", blocked.payload);

  const bad = await request(`${bases.legs}/api/move`, { method: "POST", body: { action: "fly" } });
  assert(bad.status === 400, "unknown leg action", bad.payload);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await request(`${bases.stomach}/api/energy`);
    if (current.payload.energy < 8) break;
    const amount = Math.min(40, current.payload.energy);
    const drain = await request(`${bases.stomach}/api/energy/consume`, {
      method: "POST",
      body: { amount, consumer: "smoke", reason: "drain" },
    });
    assert(drain.status === 200, "drain while energy remains", drain.payload);
  }

  const before = await request(`${bases.legs}/api/status`);
  const jump = await request(`${bases.legs}/api/move`, { method: "POST", body: { action: "jump" } });
  const after = await request(`${bases.legs}/api/status`);
  assert(jump.status === 409, "jump refused when the diamond is empty", jump.payload);
  assert(after.payload.posture === before.payload.posture, "failed jump did not change posture", {
    before: before.payload.posture,
    after: after.payload.posture,
  });

  const restored = await request(`${bases.stomach}/api/energy/charge`, {
    method: "POST",
    body: { amount: 100 },
  });
  assert(restored.status === 200 && restored.payload.energy === 100, "recharge", restored.payload);
  const rested = await request(`${bases.legs}/api/move`, { method: "POST", body: { action: "stop" } });
  assert(rested.status === 200 && rested.payload.posture === "standing", "legs rest after the drill", rested.payload);

  const metrics = await fetch(`${bases.stomach}/metrics`);
  const body = await metrics.text();
  assert(metrics.ok && body.includes("robot_energy_level"), "stomach metrics");
  assert(body.includes("robot_build_info"), "build info metric");

  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
