import { createMascot, type MascotState } from "../src/mascot";

const muse = createMascot(document.querySelector("canvas")!);

// What she is told and what she is doing are separate, so the preview has
// to set them separately: the point is to see her turn round to you with
// the typing still running underneath.
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "#states button",
)) {
  button.addEventListener("click", () => {
    muse.setState(button.dataset.state as MascotState);
    for (const other of document.querySelectorAll("#states button"))
      other.setAttribute("aria-pressed", String(other === button));
  });
}

const working = document.querySelector<HTMLButtonElement>("#working")!;
working.addEventListener("click", () => {
  const on = working.getAttribute("aria-pressed") !== "true";
  working.setAttribute("aria-pressed", String(on));
  muse.setWorking(on);
});

const meter = setInterval(
  () => muse.setLevel(0.3 + 0.25 * Math.sin(performance.now() / 150)),
  60,
);
window.addEventListener("pagehide", () => {
  clearInterval(meter);
  muse.dispose();
});
