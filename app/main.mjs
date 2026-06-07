import { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
app.setName("Super Chris World Cup");
const dataDir = join(app.getPath("userData"), "data");
process.env.WORLDCUPMAGIC_DATA_DIR = dataDir;

let mainWindow;
let splashWindow;
let tray;
let quitting = false;
let nextScheduleTimer;
let getDashboardState;
let scanForBets;
let saveAppSettings;
let handoffComplete = false;

await app.whenReady();
logStartup("app ready");
({ getDashboardState, scanForBets, saveAppSettings } = await import("../src/app-service.mjs"));
logStartup("app service imported");
createSplashWindow();
createMainWindow();
createTray();
scheduleNextBackgroundScan();

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  }
  mainWindow.show();
});

app.on("before-quit", () => {
  quitting = true;
});

ipcMain.handle("dashboard:get", async () => getDashboardState());
ipcMain.handle("settings:save", async (_event, settings) => saveAppSettings(settings));
ipcMain.handle("scan:run", async (_event, settings) => scanForBets(settings, { scheduled: false }));
ipcMain.handle("report:openData", async () => {
  await shell.openPath(dataDir);
  return dataDir;
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: "#f5f0e7",
    title: "Super Chris's World Cup Betting Engine",
    icon: join(appDir, "assets", "world-cup-hero.png"),
    show: false,
    webPreferences: {
      preload: join(appDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(join(appDir, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    logStartup("main window ready-to-show");
    setTimeout(revealMainWindow, 3000);
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    logStartup(`main window failed to load: ${code} ${description}`);
  });

  setTimeout(revealMainWindow, 4200);

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSplashWindow() {
  logStartup("creating splash window");
  splashWindow = new BrowserWindow({
    width: 540,
    height: 760,
    resizable: false,
    movable: true,
    frame: false,
    alwaysOnTop: true,
    show: true,
    backgroundColor: "#092f25",
    icon: join(appDir, "assets", "world-cup-magik-splash.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  splashWindow.loadFile(join(appDir, "renderer", "splash.html"));
  splashWindow.webContents.on("did-finish-load", () => logStartup("splash loaded"));
  splashWindow.webContents.on("did-fail-load", (_event, code, description) => {
    logStartup(`splash failed to load: ${code} ${description}`);
  });
}

function revealMainWindow() {
  if (handoffComplete || !mainWindow) {
    return;
  }

  handoffComplete = true;
  splashWindow?.close();
  splashWindow = null;
  mainWindow.show();
  mainWindow.focus();
  logStartup("main window shown");
}

function createTray() {
  const image = nativeImage.createFromPath(join(appDir, "assets", "world-cup-hero.png")).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("Super Chris World Cup Betting Engine");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: "Scan now",
      click: async () => {
        const state = await getDashboardState();
        await scanForBets(state.settings, { scheduled: true });
        mainWindow?.webContents.send("scan:completed");
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function scheduleNextBackgroundScan() {
  clearTimeout(nextScheduleTimer);
  const next = nextScanDate(new Date());
  const delay = Math.max(1000, next.getTime() - Date.now());

  nextScheduleTimer = setTimeout(async () => {
    try {
      const state = await getDashboardState();
      await scanForBets(state.settings, { scheduled: true });
      mainWindow?.webContents.send("scan:completed");
    } catch (error) {
      mainWindow?.webContents.send("scan:error", error instanceof Error ? error.message : String(error));
    } finally {
      scheduleNextBackgroundScan();
    }
  }, delay);
}

function nextScanDate(now) {
  const scanHours = [8, 14, 20];

  for (const hour of scanHours) {
    const candidate = new Date(now);
    candidate.setHours(hour, 0, 0, 0);

    if (candidate > now) {
      return candidate;
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(scanHours[0], 0, 0, 0);
  return tomorrow;
}

function logStartup(message) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, "startup.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Startup logging is diagnostic only.
  }
}
