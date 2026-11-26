require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const APP_URL = process.env.APP_URL || "";
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Valida initData enviado por Telegram Mini App
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const hashBuf = Buffer.from(hash, "hex");
  const computedBuf = Buffer.from(computedHash, "hex");
  if (hashBuf.length !== computedBuf.length) return null;
  if (!crypto.timingSafeEqual(hashBuf, computedBuf)) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

// Endpoint que verifica al usuario y devuelve si es admin autorizado
app.post("/api/auth/verify", (req, res) => {
  const { initData } = req.body || {};
  const verifiedUser = verifyTelegramInitData(initData, BOT_TOKEN);

  if (!verifiedUser) {
    return res.status(401).json({
      authorized: false,
      isAdmin: false,
      message: "Sesión de Telegram no verificada"
    });
  }

  const isAdmin = ADMIN_IDS.includes(String(verifiedUser.id));
  return res.json({
    authorized: true,
    isAdmin,
    user: {
      id: verifiedUser.id,
      first_name: verifiedUser.first_name,
      username: verifiedUser.username || ""
    }
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Bot de Telegram (Long Polling para pruebas / desarrollo) ---
async function telegramApi(method, payload) {
  if (!BOT_TOKEN) return null;
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return resp.json();
}

async function handleBotUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || "");
  const isAdmin = ADMIN_IDS.includes(userId);

  if (msg.text === "/start" || msg.text === "/menu") {
    if (!APP_URL) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "Configura APP_URL en el servidor para abrir la Mini App."
      });
      return;
    }

    const clientUrl = `${APP_URL.replace(/\/$/, "")}/?mode=client`;
    const adminUrl = `${APP_URL.replace(/\/$/, "")}/?mode=admin`;

    // Botones inline: siempre el de Cliente; el de Admin solo si está autorizado
    const inlineKeyboard = [
      [{ text: "🛒 Ordenar ahora (Cliente)", web_app: { url: clientUrl } }]
    ];

    if (isAdmin) {
      inlineKeyboard.push([
        { text: "🛠️ Panel Admin (Autorizado)", web_app: { url: adminUrl } }
      ]);
    }

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: isAdmin
        ? "¡Hola Admin! Elige cómo quieres abrir la aplicación:"
        : "¡Hola! Toca el botón de abajo para ver el menú y hacer tu pedido:",
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }
}

let pollingOffset = 0;
async function startPolling() {
  if (!BOT_TOKEN) {
    console.warn("BOT_TOKEN no configurado: el bot no escuchará /start.");
    return;
  }
  while (true) {
    try {
      const data = await telegramApi("getUpdates", {
        offset: pollingOffset,
        timeout: 25
      });
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          pollingOffset = upd.update_id + 1;
          await handleBotUpdate(upd);
        }
      }
    } catch (err) {
      console.error("Error en polling de Telegram:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  startPolling();
});