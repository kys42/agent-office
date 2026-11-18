// Reuse the approved PNG; Electron's image codec avoids an OS-specific image toolchain.
const { app, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
app
  .whenReady()
  .then(() => {
    const png = nativeImage
      .createFromPath(path.resolve('public/icon.png'))
      .resize({ width: 256, height: 256 })
      .toPNG();
    if (!png.length) throw new Error('Cannot read public/icon.png');
    // ICO directory followed by a PNG-compressed 256px image (0 denotes 256).
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(header.length, 18);
    writeFileSync('public/icon.ico', Buffer.concat([header, png]));
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
