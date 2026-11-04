import {
  createLocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
} from "livekit-client";
import type { MascotState } from "./mascot";

interface VoiceUI {
  button: HTMLButtonElement;
  fallback: HTMLButtonElement;
  selector: HTMLSelectElement;
  status: HTMLElement;
  history: () => { role: string; text: string }[];
  mic: () => MediaStreamConstraints;
  meter: (stream: MediaStream) => { stop: () => void; peak: () => number };
  outputMeter: (stream: MediaStream) => { stop: () => void };
  working: (working: boolean) => void;
  refreshMics: () => Promise<void>;
  state: (state: MascotState) => void;
  message: (role: "user" | "agent", text: string) => void;
  pause: () => void;
}

export function setupRealtimeVoice(ui: VoiceUI): void {
  let room: Room | null = null;
  let mic: LocalAudioTrack | null = null;
  let meter: ReturnType<VoiceUI["meter"]> | null = null;
  let joining = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let editing = false;
  const audioElements = new Set<HTMLMediaElement>();
  const outputMeters = new Map<string, ReturnType<VoiceUI["outputMeter"]>>();
  const label = ui.button.querySelector(".talk-label");

  async function stop(): Promise<void> {
    clearTimeout(readyTimer);
    clearTimeout(silenceTimer);
    meter?.stop();
    meter = null;
    mic?.stop();
    mic = null;
    const previous = room;
    room = null;
    for (const element of audioElements) element.remove();
    audioElements.clear();
    for (const output of outputMeters.values()) output.stop();
    outputMeters.clear();
    if (label) label.textContent = "Talk";
    ui.button.setAttribute("aria-pressed", "false");
    ui.fallback.disabled = false;
    ui.selector.disabled = false;
    editing = false;
    ui.working(false);
    ui.state("idle");
    if (previous) await previous.disconnect();
  }

  async function fail(error: unknown): Promise<void> {
    await stop();
    ui.status.textContent =
      error instanceof Error ? error.message : String(error);
    ui.state("error");
  }

  ui.button.addEventListener("click", () => {
    if (joining) return;
    if (room) {
      void stop().then(() => {
        ui.status.textContent = "Conversation ended.";
      });
      return;
    }
    joining = true;
    ui.button.disabled = true;
    ui.fallback.disabled = true;
    ui.selector.disabled = true;
    ui.status.textContent = "Connecting to the conversation…";
    void (async () => {
      try {
        // Obtain the exact selected input before allocating a room.
        const constraints = ui.mic().audio;
        mic = await createLocalAudioTrack({
          ...(typeof constraints === "object" ? constraints : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        await ui.refreshMics();
        const response = await fetch("/api/voice/token");
        const data = await response.json();
        if (!response.ok || !data.ok)
          throw new Error(data.message || "Voice connection unavailable.");
        const call = new Room();
        room = call;
        call.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const audio = track.attach();
          document.body.append(audio);
          audioElements.add(audio);
          outputMeters.set(
            track.sid!,
            ui.outputMeter(new MediaStream([track.mediaStreamTrack])),
          );
        });
        call.on(RoomEvent.TrackUnsubscribed, (track) => {
          for (const element of track.detach()) {
            element.remove();
            audioElements.delete(element);
          }
          outputMeters.get(track.sid!)?.stop();
          outputMeters.delete(track.sid!);
        });
        call.on(RoomEvent.Disconnected, () => {
          if (room === call)
            void fail(
              new Error(
                "Conversation disconnected. Click Talk to resume.",
              ),
            );
        });
        call.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
          if (topic !== "shouldercut.voice" || !participant?.isAgent) return;
          let event;
          try {
            event = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            return;
          }
          if (event.type === "ready") {
            clearTimeout(readyTimer);
            ui.status.textContent =
              "Conversation open · " +
              event.provider +
              " · mic: " +
              mic?.mediaStreamTrack.label;
            void call.localParticipant.publishData(
              new TextEncoder().encode(
                JSON.stringify({ history: ui.history() }),
              ),
              { reliable: true, topic: "shouldercut.context" },
            );
          } else if (event.type === "partial") {
            ui.status.textContent = event.text;
          } else if (event.type === "transcript") {
            ui.message(event.role === "user" ? "user" : "agent", event.text);
          } else if (event.type === "state") {
            ui.state(
              event.state === "speaking"
                ? "speaking"
                : editing
                  ? "thinking"
                  : "listening",
            );
          } else if (event.type === "dialogue") {
            if (!event.editing)
              ui.status.textContent =
                "Conversation · " + (event.elapsed_ms / 1000).toFixed(1) + " s";
          } else if (event.type === "editing") {
            editing = true;
            ui.working(true);
            ui.state("thinking");
          } else if (event.type === "edit_done") {
            editing = event.pending > 0;
            ui.working(editing);
            ui.status.textContent =
              "Editor reply · " +
              (event.elapsed_ms / 1000).toFixed(1) +
              " s";
            ui.state("done");
          } else if (event.type === "action_done") {
            ui.state(editing ? "thinking" : "done");
            ui.status.textContent = "Listening.";
          } else if (event.type === "provider") {
            ui.status.textContent = event.available
              ? "Voice available: " + event.provider
              : "Voice unavailable: " +
                event.provider +
                " · switching to the fallback voice";
          } else if (event.type === "error") {
            if (event.fatal) {
              void fail(new Error(event.message));
              return;
            }
            if (event.scope === "editing") {
              editing = event.pending > 0;
              ui.working(editing);
            }
            ui.status.textContent = event.message;
            ui.state("error");
          }
        });
        readyTimer = setTimeout(() => {
          void fail(
            new Error(
              "The voice is not joining the conversation. Check the voice service.",
            ),
          );
        }, 30_000);
        await call.connect(data.url, data.token);
        await call.startAudio();
        await call.localParticipant.publishTrack(mic, {
          source: Track.Source.Microphone,
        });
        meter = ui.meter(new MediaStream([mic.mediaStreamTrack]));
        ui.pause();
        if (label) label.textContent = "Terminer";
        ui.button.setAttribute("aria-pressed", "true");
        ui.state("listening");
        ui.status.textContent =
          "En attente de la voix · micro : " + mic.mediaStreamTrack.label;
        silenceTimer = setTimeout(() => {
          if (meter && meter.peak() < 3)
            ui.status.textContent =
              "No sound from the microphone. End the call and pick another input.";
        }, 10_000);
      } catch (error) {
        await fail(error);
      } finally {
        joining = false;
        ui.button.disabled = false;
      }
    })();
  });
  window.addEventListener("pagehide", () => {
    void stop();
  });
}
