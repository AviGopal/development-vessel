/**
 * ui_screenshot — Real screenshot capture resolver accessing Electron remote module to capture page and return base64 PNG with dimensions.
 * Output shape: obsidian:ui_screenshot
 */

import type { ResolverResult } from "./types.js";

export interface UiScreenshotPointer {
  type: "ui_screenshot";
  [key: string]: unknown;
}

export async function resolveUiScreenshot(pointer: UiScreenshotPointer): Promise<ResolverResult> {
  // Access Electron's require exactly as the proven read-only probe does.
  const req0 = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!req0) {
    return { shape: 'obsidian:ui_screenshot', body: { error: 'require unavailable', error_code: 'REQUIRE_NOT_FOUND' } };
  }
  try {
    const remote = req0('@electron/remote') as any;
    if (!remote) {
      return { shape: 'obsidian:ui_screenshot', body: { error: '@electron/remote unavailable', error_code: 'REMOTE_UNAVAILABLE' } };
    }
    const wc = remote.getCurrentWebContents();
    if (!wc || typeof wc.capturePage !== 'function') {
      return { shape: 'obsidian:ui_screenshot', body: { error: 'capturePage not available', error_code: 'CAPTURE_UNAVAILABLE' } };
    }
    const image = await wc.capturePage();
    const pngBuffer = image.toPNG();
    const base64Data = pngBuffer.toString('base64');
    const { width, height } = image.getSize();
    return {
      shape: 'obsidian:ui_screenshot',
      body: {
        shape: 'obsidian:ui_screenshot',
        media_type: 'image/png',
        data: base64Data,
        width,
        height,
        captured_at: new Date().toISOString()
      }
    };
  } catch (err) {
    return {
      shape: 'obsidian:ui_screenshot',
      body: {
        error: (err as Error).message,
        error_code: 'CAPTURE_FAILED'
      }
    };
  }
}
