import dotenv from "dotenv";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENT_URLS = (process.env.EVENT_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HEADLESS = process.env.HEADLESS !== "false";
const ALERT_ON_FIRST_AVAILABLE = process.env.ALERT_ON_FIRST_AVAILABLE === "true";

const dataDir = path.join(__dirname, "..", "data");
const stateFile = path.join(dataDir, "state.json");

if (!EVENT_URLS.length) {
  throw new Error("EVENT_URLS não definido no .env");
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos no .env");
}

async function ensureStateFile() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(stateFile);
  } catch {
    await fs.writeFile(stateFile, JSON.stringify({}, null, 2));
  }
}

async function readState() {
  await ensureStateFile();
  const raw = await fs.readFile(stateFile, "utf-8");
  return JSON.parse(raw);
}

async function writeState(nextState) {
  await ensureStateFile();
  await fs.writeFile(stateFile, JSON.stringify(nextState, null, 2));
}

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: true,
  });
}

async function getPageStatus(browser, eventUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    await page.goto(eventUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(8000);

    const currentUrl = page.url();
    const title = await page.title().catch(() => "");
    const bodyTextRaw = await page.locator("body").innerText().catch(() => "");
    const bodyText = (bodyTextRaw || "").trim();

    const normalizedText = bodyText
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

    const snippet = bodyText.slice(0, 500);

    if (
      normalizedText.includes("ATIVIDADE SUSPEITA") ||
      normalizedText.includes("SUSPEITA") ||
      normalizedText.includes("VERIFY YOU ARE HUMAN") ||
      normalizedText.includes("ACCESS DENIED") ||
      normalizedText.includes("CAPTCHA") ||
      normalizedText.includes("BOT") ||
      normalizedText.includes("UNUSUAL TRAFFIC")
    ) {
      return {
        status: "blocked",
        statusText: snippet,
        matchedBy: "texto de bloqueio/antibot",
        currentUrl,
        title,
      };
    }

    const pickerBar = page.locator("#picker-bar").first();
    const pickerBarExists = (await pickerBar.count()) > 0;
    const searchRoot = pickerBarExists ? pickerBar : page.locator("body");

    const soldOutBox = searchRoot.locator(".event-status.status-soldout").first();
    const soldOutVisible = await soldOutBox.isVisible().catch(() => false);

    if (soldOutVisible) {
      const statusText = (await soldOutBox.innerText().catch(() => "")) || "";
      return {
        status: "sold_out",
        statusText: statusText.trim(),
        matchedBy: ".event-status.status-soldout",
        currentUrl,
        title,
      };
    }

    const availableCta = searchRoot
      .locator(
        '.action-container.picker-full button.btn-primary.next, button.btn-primary.next, a, button, [role="button"]'
      )
      .filter({
        hasText:
          /INGRESSOS|COMPRAR|SELECIONAR INGRESSOS|VER INGRESSOS|ESCOLHER INGRESSOS/i,
      })
      .first();

    const availableCtaVisible = await availableCta.isVisible().catch(() => false);
    const availableCtaDisabled = await availableCta.isDisabled().catch(() => false);

    if (availableCtaVisible && !availableCtaDisabled) {
      const statusText = (await availableCta.innerText().catch(() => "")) || "";
      return {
        status: "available",
        statusText: statusText.trim(),
        matchedBy: "CTA visível de ingresso/compra",
        currentUrl,
        title,
      };
    }

    const genericSoldOutByText =
      normalizedText.includes("ESGOTADO") || normalizedText.includes("SOLD OUT");

    if (genericSoldOutByText) {
      return {
        status: "sold_out",
        statusText: "ESGOTADO",
        matchedBy: "texto global da página",
        currentUrl,
        title,
      };
    }

    return {
      status: "unknown",
      statusText: snippet,
      matchedBy: "nenhum seletor encontrado",
      currentUrl,
      title,
    };
  } finally {
    await context.close();
  }
}

async function checkOnce() {
  const now = new Date().toISOString();
  const state = await readState();
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    for (const eventUrl of EVENT_URLS) {
      const previousState = state[eventUrl];
      const previous = previousState?.lastStatus || "unknown";
      const hasPreviousState = !!previousState;

      try {
        const result = await getPageStatus(browser, eventUrl);
        const currentStatus = result.status;

        console.log(`[${now}] ${eventUrl} -> ${currentStatus}`);

        const shouldSendAlert =
          hasPreviousState &&
          previous === "sold_out" &&
          currentStatus === "available";
        const shouldSendTestAlert =
          ALERT_ON_FIRST_AVAILABLE &&
          !shouldSendAlert &&
          previous !== "available" &&
          currentStatus === "available";

        if (shouldSendAlert || shouldSendTestAlert) {
          const prefix = shouldSendTestAlert
            ? "🧪 Teste de monitoramento"
            : "🚨 Ingresso disponível!";

          await sendTelegramMessage(
            `${prefix}\n\n${eventUrl}\n\nTexto detectado: ${result.statusText || "CTA de compra visível"}`
          );

          console.log(`[${now}] Alerta enviado.`);
        }

        state[eventUrl] = {
          lastStatus: currentStatus,
          lastCheckedAt: now,
          lastAlertAt: shouldSendAlert || shouldSendTestAlert
            ? now
            : previousState?.lastAlertAt || null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${now}] ${eventUrl} -> error: ${message}`);
      }
    }

    await writeState(state);
  } finally {
    await browser.close();
  }
}

async function bootstrap() {
  console.log(`Monitor iniciado para ${EVENT_URLS.length} datas.`);
  await checkOnce();

  setInterval(async () => {
    await checkOnce();
  }, CHECK_INTERVAL_MS);
}

bootstrap();
