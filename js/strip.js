// Port of PhotoStrip.swift: stacks the photos vertically on white with a border around each.

const FRAME_WIDTH = 600;
const FRAME_HEIGHT = 500;
const BORDER = 30;

/**
 * @param {CanvasImageSource & { width: number, height: number }[]} photos
 * @returns {HTMLCanvasElement}
 */
export function makeStrip(photos) {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH + BORDER * 2;
  canvas.height = photos.length * (FRAME_HEIGHT + BORDER) + BORDER;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  photos.forEach((photo, index) => {
    const x = BORDER;
    const y = BORDER + index * (FRAME_HEIGHT + BORDER);
    // Aspect-fill the photo into its frame, cropping the overflow.
    const scale = Math.max(FRAME_WIDTH / photo.width, FRAME_HEIGHT / photo.height);
    const drawWidth = photo.width * scale;
    const drawHeight = photo.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, FRAME_WIDTH, FRAME_HEIGHT);
    ctx.clip();
    ctx.drawImage(
      photo,
      x + FRAME_WIDTH / 2 - drawWidth / 2,
      y + FRAME_HEIGHT / 2 - drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  });

  return canvas;
}
