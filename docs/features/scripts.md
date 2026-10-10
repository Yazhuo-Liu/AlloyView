# Command scripts

A script is a list of commands, one per line, that moves the camera, changes
the frame, chooses colors, steps a slice, adds camera keyframes and downloads
images. Scripts use the same command names as the
[keyboard shortcuts](keyboard.md), so anything a key can do, a line can do.

## Controls

Open **Visualization tools → Scripts**.

- **Commands** is the editor. Problems are checked as you type and the first
  one is shown below the editor with its line and column.
- **Run** starts the script; **Stop** ends it after the command that is
  running, and interrupts a wait at once. The editor is locked while a script
  runs. If a command fails, the script stops and the command is selected in
  the editor.
- **Check** validates without running and reports how many commands the script
  would run, how many images it would download and how long it waits.
- **Insert example** adds a ready-made script. **Insert current view** writes a
  `camera set …` line that reproduces the view on screen.
- **Import text file** and **Export text file** read and write plain text.
  **Script**, **New** and **Delete** manage up to 16 scripts.
- **Command reference** lists every command, including the keyboard command
  names of this version.

Nothing runs when a script is typed, imported or restored from a
configuration. Only **Run** starts a script.

A script, a camera-path preview and a movie export use the viewport one at a
time; starting one while another runs is refused with a message.

## Language

```text
# Six images of the displayed frame
camera view front
export png front
repeat 3
  camera orbit 90 0      # a quarter turn
  export png
end
```

- One command per line. Blank lines and indentation are ignored.
- `#` starts a comment that runs to the end of the line.
- Arguments are separated by spaces or tabs. An argument is a number
  (`12`, `-0.5`, `1e-3`), a word (`front`, `c_pe`) or quoted text
  (`"Crystal structure (CNA)"`). Inside quotes, `\"` is a quote and `\\` a
  backslash; `#` is ordinary text.
- Angles are in degrees. Lengths are in the structure's length unit (Å).
  Frames are numbered from 1, as in the trajectory bar.

### Commands

| Command | Effect |
| --- | --- |
| `frame <n>` | Show frame `n` and wait until its enabled analyses have finished. |
| `frame first`, `frame last`, `frame next`, `frame prev` | The same for the first, last, following or preceding frame. `next` at the last frame and `prev` at the first are errors. |
| `camera view <name>` | A standard view in parallel projection, as the view buttons: `front`, `back`, `left`, `right`, `top` or `bottom`. |
| `camera reset` | Frame the whole structure, as the reset button. |
| `camera orbit <azimuth> <elevation>` | Add to the azimuth and elevation. While **Keep Z pointing upward** is on, the elevation stops just short of ±90°. |
| `camera roll <angle>` | Roll about the viewing direction; releases **Keep Z pointing upward**. |
| `camera zoom <factor>` | Divide the distance (perspective) or the field width (parallel) by the factor: above 1 moves closer. 0.01–100. |
| `camera pan <right> <up>` | Move the view center in the screen plane by these lengths. |
| `camera set <name> <value> …` | Set any of `azimuth`, `elevation`, `roll`, `distance`, `fov` (1–175), `field-height` (visible height in parallel projection), `center <x> <y> <z>`, `projection` (`perspective` or `orthographic`) and `upright` (`on` or `off`). A nonzero `roll` turns `upright` off unless the line says otherwise. |
| `projection <mode>` | `perspective` or `orthographic`. |
| `color-by <quantity>` | Choose a **Color by** entry by its property name (`coordination`, `c_pe`), its label (`"Atom type"`) or `type`. |
| `tool <id>` | Open a tool panel (`display`, `slice`, `cna`, `movie`, …); `tool none` closes the open one. Opening a panel does not start an analysis. |
| `slice step <n>` | Move the selected cutting plane by `n` of its own steps (−1000 to 1000, not 0). |
| `export png [name]` | Download a PNG with the Display image settings. Without a name the file is `<structure>-frame-<n>.png`. Names use letters, digits, spaces and `_ . ( ) + -`. |
| `keyframe [seconds]` | Add the view on screen to the [camera path](movies.md): at the given time, or 2 s after the last keyframe. |
| `keyframe clear` | Remove all camera keyframes. |
| `wait <seconds>` | Pause for 0–60 s. |
| `wait-analyses` | Wait until no analysis is queued, calculating or reading, and no frame is loading. |
| `gear <0–9>` | Step size for the keyboard commands that follow, in this script only. Gear 5 is 1× and each gear doubles; a script always starts at gear 5, whatever the keyboard gear is. |
| `repeat <n>` … `end` | Run the enclosed lines `n` times. |
| *keyboard command name* | Any name of the shortcut list, such as `camera.yaw-left`, `camera.view-top`, `frames.next`, `slice.flip`, `origin.move-a-forward` or `interface.theme`. No arguments. |

Keyboard command names are listed in the panel's **Command reference** and in
the shortcuts dialog. They act exactly as their keys: `camera.yaw-left` orbits
by 5° at gear 5, `camera.zoom-in` zooms by exp(0.05), and so on. A command
whose key would do nothing at that moment, such as `frames.next` at the last
frame, stops the script with “is not available now”. In a script, `frames.*`
and `image.png` wait for the frame or the image like `frame` and `export png`.

`frame` does not reload a frame that is already displayed and then does not
wait; `wait-analyses` waits for analyses that were started in another way,
for example by a button just before **Run**. “A frame is loading” means that
the loading indicator over the view is shown. The operation that shows it
always hides it, also when another frame request replaces it, so the wait
ends when the work does.

`camera set` takes its values at face value. Azimuth 0° with elevation 0° is
the front view; elevation 90° is the top view. With `upright on` the elevation
must be within ±90°. `field-height` does not depend on the window shape, so a
saved view looks the same on another screen.

Scripts have no variables, arithmetic or conditions.

### Limits

| Limit | Value |
| --- | --- |
| Script length | 20,000 characters, 2,000 lines, 400 characters per line |
| Arguments | 24 per command; 256 characters per argument |
| `repeat` | 10,000 iterations per loop, 8 loops deep |
| Commands run | 100,000 per run; each loop iteration counts as one |
| `wait` | 60 s per command |
| Run time | 30 minutes |
| Images | 100 downloads per run |
| Saved scripts | 16, with names up to 64 characters |

Length, nesting, the number of commands, the total of the waits and the
number of images are computed before a script starts; a script that would
exceed a limit does not run. The command count, the image count and the run
time are checked again while running.

Browsers may ask for permission when a page downloads several files.

## Errors

A problem is reported as `Line 3, column 7: message` and its text is selected
in the editor. Problems found before running include unknown commands (with
the closest name as a suggestion), wrong argument counts and types, values out
of range, unclosed quotes and unmatched `repeat` or `end`. Problems that
depend on the session, such as a frame beyond the end of the trajectory, an
unknown color quantity or no selected cutting plane, stop the script at that
line. Earlier commands are not undone.

## Safety

Scripts are text that other people can send you, alone or inside a
[configuration](configuration.md). They are treated as untrusted input.

- A script is split into words, numbers and quoted text, and each line is
  matched against a fixed table of commands. Script text is never evaluated as
  JavaScript: there is no `eval`, no `Function` and no dynamic import. Names
  such as `constructor` or `__proto__` are unknown commands.
- Every argument is checked against its command: a number within a range, one
  of a fixed set of words, or text that is only compared with existing names.
- The only effects are those in the command table. A script cannot read or
  write files, reach the network, open another structure, change or start an
  analysis, or import a configuration. The one thing that leaves the browser
  is a PNG download, at most 100 per run, with a file name from a restricted
  character set.
- All sizes, loop counts, waits and the run time are bounded, and **Stop**
  always works.
- A script from a configuration is validated for size and characters, shown
  in the editor and left alone until you select **Run**.

## Configuration

Scripts with text are saved under `settings.extensions.scripts`:

```json
{ "scripts": [{ "id": "script-1", "name": "Six views", "text": "camera view front\nexport png front" }],
  "selectedId": "script-1" }
```

Text may contain tabs and line breaks but no other control characters. A
configuration with other keys, more than 16 scripts or oversized text is
rejected as a whole. Restoring a configuration replaces the panel's scripts;
a configuration without scripts leaves them as they are.

## Implementation

`src/command-script.js` holds the language: `compileScript` tokenizes and
validates a script into plain instruction records and static bounds, and
`runScript` executes those records through a host object.
`src/script-controls.js` provides the host bound to the application
(`createScriptHost`), the panel, and the lock shared with the Movie panel.
Keyboard commands come from the registry in `src/keyboard-commands.js` and
`src/keyboard-controls.js`.

Tests: `tests/command-script.test.js` and `npm run test:browser:movies`.
