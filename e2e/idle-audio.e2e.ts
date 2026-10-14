import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SILENT_AUDIO_DATA_URI } from "../packages/client/src/lib/silent-audio.js";
import { seedUIState } from "./ui-state-fixture.js";
import { clickTopbarPanel } from "./topbar-navigation.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test.beforeEach(async ({ page }) => {
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    appAccentPulseMode: false,
  });
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    const contexts: AudioContext[] = [];
    const endedOscillators = { count: 0 };
    const suspensions: Promise<void>[] = [];
    Object.assign(window, {
      __idleAudioContexts: contexts,
      __idleAudioEnded: endedOscillators,
      __idleAudioSuspensions: suspensions,
    });
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }

      createOscillator() {
        const oscillator = super.createOscillator();
        oscillator.addEventListener("ended", () => endedOscillators.count++);
        return oscillator;
      }

      suspend() {
        const pending = super.suspend();
        suspensions.push(pending);
        return pending;
      }
    };
  }, version);
  await page.goto("/");
});

test("ordinary navigation does not start the Game audio engine", async ({ page }) => {
  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    audioManager.setVolumes(0.5, 0.5, 0.35);
    audioManager.setMuted(true);
    audioManager.setMuted(false);
  });
  await clickTopbarPanel(page, "settings");
  const states = await page.evaluate(() =>
    (window as unknown as { __idleAudioContexts: AudioContext[] }).__idleAudioContexts.map((ctx) => ctx.state),
  );
  expect(states).toEqual([]);
});

test("notification pings suspend their audio context, including overlapping and later pings", async ({ page }) => {
  await page.evaluate(async () => {
    const { playNotificationPing } = await import("/src/lib/notification-sound.ts" as string);
    const button = document.createElement("button");
    button.textContent = "Audio regression ping";
    button.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
    button.onclick = () => {
      playNotificationPing();
      setTimeout(() => playNotificationPing(), 100);
    };
    document.body.append(button);
  });
  const button = page.getByRole("button", { name: "Audio regression ping", exact: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await button.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = window as unknown as {
            __idleAudioContexts: AudioContext[];
            __idleAudioEnded: { count: number };
          };
          return {
            states: probe.__idleAudioContexts.map((ctx) => ctx.state),
            ended: probe.__idleAudioEnded.count,
          };
        }),
      )
      .toEqual({ states: ["suspended"], ended: (attempt + 1) * 4 });
  }
});

test("leaving Game suspends its audio engine and a later gesture can resume it", async ({ page }) => {
  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    const button = document.createElement("button");
    button.textContent = "Audio regression unlock";
    button.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
    button.onclick = () => audioManager.unlock();
    document.body.append(button);
  });
  const states = () =>
    page.evaluate(() =>
      (window as unknown as { __idleAudioContexts: AudioContext[] }).__idleAudioContexts.map((ctx) => ctx.state),
    );
  const button = page.getByRole("button", { name: "Audio regression unlock", exact: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await button.click();
    await expect.poll(states).toEqual(["running"]);
    await page.evaluate(async () => {
      const { audioManager } = await import("/src/lib/game-audio.ts" as string);
      audioManager.dispose();
      audioManager.unlock();
      await Promise.all((window as unknown as { __idleAudioSuspensions: Promise<void>[] }).__idleAudioSuspensions);
    });
    await expect.poll(states).toEqual(["running"]);
    await page.evaluate(async () => {
      const { audioManager } = await import("/src/lib/game-audio.ts" as string);
      audioManager.dispose();
    });
    await expect.poll(states).toEqual(["suspended"]);
    await page.evaluate(async () => {
      const { audioManager } = await import("/src/lib/game-audio.ts" as string);
      audioManager.setVolumes(0.4, 0.3, 0.2);
      audioManager.setMuted(true);
      audioManager.setMuted(false);
    });
    expect(await states()).toEqual(["suspended"]);
  }
});

for (const downloadFails of [false, true]) {
  test(`leaving Game cancels a pending sound when its download ${downloadFails ? "fails" : "finishes"}`, async ({
    page,
  }) => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => (releaseDownload = resolve));
    const soundUrl = "/api/game-assets/file/idle-regression.wav";
    await page.route(`**${soundUrl}`, async (route) => {
      await downloadGate;
      await route.fulfill({
        status: downloadFails ? 404 : 200,
        contentType: "audio/wav",
        body: Buffer.from(SILENT_AUDIO_DATA_URI.split(",")[1]!, "base64"),
      });
    });
    await page.evaluate(async (url) => {
      const { audioManager } = await import("/src/lib/game-audio.ts" as string);
      const button = document.createElement("button");
      button.textContent = "Audio regression delayed sound";
      button.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
      const probe = { started: 0, ready: Promise.resolve() };
      Object.assign(window, { __idleAudioOneShot: probe });
      button.onclick = () => {
        audioManager.unlock();
        probe.ready = audioManager.playOneShot(url, { volume: 0.5, onStarted: () => probe.started++ }).ready;
      };
      document.body.append(button);
    }, soundUrl);
    try {
      const requested = page.waitForRequest(`**${soundUrl}`);
      await page.getByRole("button", { name: "Audio regression delayed sound", exact: true }).click();
      await requested;
      await page.evaluate(async () => {
        const { audioManager } = await import("/src/lib/game-audio.ts" as string);
        audioManager.dispose();
        await Promise.all((window as unknown as { __idleAudioSuspensions: Promise<void>[] }).__idleAudioSuspensions);
      });
      releaseDownload();
      const result = await page.evaluate(async () => {
        const probe = window as unknown as {
          __idleAudioContexts: AudioContext[];
          __idleAudioOneShot: { started: number; ready: Promise<void> };
        };
        await probe.__idleAudioOneShot.ready;
        return { started: probe.__idleAudioOneShot.started, states: probe.__idleAudioContexts.map((ctx) => ctx.state) };
      });
      expect(result).toEqual({ started: 0, states: ["suspended"] });
    } finally {
      releaseDownload();
    }
  });
}
