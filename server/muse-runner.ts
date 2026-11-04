import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { traceId } from "./diagnostics.ts";

export interface MuseProgress {
  phase: string;
  tool?: string;
}
export interface MuseRunOptions {
  executable: string;
  workspace: string;
  mcpScript: string;
  prompt: string;
  onProgress?: (progress: MuseProgress) => void;
  timeoutMs?: number;
}

const TOOL_LABELS: Record<string, string> = {
  get_project: "Reading the montage",
  trim_clip: "Trimming the clip",
  split_clip: "Splitting the clip",
  move_clip: "Moving the clip",
  delete_clip: "Removing the clip",
  undo: "Undoing",
  redo: "Redoing",
  describe_frame: "Looking at the frame",
  track_object: "Tracking the object",
  get_shader_interface: "Preparing the effect",
  validate_shader: "Checking the effect",
  apply_shader_effect: "Applying the effect",
  remove_shader_effect: "Removing the effect",
  export_video: "Exporting the video",
  transcribe_captions: "Transcribing the captions",
  set_captions: "Laying down the captions",
  edit_segment: "Starting the transformation",
  generate_shot: "Starting the generation",
  recommend_video_workflow: "Preparing the transformation",
};

/** Machine events, not stderr banners, describe what the editor is doing. */
export class MuseEvents {
  private buffer = "";
  reply = "";
  terminal: string | undefined;
  phase = "Preparing the edit";
  private progress: (progress: MuseProgress) => void;
  constructor(progress: (progress: MuseProgress) => void = () => {}) {
    this.progress = progress;
  }
  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const p = row.payload;
      if (!p || typeof p !== "object") continue;
      if (p.kind === "run_terminal") {
        this.terminal = p.terminal;
        if (typeof p.text === "string") this.reply = p.text;
      }
      if (p.kind === "task_lifecycle" && p.event?.kind === "proposed") {
        const kind = String(p.event.task_kind || "");
        if (!kind.startsWith("tool.mcp__shouldercut_fx__")) continue;
        const tool = kind.slice("tool.mcp__shouldercut_fx__".length);
        this.phase = TOOL_LABELS[tool] || "Editing";
        this.progress({ phase: this.phase, tool });
      }
    }
  }
  finish(): void {
    if (this.buffer.trim()) this.push("\n");
  }
}

export function museArgs(options: MuseRunOptions): string[] {
  return [
    "exec",
    "--json",
    "--preset",
    "empty",
    "--no-foreign-personal-context",
    "--disable-reminders",
    "--disable-shell",
    "--disable-write",
    "--approval-mode",
    "never",
    "--disable-web-tools",
    "--disable-request-user-input",
    "--max-model-steps",
    "16",
    "--model",
    process.env.MUSE_EDITOR_MODEL || "muse-wonder-1.0",
    "--reasoning-effort",
    "medium",
    "--no-parallel-tool-calls",
    "-c",
    "mcpServers.shouldercut-fx=" +
      JSON.stringify({
        transport: "stdio",
        command: process.execPath,
        args: [options.mcpScript],
        mode: "required",
        enabled: true,
        // The CLI launches this server with an environment of its own, not
        // ours, so anything it needs has to be declared right here. It is
        // not obvious and it fails far away: without the key the editor
        // answers 401 to its own tool calls, and without the bridge URL it
        // falls back to http://127.0.0.1:5173 and reports "fetch failed"
        // the moment the server is anywhere else. Both looked like network
        // faults and neither was.
        //
        // mcpEnv is the whole list the server reads, so a variable added
        // there is added here, in one place, and nothing silently defaults.
        env: mcpEnv(),
      }),
    options.prompt,
  ];
}

/** Every variable server/shouldercut-mcp.mjs reads, passed by reference. */
function mcpEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "SHOULDERCUT_ACCESS_KEY",
    "SHOULDERCUT_BRIDGE",
    "SHOULDERCUT_TRACE_ID",
  ]) {
    // A reference, never the value. The CLI refuses a literal secret in
    // -c ("secret leaves need exactly one whole-value ${VAR}") and it is
    // right to: the value would sit in the command line for anyone
    // reading the process table. The CLI resolves these from its own
    // environment, which the spawn below hands it in full.
    if (process.env[name]) env[name] = "${" + name + "}";
  }
  return env;
}

function stopTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      child.kill("SIGTERM");
      resolve();
      return;
    }
    // Only the process tree owned by this request. Closing the parent alone
    // leaves its MCP server alive and able to finish a timed-out operation.
    const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    kill.once("error", () => {
      child.kill();
      resolve();
    });
    kill.once("close", () => resolve());
  });
}

export async function runMuse(
  options: MuseRunOptions,
): Promise<{ reply: string; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, museArgs(options), {
      cwd: options.workspace,
      env: { ...process.env, SHOULDERCUT_TRACE_ID: traceId() || "" },
      windowsHide: true,
      shell: false,
    });
    const events = new MuseEvents(options.onProgress);
    let stderr = "",
      ended = false;
    const timer = setTimeout(() => {
      if (ended) return;
      ended = true;
      void stopTree(child).finally(() =>
        reject(
          new Error(
            "The edit took too long. Last step: " +
              events.phase.toLowerCase() +
              ". Check the result before trying again.",
          ),
        ),
      );
    }, options.timeoutMs ?? 240_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.end();
    child.stdout.on("data", (chunk: string) => events.push(chunk));
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12_000);
    });
    child.once("error", (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      events.finish();
      if (
        code === 0 &&
        events.terminal === "completed" &&
        events.reply.trim()
      ) {
        resolve({
          reply: events.reply.trim(),
          stderrTail: stderr.slice(-1200),
        });
      } else {
        console.error("[ShoulderCut Muse]", {
          code,
          terminal: events.terminal,
          phase: events.phase,
          stderr,
        });
        reject(
          new Error(
            "Muse did not finish the edit (" +
              events.phase.toLowerCase() +
              "). The project is still there; check the result before trying again.",
          ),
        );
      }
    });
  });
}
