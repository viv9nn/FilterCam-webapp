// Owns the front-camera stream. Port of CameraService.swift.

export class CameraError extends Error {
  /** @param {'denied' | 'unavailable' | 'insecure'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export class Camera {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  /** Starts the front camera, prompting for permission the first time. */
  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('insecure', 'The camera only works over HTTPS or on localhost.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
    } catch (error) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        throw new CameraError('denied', error.message);
      }
      throw new CameraError('unavailable', error.message);
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    // Wait until we know the frame size.
    if (!this.video.videoWidth) {
      await new Promise((resolve) => this.video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Grabs the current frame, mirrored so it matches the preview. */
  capturePhoto() {
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, 0, 0, width, height);
    return canvas;
  }
}
