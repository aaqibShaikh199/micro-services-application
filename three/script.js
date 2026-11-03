const SERVICE = document.body.dataset.service;
const PARTS = ["head", "eyes", "hands", "stomach", "legs"];
const ALERTS = {
  legs: "LEG SERVICE IS DOWN",
  hands: "HAND SERVICE IS DOWN",
  stomach: "STOMACH SERVICE IS DOWN",
  eyes: "EYE SERVICE IS DOWN",
  head: "HEAD SERVICE IS DOWN",
};
const PAL = {
  healthy: { fill: "#E4F9EC", shade: "#C2EED3", stroke: "#4ADE80" },
  down: { fill: "#FFDEDA", shade: "#F7B5AE", stroke: "#FF7A6E" },
};

const template = document.querySelector("#robot-template");
const healthy = template.content.firstElementChild.cloneNode(true);
document.querySelector("#healthy-slot").append(healthy);

const live = template.content.firstElementChild.cloneNode(true);
live.id = "live-robot";
document.querySelector("#live-slot").append(live);

const alerts = document.querySelector("#alerts");
const pill = document.querySelector("#pill");
document.querySelector("#served-by").textContent = `Viewed through the ${SERVICE} service`;

function paint(root, part, palette) {
  root.querySelectorAll(`[data-fill="${part}"]`).forEach((el) => el.setAttribute("fill", palette.fill));
  root.querySelectorAll(`[data-stroke="${part}"]`).forEach((el) => el.setAttribute("stroke", palette.stroke));
  root.querySelectorAll(`[data-shade="${part}"]`).forEach((el) => el.setAttribute("fill", palette.shade));
  root.querySelectorAll(`[data-ink="${part}"]`).forEach((el) => el.setAttribute("fill", palette.stroke));
}

function apply(root, ok) {
  paint(root, "head", ok.head ? PAL.healthy : PAL.down);
  paint(root, "core", ok.stomach ? PAL.healthy : PAL.down);
  const arms = ok.hands ? PAL.healthy : PAL.down;
  paint(root, "armL", arms);
  paint(root, "armR", arms);
  paint(root, "legs", ok.legs ? PAL.healthy : PAL.down);

  const down = PARTS.filter((part) => !ok[part]);
  const sad = down.length > 0;
  root.querySelector('[data-face="happy"]').style.display = sad ? "none" : "";
  root.querySelector('[data-face="worried"]').style.display = "none";
  root.querySelector('[data-face="sad"]').style.display = sad ? "" : "none";
  root.querySelector("[data-wobble]").setAttribute("class", sad ? "wobbly" : "steady");

  const svg = root.querySelector("svg");
  const mood = sad ? "sad" : "happy";
  const status = down.length === 0
    ? "all services are healthy"
    : `${down.length} service${down.length === 1 ? "" : "s"} down`;
  svg.setAttribute("aria-label", `Robot looking ${mood}. ${status}`);
  return down;
}

apply(healthy, { head: true, eyes: true, hands: true, stomach: true, legs: true });

function render(health) {
  const parts = health && health.parts ? health.parts : {};
  const ok = {};
  PARTS.forEach((part) => {
    ok[part] = Boolean(parts[part] && parts[part].ok);
  });
  const down = apply(live, ok);

  alerts.replaceChildren();
  if (down.length === 0) {
    const note = document.createElement("p");
    note.className = "alert alert-ok";
    note.textContent = "ALL SERVICES ARE HEALTHY";
    alerts.append(note);
    pill.dataset.state = "up";
    pill.textContent = "All healthy";
    return;
  }

  down.forEach((part) => {
    const note = document.createElement("p");
    note.className = "alert";
    note.textContent = ALERTS[part];
    alerts.append(note);
  });
  pill.dataset.state = "down";
  pill.textContent = `${down.length} down`;
}

async function tick() {
  try {
    const response = await fetch("/api/parts-health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    pill.dataset.state = "down";
    pill.textContent = "Check failed";
    alerts.replaceChildren();
    const note = document.createElement("p");
    note.className = "alert";
    note.textContent = "HEALTH CHECK FAILED";
    alerts.append(note);
  }
}

tick();
setInterval(tick, 2000);
