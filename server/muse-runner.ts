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
  get_project: "Lecture du montage",
  trim_clip: "Découpe du clip",
  split_clip: "Division du clip",
  move_clip: "Déplacement du clip",
  delete_clip: "Retrait du clip",
  undo: "Annulation",
  redo: "Rétablissement",
  describe_frame: "Observation de l’image",
  track_object: "Suivi de l’objet sur l’extrait",
  get_shader_interface: "Préparation de l’effet",
  validate_shader: "Vérification de l’effet",
  apply_shader_effect: "Application de l’effet",
  remove_shader_effect: "Retrait de l’effet",
  export_video: "Export de la vidéo",
  transcribe_captions: "Transcription des sous-titres",
  set_captions: "Pose des sous-titres",
  edit_segment: "Lancement de la transformation",
  generate_shot: "Lancement de la génération",
  recommend_video_workflow: "Préparation de la transformation",
};

/** Machine events, not stderr banners, describe what the editor is doing. */
export class MuseEvents {
  private buffer = "";
  reply = "";
  terminal: string | undefined;
  phase = "Préparation du montage";
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
        this.phase = TOOL_LABELS[tool] || "Montage en cours";
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
      }),
    options.prompt,
  ];
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
            "Le montage a pris trop de temps. Dernière étape : " +
              events.phase.toLowerCase() +
              ". Vérifiez le résultat avant de réessayer.",
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
            "Muse n’a pas terminé le montage (" +
              events.phase.toLowerCase() +
              "). Le projet reste accessible ; vérifiez le résultat avant de réessayer.",
          ),
        );
      }
    });
  });
}
