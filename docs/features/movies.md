# Camera path and movie

Save camera views as keyframes, let the camera move smoothly between them, and
export the motion, a trajectory or both as a video file. Rendering and
encoding happen in the browser; nothing is uploaded.

## Controls

Open **Visualization tools → Movie**.

### Keyframes

1. Turn, pan and zoom the view to the first pose and select **Add keyframe**.
2. Change the view and add the next keyframe. Each new keyframe is placed 2 s
   after the last one; edit its time field to change that.
3. Select **Preview** to play the path in the viewport.

Each row of the list is one keyframe:

- the **time** in seconds (0–3600, in steps of 1 ms). Changing it moves the
  keyframe to its place in the order; two keyframes cannot share a time.
- **Go** shows the keyframe's view. **Set** replaces it with the view on
  screen.
- **↑** and **↓** exchange the view with the earlier or later keyframe; the
  times stay where they are.
- **×** deletes the keyframe. **Remove all** clears the path.

A path holds up to 64 keyframes. A keyframe stores the complete camera:
azimuth, elevation, roll, whether Z is kept upright, the orbit center,
distance, view angle, parallel scale and projection. It also stores the
trajectory frame that was displayed when it was added.

Keyframes can also be written by a [command script](scripts.md) with
`keyframe`, for example a turntable of four quarter turns.

Keyframes describe one structure. Opening another structure clears them; the
video settings stay.

### Motion and preview

**Motion** chooses how time maps to progress between two keyframes:

- **Steady through keyframes**: the camera passes through each keyframe
  without stopping.
- **Ease in and out at keyframes**: the camera starts and stops gently at each
  keyframe.

**Preview** plays the path in real time and then returns to the view and frame
it started from; select it again to stop early. Dragging or scrolling in the
viewport stops the preview at the current pose. With trajectory frames linked,
the preview shows frames as fast as they can be loaded and analyzed, so it may
skip frames that the exported movie contains.

### Trajectory frames

**Trajectory frames during the movie** links the displayed frame to time:

| Choice | Frame shown at time *t* |
| --- | --- |
| Keep the displayed frame | The frame on screen when the export starts. |
| Play frames at a rate | `first + step × floor(t × rate)`, holding the last frame of the range. The rate is in trajectory frames per second. |
| Spread frames over the camera path | `first + step × floor(t / T × K)` for a path of duration *T* and a range of *K* frames, so the range ends with the path. |
| Use the frame saved with each keyframe | Linear interpolation between the frames saved in the keyframes, rounded to the nearest frame. |

**First frame**, **Last frame** and **Step** select the range for the two
middle choices. A rate equal to the video frame rate gives one video frame per
trajectory frame; a higher rate skips frames and a lower one repeats them.

A movie needs something that moves: at least two keyframes, or frames played
at a rate. With frames played at a rate and no camera path, the camera is the
view on screen (or the single keyframe, if there is exactly one).

### Video file

| Setting | Meaning |
| --- | --- |
| **Format** | The container and codec. Only formats that this browser can encode at the chosen size, rate and quality are listed, followed by **PNG frames · ZIP**. |
| **Frames per second** | 1–120. |
| **Quality** | Low, Medium, High or Very high, or **Custom bitrate** in Mbit/s (0.1–400). |
| **Seek point every** | Seconds between video keyframes (0.1–10). Players can jump only to these; shorter intervals make seeking finer and files larger. They are unrelated to camera keyframes. |
| **Image size** | The same setting as **Display → Image resolution**: the viewport, 1080p, 4K, a multiple of the viewport or a custom size. |

The line below shows the number of frames, the duration, the image size, the
target bitrate and an estimate of the file size, or the reason why nothing can
be exported yet.

**Export movie** opens a progress window with the frame count, the encoded
size, the elapsed time and an estimate of the time left. Other controls are
blocked until the export ends, so that a stray click cannot change the scene
half-way. **Cancel** stops the export and saves nothing. When the export ends,
is cancelled or fails, the displayed frame and the camera return to where they
were. The file is named `<structure>-movie.mp4` or `.webm`.

## How the camera moves

For two neighboring keyframes at times t₀ and t₁, progress is
s = (t − t₀)/(t₁ − t₀), and u = s for steady motion or u = s²(3 − 2s) with
easing. Before the first and after the last keyframe the camera holds still.
At a keyframe's time the camera is exactly the keyframe.

**Orientation.**

- If both keyframes keep Z upright, the camera stays upright in between:
  the azimuth changes by the smaller of the two angles between them (never
  more than 180°) and the elevation changes linearly, both with u. Two views
  at the same elevation therefore give a turntable motion.
- Otherwise, at least one keyframe is rolled or tilted past the pole. Each
  keyframe's screen-right, screen-up and view axes form a rotation, which is
  converted to a unit quaternion q. The orientation in between is the
  spherical linear interpolation
  q(u) = [sin((1 − u)θ) q₀ + sin(uθ) q₁] / sin θ, with cos θ = q₀·q₁ and q₁
  negated if q₀·q₁ < 0, which is the rotation about a fixed axis by the
  smaller angle at constant angular speed. The upright constraint is released
  during such a segment and applies again at an upright keyframe; the view on
  screen is continuous at both ends.

A turn of more than 180° therefore needs an intermediate keyframe; a full
turntable uses keyframes a quarter or a third of a turn apart.

**Position and zoom.** The orbit center (three coordinates), the logarithm of
the distance, the logarithm of the parallel scale and the view angle each
follow a monotone cubic Hermite spline through their keyframe values
(Fritsch–Carlson limited tangents). The curve passes exactly through every
keyframe, has a continuous velocity with steady motion, and never leaves the
range between two neighboring keyframe values. Two equal neighbors hold the
value still, and the camera never comes closer than the closest keyframe.
With two keyframes this is a straight line for the center and a geometric
interpolation for the zoom.

**Projection.** Perspective and parallel projection are not blended. Each
segment uses the projection of its first keyframe, and the switch happens at
the keyframe.

## How a movie is made

The movie has N frames at times i/fps. A camera path of duration T gives
N = round(T × fps) + 1 frames, including the last pose. Frames played at a
rate over a range of K frames give N = round(K/rate × fps); if a camera path
is shorter than that, the camera holds its last pose until the frames end.

An export first waits until no analysis of the displayed frame is still
running. Then, for each video frame, AlloyView:

1. shows the trajectory frame for that time, if it differs from the displayed
   one, and waits until every enabled analysis of that frame has finished,
   exactly as the frame-image export does;
2. sets the camera for that time;
3. renders the image with the image export, so the legend, axes, text labels,
   slices and their outlines, bonds, vectors, dislocation lines and ambient
   occlusion appear as in a PNG, at the chosen image size, with antialiasing
   and tiles for large sizes. Text labels show the values of that frame;
4. hands the image to the browser's video encoder (WebCodecs `VideoEncoder`)
   and passes each encoded frame to the file writer.

Movies have no transparency, so the background is always drawn, as for JPG.

The renderer waits whenever more than two frames are queued in the encoder, so
images are not produced faster than they are encoded. Encoded data is collected
in blocks of 8 MiB that the browser can keep outside the page's memory; a few
uncompressed images exist at a time. The summary warns when the estimate
exceeds 1 GiB, and an export stops with a message at 2 GiB or 20,000 frames.

On a GTX 1080 Ti in Chrome, a 1920 × 1080 frame takes about 35–45 ms to render
and read back and 13–40 ms to encode, depending on the codec; a 120-frame
1080p movie of a 40-frame trajectory takes about 10 s.

### Formats

| Format | Codec | Notes |
| --- | --- | --- |
| MP4 · H.264 | H.264/AVC, High profile if the encoder offers it, else Main or Constrained Baseline; the level follows the image size, rate and bitrate | Plays almost everywhere, including presentation software. |
| WebM · VP9 | VP9 profile 0 | Smaller files; plays in browsers and VLC. |
| WebM · VP8 | VP8 | Larger files than VP9. VP8 cannot record its color matrix, so saturated colors may shift slightly in some players. |
| MP4 · AV1, WebM · AV1 | AV1 Main profile | Smallest files; needs a recent player. |
| MP4 · VP9 | VP9 profile 0 | VP9 in an MP4 file; plays in browsers. |
| PNG frames · ZIP | PNG | Lossless images named `<structure>-0001.png`, …, at most 500 frames and 256 MiB, for assembling elsewhere. Always available. |

AlloyView asks `VideoEncoder.isConfigSupported` for each format with the
actual image size, frame rate and bitrate, and lists a format only if the
answer is yes. The first listed format is used unless you choose another.
Encoders are asked for variable bitrate and quality-oriented (not real-time)
encoding.

All video formats store 8-bit 4:2:0 color, so the image width and height are
made even: an odd size is rendered one pixel narrower or shorter, and the
summary says so. H.264 requires this. VP8, VP9 and AV1 accept odd sizes, but
in Chrome such frames came out visibly less sharp when decoded again, so they
are treated alike. Chrome converts frames with the BT.709 color matrix; H.264,
VP9 and AV1 record the matrix and the value range in the video stream, so
players reproduce the colors of the PNG export.

The quality presets are bits per pixel per frame for H.264 and VP8: Low 0.05,
Medium 0.1, High 0.2, Very high 0.4. VP9 uses 0.7 times and AV1 0.6 times
those values for a similar picture. For 1920 × 1080 at 30 frames per second,
High is 12.4 Mbit/s for H.264. The bitrate is a target and an upper guide:
simple scenes produce smaller files.

To turn PNG frames into a video with ffmpeg:

```text
ffmpeg -framerate 30 -i structure-%04d.png -pix_fmt yuv420p movie.mp4
```

### Without a video encoder

WebCodecs video encoding needs a recent browser (for example Chrome or Edge
94, Safari 16.4 or Firefox 130, or later) and a secure page (HTTPS or
localhost). It does
not need cross-origin isolation. If the browser has no encoder, or none that
accepts the chosen size, the Movie panel says so and offers
**PNG frames · ZIP** with the same sequence of frames. The
[frame-image export](display.md#image-and-trajectory-exports) under Display
remains available for one image per trajectory frame.

## Limits

- One video track, constant frame rate, no audio and no transparency.
- The movie shows the main view; the second view is not recorded.
- H.264, VP8, VP9 and AV1 as the browser provides them; no HEVC.
- Up to 64 camera keyframes, 3600 s per path, 20,000 video frames and 2 GiB
  per file.
- The image size is limited by the image export (16,384 pixels per side,
  32 megapixels) and by the encoder; H.264 encoders usually stop at 4K.
- The frame and camera are restored after an export, but an export changes
  the displayed frame while it runs, which records analysis values in
  [time series](time-series.md) like any other frame visit.
- Closing or replacing the structure during an export cancels it.
- Exported files were read back with an independent container parser,
  decoded with the browser's `VideoDecoder` and a `<video>` element, and
  inspected with ffprobe. Playback in QuickTime and PowerPoint has not been
  tested.

## Configuration

A camera path or changed video settings are saved under
`settings.extensions.movie`:

```json
{ "path": {
    "keyframes": [
      { "time": 0, "frame": 0, "camera": { "yaw": 0, "pitch": 0.35, "roll": 0, "constrainUp": true, "fov": 0.698,
          "target": [10, 10, 10], "pan": [0, 0, 0], "distance": 60, "orthographicScale": 20, "projectionMode": "perspective" } },
      { "time": 2, "frame": 39, "camera": { "…": "…" } } ],
    "easing": "linear",
    "frames": { "mode": "fit", "first": 0, "last": null, "step": 1, "rate": 10 } },
  "output": { "format": "auto", "fps": 30, "quality": "high", "bitrateMbps": 12, "keyframeSeconds": 2 } }
```

Angles are in radians and frames count from 0, as elsewhere in configurations.
`easing` is `linear` or `ease`; `frames.mode` is `current`, `rate`, `fit` or
`keyframes`; `last: null` means the last frame of the trajectory; `format` is
`auto` (the first supported format) or a format ID such as `mp4-h264`,
`webm-vp9` or `png-zip`. Keyframe times must increase. Every value is checked
against its range on import and an invalid entry rejects the configuration.
Importing a configuration never starts an export.

## Implementation

- `src/camera-path.js`: keyframe editing, interpolation
  (`sampleCameraPath`), the trajectory link and the movie timeline
  (`planMovie`).
- `src/movie-export.js`: the render–encode loop with backpressure, progress,
  cancellation and restoration; `src/movie-settings.js`: limits, quality
  presets and validation.
- `src/video/codecs.js`: codec strings and level tables, encoder probing, and
  the VP9 and AV1 configuration records (the AV1 record is read from the
  sequence header of the first keyframe).
- `src/video/mp4-muxer.js`: an MP4 writer for one video track. The file is
  `ftyp`, `moov`, `mdat`, with the index before the data so that playback can
  start at once; the time scale is 512 ticks per frame; samples are grouped in
  chunks of half a second; a sync-sample table lists the seek points.
- `src/video/webm-muxer.js`: a WebM writer. SeekHead, Info, Tracks and Cues
  precede the Clusters; a Cluster starts at each video keyframe and has a cue;
  timestamps are in milliseconds.
- `src/video/byte-sink.js`: the block store for encoded data.
- `src/movie-controls.js`: the panel, the preview and the progress window.

Both writers are part of AlloyView; no third-party code or network access is
involved. Tests: `tests/camera-path.test.js`, `tests/video-muxers.test.js`
(with an independent container reader in `tests/helpers/video-containers.js`),
`tests/movie-export.test.js` and `npm run test:browser:movies`, which decodes
every exported format again in the browser.
