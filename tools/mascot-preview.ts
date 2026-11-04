import { createMascot, type MascotState } from '../src/mascot';
const muse = createMascot(document.querySelector('canvas')!);
for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => {
  muse.setState(button.dataset.state as MascotState);
  for (const other of document.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
});
const meter = setInterval(() => muse.setLevel(.3 + .25 * Math.sin(performance.now() / 150)), 60);
window.addEventListener('pagehide', () => { clearInterval(meter); muse.dispose(); });
