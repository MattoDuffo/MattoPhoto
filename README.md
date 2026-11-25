# MattoPhoto

A small web app for sending photos and videos from an iPhone straight to a laptop.
It runs at **https://mattoduffo.github.io/MattoPhoto/**.

## How to use it

1. On the laptop, open the site in **Chrome or Edge** and choose a save folder.
2. Scan the QR code with the iPhone's Camera app and tap the link.
3. On the iPhone, pick photos and videos and tap **Send**.

Tip: on the iPhone, use Share → **Add to Home Screen** on the paired page. The laptop keeps
the same pairing code, so the home-screen icon connects straight to it next time.

## How it works

- The phone and laptop connect directly with WebRTC. [PeerJS](https://peerjs.com)'s public
  server is used only to introduce the two devices; photos never pass through it.
- Only Apple's HEIC/HEIF photos are converted, to full-resolution JPEG at quality 95 with no
  chroma subsampling. Their Exif and XMP metadata (date and time, location, camera and lens)
  is copied into the JPEG. If a photo can't be converted, or its metadata wouldn't fully
  carry over, the original HEIC is sent instead. Everything else (JPEG, PNG, videos) is sent
  byte for byte, so its metadata is untouched.
- Each picked file shows whether it has a date and a location, so anything iOS removed
  before the app received it is visible.
- Duplicates are caught twice: the phone remembers what it sent, and the laptop skips files
  it has received before or that already exist in the folder with the same name and size.
- Without Chrome/Edge folder access, files go to the Downloads folder.

## Code

Everything lives in `site/` and is plain HTML, CSS and JavaScript with no build step.
`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main`.
PeerJS 1.5.4 and qrcode-generator 1.4.4 (both MIT) are bundled in `site/vendor/`, along with
a JPEG encoder adapted from jpeg-js 0.4.4 (BSD) to encode large photos in strips.
