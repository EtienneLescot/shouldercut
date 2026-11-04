// What Muse is doing, while she does it.
//
// A measured run of "floute l'arrière-plan" looks like this:
//
//    3.3s  préparation
//   20.5s  get_shader_interface      <- seventeen seconds with no event
//   25.7s  apply_shader_effect
//   29.8s  seek_video
//
// The seventeen seconds are real work -- the model is composing the shader
// before it touches a single tool -- but nothing reaches the page, so the
// editor looks frozen. This surface covers that gap honestly: it shows the
// steps that actually arrive, counts the wait out loud while there is
// nothing else to say, and when the shader finally lands it shows the WGSL
// Muse really wrote. Nothing here is decorative filler; every line on
// screen came off the wire.

/** Steps settle after this long, so a fast run never flashes numbers. */
const SHOW_TIMER_AFTER_MS = 2500;
/** How long the real shader source stays on screen once it arrives. */
const CODE_DWELL_MS = 3200;
const MAX_VISIBLE = 5;

interface Step {
  node: HTMLLIElement;
  timeNode: HTMLElement;
  startedAt: number;
  done: boolean;
}

export interface WorkTrail {
  /** Work started; label is the opening phase. */
  begin(label: string): void;
  /** A tool call arrived. Closes the previous step and opens this one. */
  step(label: string): void;
  /** Real source Muse just wrote, shown behind the steps for a beat. */
  code(source: string): void;
  /** Work finished. */
  end(): void;
}

function formatElapsed(ms: number): string {
  return ms < 60_000
    ? (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + ' s'
    : Math.floor(ms / 60_000) + ' min ' + Math.round((ms % 60_000) / 1000) + ' s';
}

export function createWorkTrail(host: HTMLElement): WorkTrail {
  const list = document.createElement('ol');
  list.className = 'trail-steps';
  const code = document.createElement('pre');
  code.className = 'trail-code';
  code.setAttribute('aria-hidden', 'true');
  host.append(code, list);

  let steps: Step[] = [];
  let current: Step | null = null;
  let ticker = 0;
  let codeTimer: ReturnType<typeof setTimeout> | null = null;

  function closeCurrent(): void {
    if (!current || current.done) return;
    current.done = true;
    current.node.dataset.state = 'done';
    const spent = performance.now() - current.startedAt;
    current.timeNode.textContent = spent >= SHOW_TIMER_AFTER_MS ? formatElapsed(spent) : '';
  }

  function trim(): void {
    while (steps.length > MAX_VISIBLE) {
      const oldest = steps.shift();
      oldest?.node.remove();
    }
  }

  function tick(): void {
    if (!current || current.done) return;
    const spent = performance.now() - current.startedAt;
    // Stay silent on a quick step: a number that appears and vanishes reads
    // as a glitch, while one that keeps climbing reads as patience.
    current.timeNode.textContent = spent >= SHOW_TIMER_AFTER_MS ? formatElapsed(spent) : '';
  }

  function push(label: string): void {
    closeCurrent();
    const node = document.createElement('li');
    node.className = 'trail-step';
    node.dataset.state = 'active';
    const dot = document.createElement('span');
    dot.className = 'trail-dot';
    const text = document.createElement('span');
    text.className = 'trail-label';
    text.textContent = label;
    const timeNode = document.createElement('span');
    timeNode.className = 'trail-time';
    node.append(dot, text, timeNode);
    list.append(node);
    current = { node, timeNode, startedAt: performance.now(), done: false };
    steps.push(current);
    trim();
  }

  return {
    begin(label: string): void {
      host.dataset.state = 'working';
      list.replaceChildren();
      steps = [];
      current = null;
      push(label);
      clearInterval(ticker);
      ticker = window.setInterval(tick, 200);
    },
    step(label: string): void {
      if (host.dataset.state !== 'working') this.begin(label);
      else push(label);
    },
    code(source: string): void {
      const lines = source.split('\n').filter((l) => l.trim()).slice(0, 40);
      if (!lines.length) return;
      code.textContent = lines.join('\n');
      code.dataset.state = 'run';
      if (codeTimer) clearTimeout(codeTimer);
      codeTimer = setTimeout(() => {
        code.dataset.state = '';
        code.textContent = '';
      }, CODE_DWELL_MS);
    },
    end(): void {
      closeCurrent();
      clearInterval(ticker);
      ticker = 0;
      host.dataset.state = 'done';
      // Let the finished trail stand for a moment, then clear it: the point
      // is reassurance during the wait, not a log to keep.
      setTimeout(() => {
        if (host.dataset.state === 'done') host.dataset.state = '';
      }, 2200);
    },
  };
}
