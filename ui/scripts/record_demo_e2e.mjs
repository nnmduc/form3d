#!/usr/bin/env node
/**
 * End-to-End Playwright Automation & Demo Video Recorder for Form 3D Studio.
 *
 * Runs the full 5-step pipeline in the browser UI for "generate a cute dragon",
 * injects a visual cursor + click/drag ripple overlay, captures high-resolution
 * step-by-step screenshots, and exports:
 *   1. Full unedited MP4 video (`cute_dragon_full_test.mp4`)
 *   2. Trimmed + 2x sped-up demo video (`cute_dragon_demo_2x_cut.mp4`)
 */

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEMO_DIR = path.join(REPO_ROOT, "outputs", "cute_dragon", "demo");
const SCREENSHOTS_DIR = path.join(DEMO_DIR, "screenshots");
const RAW_VIDEO_DIR = path.join(DEMO_DIR, "raw_video");

const CHROME_EXEC_PATH =
  process.env.CHROME_EXEC_PATH ||
  path.join(
    process.env.HOME || "",
    "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  );

const PROMPT_TEXT = process.env.DEMO_PROMPT || "generate a cute dragon";
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(RAW_VIDEO_DIR, { recursive: true });

/**
 * Injects a visual macOS-style pointer cursor + #0071e3 click ripple + drag halo
 * so mouse movements, clicks, and 3D orbit drags are visible in screenshots & video.
 */
const CURSOR_INIT_SCRIPT = () => {
  const mountCursor = () => {
    if (document.getElementById("__demo-cursor-root")) return;

    const style = document.createElement("style");
    style.textContent = `
      #__demo-cursor-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
        overflow: hidden;
      }
      #__demo-cursor-pointer {
        position: fixed;
        top: 0;
        left: 0;
        width: 28px;
        height: 28px;
        transform: translate3d(-100px, -100px, 0);
        transition: transform 0.016s linear;
        will-change: transform;
        filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.28));
      }
      #__demo-cursor-halo {
        position: fixed;
        top: -18px;
        left: -18px;
        width: 36px;
        height: 36px;
        border-radius: 9999px;
        border: 2px solid rgba(0, 113, 227, 0.0);
        background: rgba(0, 113, 227, 0.0);
        transform: translate3d(-100px, -100px, 0) scale(0.8);
        transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.05s linear;
        will-change: transform;
      }
      #__demo-cursor-halo.is-down {
        border-color: rgba(0, 113, 227, 0.85);
        background: rgba(0, 113, 227, 0.16);
      }
      .__demo-click-ripple {
        position: fixed;
        width: 44px;
        height: 44px;
        margin-left: -22px;
        margin-top: -22px;
        border-radius: 9999px;
        border: 2.5px solid #0071e3;
        background: rgba(0, 113, 227, 0.22);
        pointer-events: none;
        animation: __demo-ripple-anim 0.55s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      @keyframes __demo-ripple-anim {
        0% {
          transform: scale(0.25);
          opacity: 1;
        }
        100% {
          transform: scale(1.65);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "__demo-cursor-root";

    const halo = document.createElement("div");
    halo.id = "__demo-cursor-halo";

    const pointer = document.createElement("div");
    pointer.id = "__demo-cursor-pointer";
    pointer.innerHTML = `
      <svg viewBox="0 0 28 28" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.5 3.2L22.2 14.3L14.3 15.9L18.4 23.6L15.1 25.3L11.1 17.6L6.2 22.1L5.5 3.2Z" fill="#141416" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `;

    root.appendChild(halo);
    root.appendChild(pointer);
    document.body.appendChild(root);

    let lastX = 720;
    let lastY = 450;
    let isPressed = false;

    const syncTransform = () => {
      const scale = isPressed ? 0.88 : 1;
      pointer.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) scale(${scale})`;
      halo.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) scale(${isPressed ? 1.08 : 0.8})`;
    };

    window.addEventListener(
      "mousemove",
      (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        syncTransform();
      },
      { passive: true, capture: true }
    );

    window.addEventListener(
      "mousedown",
      (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        isPressed = true;
        halo.classList.add("is-down");
        syncTransform();

        const ripple = document.createElement("div");
        ripple.className = "__demo-click-ripple";
        ripple.style.left = `${lastX}px`;
        ripple.style.top = `${lastY}px`;
        root.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
      },
      { passive: true, capture: true }
    );

    window.addEventListener(
      "mouseup",
      (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        isPressed = false;
        halo.classList.remove("is-down");
        syncTransform();
      },
      { passive: true, capture: true }
    );
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountCursor);
  } else {
    mountCursor();
  }
};

// Track current mouse position for smooth cubic interpolation
let cursorX = 720;
let cursorY = 450;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function smoothMove(page, targetX, targetY, steps = 22, durationMs = 340) {
  const startX = cursorX;
  const startY = cursorY;
  const stepDelay = Math.max(8, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    const x = startX + (targetX - startX) * t;
    const y = startY + (targetY - startY) * t;
    await page.mouse.move(x, y);
    await page.waitForTimeout(stepDelay);
  }
  cursorX = targetX;
  cursorY = targetY;
}

async function smoothClickLocator(page, locator, options = {}) {
  await locator.waitFor({ state: "visible", timeout: options.timeout ?? 30000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Could not resolve bounding box for locator");
  const targetX = box.x + box.width * (options.offsetXRatio ?? 0.5);
  const targetY = box.y + box.height * (options.offsetYRatio ?? 0.5);
  await smoothMove(page, targetX, targetY, options.steps ?? 20, options.moveMs ?? 320);
  await page.mouse.down();
  await page.waitForTimeout(options.holdMs ?? 130);
  if (options.screenshotDuringClick) {
    await page.screenshot({ path: options.screenshotDuringClick });
  }
  await page.mouse.up();
  await page.waitForTimeout(options.afterMs ?? 180);
}

async function smoothDrag3D(page, startX, startY, deltaX, deltaY, steps = 38, durationMs = 950) {
  await smoothMove(page, startX, startY, 16, 260);
  await page.mouse.down();
  await page.waitForTimeout(90);
  const stepDelay = Math.max(10, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    const x = startX + deltaX * t;
    const y = startY + deltaY * t;
    await page.mouse.move(x, y);
    await page.waitForTimeout(stepDelay);
  }
  cursorX = startX + deltaX;
  cursorY = startY + deltaY;
  await page.mouse.up();
  await page.waitForTimeout(180);
}

async function main() {
  console.log(`[Demo E2E] Launching Chromium with Metal WebGL acceleration...`);
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_EXEC_PATH) ? CHROME_EXEC_PATH : undefined,
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=metal",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--window-size=1440,900",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: RAW_VIDEO_DIR,
      size: { width: 1440, height: 900 },
    },
  });

  await context.addInitScript(CURSOR_INIT_SCRIPT);
  const page = await context.newPage();
  const videoStartMs = Date.now();
  const nowSec = () => Number(((Date.now() - videoStartMs) / 1000).toFixed(2));

  const timeline = {
    prompt: PROMPT_TEXT,
    marks: {},
  };

  console.log(`[Demo E2E] Opening ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.mouse.move(cursorX, cursorY);
  await page.waitForTimeout(500);
  timeline.marks.pageLoaded = nowSec();

  // Screenshot 00: Initial Idle Studio State
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "00_initial_studio.png"),
  });

  // Select "Live MPS" only if FORCE_LIVE=1 or if cute_dragon.glb does not exist yet
  const dragonGlbPath = path.join(
    REPO_ROOT,
    "outputs",
    "cute_dragon",
    "cute_dragon.glb"
  );
  if (process.env.FORCE_LIVE === "1" || !fs.existsSync(dragonGlbPath)) {
    const liveMpsBtn = page.locator('button:has-text("Live MPS")');
    if (await liveMpsBtn.isVisible()) {
      await smoothClickLocator(page, liveMpsBtn);
    }
  } else {
    const studioBtn = page.locator('button:has-text("Studio")');
    if (await studioBtn.isVisible()) {
      await smoothClickLocator(page, studioBtn);
    }
  }

  // Click into prompt input & type "generate a cute dragon"
  const promptInput = page.locator("input#object-prompt");
  await smoothClickLocator(page, promptInput);
  await promptInput.fill("");
  await page.keyboard.type(PROMPT_TEXT, { delay: 48 });
  await page.waitForTimeout(350);

  // Screenshot 01: Prompt typed + clicking Generate button with ripple visible
  const submitBtn = page.locator('button[aria-label="Generate 3D model"]');
  timeline.marks.submitClick = nowSec();
  await smoothClickLocator(page, submitBtn, {
    holdMs: 160,
    screenshotDuringClick: path.join(
      SCREENSHOTS_DIR,
      "01_step0_prompt_submit_click.png"
    ),
  });

  // Wait for Step 1 (Spec / optimizing) to start
  console.log(`[Demo E2E] Step 1 (Spec): Waiting for agy prompt optimization...`);
  timeline.marks.step1WaitStart = nowSec();
  await smoothMove(page, 720, 380, 18, 300);

  // Screenshot 02a: Step 1 Optimizing in progress
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02a_step1_spec_optimizing.png"),
  });

  // Wait until Step 1 completes ("Spatial specification ready" in bottom progress bar)
  await page
    .locator('footer span:has-text("Spatial specification ready")')
    .waitFor({ state: "visible", timeout: 180000 });
  timeline.marks.step1Ready = nowSec();
  await page.waitForTimeout(400);

  // Screenshot 02b: Step 1 Completed Spec Card for cute_dragon
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02_step1_spec_ready.png"),
  });
  console.log(`[Demo E2E] Step 1 completed at ${timeline.marks.step1Ready}s`);

  // Step 2: 2x2 Turnaround Sheet
  console.log(`[Demo E2E] Step 2 (Sheet): Waiting for agy image-generator 2x2 turnaround sheet...`);
  await page
    .locator('footer span:has-text("Synthesizing orthographic sheet")')
    .waitFor({ state: "visible", timeout: 30000 });
  timeline.marks.step2WaitStart = nowSec();

  // Wait for the real sheet.png image to appear
  const sheetImg = page.locator(
    'img[alt="Orthographic 2x2 turnaround reference sheet"]'
  );
  await sheetImg.waitFor({ state: "visible", timeout: 360000 });
  // Ensure naturalWidth > 0
  await page.waitForFunction(
    () => {
      const img = document.querySelector(
        'img[alt="Orthographic 2x2 turnaround reference sheet"]'
      );
      return img && img.complete && img.naturalWidth > 0;
    },
    { timeout: 30000 }
  );
  timeline.marks.step2Ready = nowSec();
  await smoothMove(page, 640, 420, 15, 250);
  await page.waitForTimeout(500);

  // Screenshot 03: Step 2 2x2 Turnaround Sheet
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "03_step2_turnaround_sheet.png"),
  });
  console.log(`[Demo E2E] Step 2 completed at ${timeline.marks.step2Ready}s`);

  // Step 3: 4 Sliced RGBA Orthographic Views
  console.log(`[Demo E2E] Step 3 (Views): Waiting for 4 RGBA views...`);
  timeline.marks.step3WaitStart = nowSec();
  await page.waitForFunction(
    () => {
      const imgs = Array.from(
        document.querySelectorAll('img[alt$="orthographic cutout"]')
      );
      return (
        imgs.length === 4 &&
        imgs.every((img) => img.complete && img.naturalWidth > 0)
      );
    },
    { timeout: 120000 }
  );
  timeline.marks.step3Ready = nowSec();
  await page.waitForTimeout(400);

  // Click Front view card to demonstrate interactive tile elevation
  const frontCard = page.locator('button:has(img[alt="Front orthographic cutout"])');
  if (await frontCard.isVisible()) {
    await smoothClickLocator(page, frontCard, { holdMs: 120 });
  }
  await page.waitForTimeout(300);

  // Screenshot 04: Step 3 4 Sliced RGBA Views
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "04_step3_sliced_rgba_views.png"),
  });
  console.log(`[Demo E2E] Step 3 completed at ${timeline.marks.step3Ready}s`);

  // Step 4 & 5: Multimodal View QA + Hunyuan3D-2mv Mesh Reconstruction
  console.log(`[Demo E2E] Step 4 & 5 (Mesh): Waiting for view verification & Hunyuan3D-2mv synthesis...`);
  await page
    .locator('footer span:has-text("Verifying views")')
    .waitFor({ state: "visible", timeout: 30000 })
    .catch(() => {});
  timeline.marks.step4WaitStart = nowSec();

  // Wait for Step 5 reconstruction state so we can capture the optical scanline screenshot
  await page
    .locator('footer span:has-text("Reconstructing watertight mesh")')
    .waitFor({ state: "visible", timeout: 180000 });
  timeline.marks.step5WaitStart = nowSec();
  await page.waitForTimeout(900);

  // Screenshot 05: Step 4/5 Reconstructing with Optical Scanline & Verified Parameters
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "05_step4_mesh_reconstructing_scanline.png"),
  });

  // Wait for final 3D stage ("complete") when Export button appears in bottom dock
  const exportLink = page.locator('footer a:has-text("Export")');
  await exportLink.waitFor({ state: "visible", timeout: 480000 });
  timeline.marks.step5Complete3DStage = nowSec();
  console.log(
    `[Demo E2E] Step 5 completed! Entered 3D stage at ${timeline.marks.step5Complete3DStage}s`
  );

  // Wait 1.5s for Three.js GLTFLoader to finish loading cute_dragon.glb onto the studio pedestal
  await page.waitForTimeout(1600);

  // Screenshot 06: Initial 3D Turntable Stage (Studio PBR)
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "06_step5_3d_studio_initial.png"),
  });

  // INTERACTIVE 3D SHOWCASE:
  // 1. Move mouse onto the 3D canvas and drag/orbit the dragon model left, right, and tilted
  console.log(`[Demo E2E] Orbiting 3D dragon model with mouse drag...`);
  timeline.marks.showcase3DStart = nowSec();
  await smoothDrag3D(page, 720, 440, -240, 35, 42, 1100);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "07_step5_3d_orbit_drag_left.png"),
  });

  await smoothDrag3D(page, 520, 460, 340, -45, 46, 1200);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "08_step5_3d_orbit_drag_right.png"),
  });

  // 2. Click Left-Docked Orthographic Views (Front -> Left -> Back -> Right) to show synced 2D/3D camera
  const leftDock = page.locator('aside[aria-label="Orthographic reference views"]');
  for (const viewLabel of ["Front", "Left", "Back", "Right"]) {
    const btn = leftDock.locator(`button[title^="${viewLabel}"]`);
    if (await btn.isVisible()) {
      await smoothClickLocator(page, btn, { holdMs: 130, afterMs: 650 });
      if (viewLabel === "Left") {
        await page.screenshot({
          path: path.join(SCREENSHOTS_DIR, "09_step5_3d_ortho_left_synced.png"),
        });
      }
    }
  }

  // Click "Free orbit" button on the right 2D reference card
  const freeOrbitBtn = page.locator('button:has-text("Free orbit")');
  if (await freeOrbitBtn.isVisible()) {
    await smoothClickLocator(page, freeOrbitBtn, { holdMs: 130, afterMs: 400 });
  }

  // 3. Switch Surface Shading to Clay & orbit the model
  const clayBtn = page.locator(
    'div[aria-label="Surface shading"] button:has-text("clay")'
  );
  await smoothClickLocator(page, clayBtn, { holdMs: 130, afterMs: 400 });
  await smoothDrag3D(page, 760, 440, -190, 25, 34, 850);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "10_step5_3d_clay_shading.png"),
  });

  // 4. Switch Surface Shading to Wireframe & orbit the model
  const wireBtn = page.locator(
    'div[aria-label="Surface shading"] button:has-text("wire")'
  );
  await smoothClickLocator(page, wireBtn, { holdMs: 130, afterMs: 400 });
  await smoothDrag3D(page, 600, 450, 210, -20, 34, 850);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "11_step5_3d_wire_topology.png"),
  });

  // 5. Switch back to Studio PBR shading & inspect Clay Mesh preview in "Mesh" stage scrubber briefly
  const studioBtn = page.locator(
    'div[aria-label="Surface shading"] button:has-text("studio")'
  );
  await smoothClickLocator(page, studioBtn, { holdMs: 130, afterMs: 400 });

  // Also click "Mesh" pill in top scrubber -> "Clay Mesh" toggle to capture the 2x2 clay mesh preview screenshot
  const meshScrubberBtn = page.locator(
    'nav[aria-label="Pipeline states"] button:has-text("Mesh")'
  );
  await smoothClickLocator(page, meshScrubberBtn, { holdMs: 130, afterMs: 400 });
  const clayPreviewToggle = page.locator('button:has-text("Clay Mesh")');
  if (await clayPreviewToggle.isVisible()) {
    await smoothClickLocator(page, clayPreviewToggle, {
      holdMs: 130,
      afterMs: 500,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "12_step5_clay_orthographic_preview.png"),
    });
  }

  // Return to "3D" stage, toggle dark mode & orbit, then click Export
  const stage3DBtn = page.locator(
    'nav[aria-label="Pipeline states"] button:has-text("3D")'
  );
  await smoothClickLocator(page, stage3DBtn, { holdMs: 130, afterMs: 600 });

  const themeBtn = page.locator('button[aria-label="Toggle appearance"]');
  await smoothClickLocator(page, themeBtn, { holdMs: 130, afterMs: 500 });
  await smoothDrag3D(page, 700, 430, -180, 20, 32, 800);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "13_step5_3d_dark_mode_orbit.png"),
  });

  // Toggle format (.stl -> .glb -> .stl) and hover Export CTA
  const formatBtn = page.locator('button[title="Switch export format"]');
  await smoothClickLocator(page, formatBtn, { holdMs: 120, afterMs: 350 });
  await smoothClickLocator(page, formatBtn, { holdMs: 120, afterMs: 350 });

  const exportBox = await exportLink.boundingBox();
  if (exportBox) {
    await smoothMove(
      page,
      exportBox.x + exportBox.width / 2,
      exportBox.y + exportBox.height / 2,
      18,
      300
    );
    await page.waitForTimeout(600);
  }

  timeline.marks.end = nowSec();
  fs.writeFileSync(
    path.join(DEMO_DIR, "timestamps.json"),
    JSON.stringify(timeline, null, 2)
  );

  const video = page.video();
  await context.close();
  await browser.close();

  const rawWebmPath = await video.path();
  console.log(`[Demo E2E] Raw WebM video saved to: ${rawWebmPath}`);

  // 1. Convert full test WebM to crisp H.264 MP4
  const fullMp4Path = path.join(DEMO_DIR, "cute_dragon_full_test.mp4");
  console.log(`[Demo E2E] Encoding full test MP4: ${fullMp4Path}`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      rawWebmPath,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      fullMp4Path,
    ],
    { stdio: "inherit" }
  );

  // 2. Build the 2x-speed + trimmed waiting-time demo video (`cute_dragon_demo_2x_cut.mp4`)
  buildCutAnd2xDemoVideo(fullMp4Path, timeline.marks);
}

function buildCutAnd2xDemoVideo(fullMp4Path, marks) {
  const demoCutMp4Path = path.join(DEMO_DIR, "cute_dragon_demo_2x_cut.mp4");
  const m = marks;

  // Define the active highlight segments from the recorded timeline, cutting out the long AI waiting mid-sections:
  // Each segment is [startSec, endSec, speedFactor]
  //   - Segment 1: Prompt entry & clicking submit + first 2.5s of Step 1 (1.25x speed)
  //   - Segment 2: Step 1 completion spec reveal + transition into Step 2 (1.5x speed)
  //   - Segment 3: Step 2 2x2 turnaround sheet reveal + Step 3 4 RGBA views isolation & click (1.35x speed)
  //   - Segment 4: Step 4/5 optical scanline reconstruction window (3s sample at 2.0x speed)
  //   - Segment 5: Full 3D interactive showcase (orbit drags, Front/Left/Back/Right camera sync, Clay, Wire, Dark mode, Export) at 1.5x speed
  const segments = [
    [0, Math.min((m.step1WaitStart || 6) + 2.5, m.step1Ready || 10), 1.25],
    [Math.max(0, (m.step1Ready || 20) - 0.8), (m.step1Ready || 20) + 4.2, 1.4],
    [
      Math.max(0, (m.step2Ready || 50) - 1.0),
      (m.step3Ready || 65) + 4.0,
      1.35,
    ],
    [
      m.step5WaitStart || 85,
      Math.min((m.step5WaitStart || 85) + 4.5, m.step5Complete3DStage || 120),
      2.0,
    ],
    [
      Math.max(0, (m.step5Complete3DStage || 120) - 0.5),
      m.end || 160,
      1.5,
    ],
  ];

  // Ensure monotonic non-overlapping segments
  const cleanSegments = [];
  let cursor = 0;
  for (const [rawStart, rawEnd, speed] of segments) {
    const s = Math.max(cursor, Number(rawStart.toFixed(2)));
    const e = Number(rawEnd.toFixed(2));
    if (e > s + 0.3) {
      cleanSegments.push([s, e, speed]);
      cursor = e;
    }
  }

  const filterParts = [];
  const concatInputs = [];
  cleanSegments.forEach(([start, end, speed], idx) => {
    const ptsMultiplier = (1 / speed).toFixed(4);
    filterParts.push(
      `[0:v]trim=start=${start}:end=${end},setpts=${ptsMultiplier}*(PTS-STARTPTS)[v${idx}]`
    );
    concatInputs.push(`[v${idx}]`);
  });
  const filterComplex = `${filterParts.join(";")};${concatInputs.join("")}concat=n=${cleanSegments.length}:v=1:a=0[outv]`;

  console.log(`[Demo E2E] Encoding trimmed + 2x demo MP4: ${demoCutMp4Path}`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      fullMp4Path,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      demoCutMp4Path,
    ],
    { stdio: "inherit" }
  );
  console.log(`[Demo E2E] Saved trimmed demo video: ${demoCutMp4Path}`);
}

main().catch((err) => {
  console.error("[Demo E2E] Failed:", err);
  process.exit(1);
});
