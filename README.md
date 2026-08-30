# Geordie Print Lab - Photoshop plugin

The same halftone and separation engine as the web tool at
`geordieprintco.co.uk/print-lab/`, running inside Photoshop on the open
document.

## What it does

Reads the pixels of the selected layer, runs them through the Print Lab
pipeline - adjustments, background knockout, halftone screen, print levels,
cleanup, underbase - and writes them back as a single undo step.

It is not a copy of the web tool's maths. It is literally the same file:
`engine.js` here is byte-identical to the one the website serves, and a test
fails if they ever drift apart. The same artwork with the same settings gives
the same pixels in both places.

## Licence keys

Every member gets their own key on their membership page. The plugin checks it
against the shop:

- on start-up, and
- again on every Apply.

Checking on Apply is the point. A panel left open for a fortnight would
otherwise keep working long after someone cancelled.

The key works on two computers. There is a "sign out of all computers" button
on the membership page for when someone gets a new machine.

If the shop cannot be reached, the plugin keeps working for **14 days** from
the last successful check, then stops. That is so somebody on a train does not
lose the tool mid-job, without leaving a cancelled member running forever.

A lapsed membership stops the plugin but **keeps the key stored**, so paying
again picks straight back up with nothing to retype.

## What is in here

| File | What it is |
|---|---|
| `manifest.json` | UXP plugin manifest |
| `index.html` / `index.js` / `styles.css` | the panel |
| `engine.js` | the imaging pipeline - **shared with the website, do not edit here** |
| `studio.js` | settings and what Apply does |
| `licence.js` | key handling. No Photoshop API in it |
| `bridge.js` | the only file that talks to Photoshop |
| `test/` | the tests |

`bridge.js` is deliberately the only file that touches Photoshop. That is what
makes the rest testable without it.

## Tests

```sh
node test/run.js            # 67 checks - engine sync, licence logic, the
                            # Photoshop calls against a fake Photoshop
python3 test/panel.py       # 26 checks - the real panel in a browser, with
                            # Photoshop stubbed: wiring, the gate, contrast
node test/live-licence.js <key>   # 12 checks against the live shop
```

`test/run.js` includes the guard that matters most: it reads the website's own
`dtx.js`, lifts its defaults out of the source, and fails if any setting the
plugin sends disagrees with the website's. It also fails if `engine.js` here is
not byte-identical to the site's.

### What the tests do not cover

`imaging.getPixels` and `imaging.putPixels` against a real document. That needs
Photoshop. Everything up to and including the arguments handed to those two
calls is covered, and the fake Photoshop asserts the call shape, but the round
trip through a real document has to be tried on a real machine.

## Requirements

- Photoshop 24.0 or newer (2023 onwards)
- RGB, 8 bits per channel, and a normal pixel layer selected

The panel refuses anything else with a sentence explaining what to change,
rather than producing something wrong.

## Keeping the engine in step with the website

```sh
./sync-engine.sh            # copies the site's engine in, then runs the tests
```

Never edit `engine.js` here. Edit it on the website and re-sync, or the two
drift and a customer gets different results in the two places.
