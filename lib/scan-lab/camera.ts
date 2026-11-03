export interface CameraInfo {
  settings: MediaTrackSettings;
  capabilities: MediaTrackCapabilities & {
    torch?: boolean;
    zoom?: { min: number; max: number; step: number };
  };
  devices: MediaDeviceInfo[];
  startupMs: number;
}
export class CameraSource {
  private stream?: MediaStream;
  private generation = 0;
  constructor(
    private media: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">,
  ) {}
  stop() {
    this.generation++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }
  async start(
    video: HTMLVideoElement,
    deviceId: string,
    width: number,
    onEnded: () => void,
  ): Promise<CameraInfo> {
    this.stop();
    const generation = this.generation,
      start = performance.now();
    const stream = await this.media.getUserMedia({
      audio: false,
      video: {
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: { ideal: "environment" } }),
        width: { ideal: width },
        height: { ideal: Math.round((width * 9) / 16) },
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException("Camera start cancelled", "AbortError");
    }
    this.stream = stream;
    try {
      video.srcObject = stream;
      await video.play();
      if (generation !== this.generation)
        throw new DOMException("Camera start cancelled", "AbortError");
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track available");
      track.addEventListener("ended", onEnded, { once: true });
      track.addEventListener("mute", onEnded, { once: true });
      const devices = (await this.media.enumerateDevices()).filter(
        (d) => d.kind === "videoinput",
      );
      if (generation !== this.generation)
        throw new DOMException("Camera start cancelled", "AbortError");
      return {
        settings: track.getSettings(),
        capabilities: track.getCapabilities?.() ?? {},
        devices,
        startupMs: performance.now() - start,
      };
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      if (generation === this.generation) {
        this.stream = undefined;
        video.srcObject = null;
      }
      throw e;
    }
  }
  async torch(enabled: boolean) {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
    if (!track || !caps?.torch)
      throw new Error("Torch is not supported by this camera");
    await track.applyConstraints({
      advanced: [{ torch: enabled } as MediaTrackConstraintSet],
    });
  }
}
export function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const messages: Record<string, string> = {
    NotAllowedError:
      "Camera permission denied. Allow camera access in this site's browser settings and retry.",
    NotFoundError: "No browser camera was found. Upload a still image instead.",
    NotReadableError:
      "Camera unavailable or in use. Close other camera apps and retry.",
    OverconstrainedError:
      "The chosen camera or resolution is unavailable. Select another camera and retry.",
    SecurityError: "Camera requires an HTTPS origin and browser permission.",
    AbortError: "Camera operation cancelled.",
  };
  return (
    messages[name] ?? "Camera could not start. Retry, or use an image upload."
  );
}
