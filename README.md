# FilterCam (web)

Web port of the FilterCam iOS app: a front-camera photo booth that counts down 3-2-1,
takes four photos with a flash, and lays them out as a photo strip. The optional
**Mosh** filter is a real-time datamosh (block motion estimation + feedback), ported
from the Metal compute kernels to WebGL2 fragment shaders.

No build step and no dependencies.

## Run locally

```sh
python3 -m http.server 5173   # or: npx serve .
```

Then open http://localhost:5173. Browsers only allow camera access on `localhost` or over HTTPS.

## Files

| Web | Ported from |
| --- | --- |
| `js/main.js` | `ContentView.swift` (screens, countdown, shooting), `ResultView` |
| `js/camera.js` | `CameraService.swift` (getUserMedia instead of AVCaptureSession) |
| `js/mosh.js` | `MoshRenderer.swift` + `Mosh.metal` (WebGL2 instead of Metal) |
| `js/strip.js` | `PhotoStrip.swift` (canvas instead of UIGraphicsImageRenderer) |

Differences from the iOS app: **Save** downloads a PNG (browsers can't write to the
Photos library directly), and **Share** uses the Web Share API, so it only appears
in browsers that support sharing files (mostly mobile Safari/Chrome).
