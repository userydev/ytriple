import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";

// Original monochrome glyph from 3878808:src/desktop/main.ts.
// A template bitmap lets macOS adapt the menu-bar icon to its appearance.
export function createMenuBar(window: BrowserWindow) {
  const size = 20,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 3; y < 17; y++)
    for (let x = 3; x < 17; x++) {
      const marked =
        y < 10
          ? Math.abs(x - (y + 1)) < 1.5 || Math.abs(x - (19 - y)) < 1.5
          : Math.abs(x - 10) < 1.5;
      if (marked) pixels[(y * size + x) * 4 + 3] = 255;
    }
  const image = nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
  });
  image.setTemplateImage(true);
  const tray = new Tray(image);
  const show = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  tray.setToolTip("ytriple");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 ytriple", click: show },
      { type: "separator" },
      { label: "退出 ytriple", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", show);
  return tray;
}
