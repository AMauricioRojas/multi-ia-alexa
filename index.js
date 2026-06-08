import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pkg from "pg";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(cors());

app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

/* =========================
   STATIC FRONTEND
========================= */
app.use(express.static(path.join(__dirname, "frontend")));

app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "frontend", "index.html");

  res.sendFile(indexPath, (err) => {
    if (err) {
      res.send("Multi IA Alexa backend activo");
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Nexo IA",
    message: "Servidor activo",
    time: new Date().toISOString()
  });
});

app.get("/keep-alive", (req, res) => {
  res.json({
    ok: true,
    app: "Nexo IA",
    message: "Keep alive recibido",
    time: new Date().toISOString()
  });
});

/* =========================
   DB
========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : new Pool({
      user: "postgres",
      host: "localhost",
      database: "ai_platform",
      password: process.env.DB_PASSWORD,
      port: 5432
    });

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      alexa_code TEXT UNIQUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT,
      role TEXT,
      mensaje TEXT,
      ia TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      source TEXT DEFAULT 'web'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alexa_links (
      id SERIAL PRIMARY KEY,
      alexa_user_id TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      preferred_ia TEXT DEFAULT 'auto',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alexa_pair_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      used BOOLEAN DEFAULT false,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alexa_pair_attempts (
      id SERIAL PRIMARY KEY,
      alexa_user_id TEXT NOT NULL,
      attempted_code TEXT,
      success BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alexa_pair_attempts_user_time
    ON alexa_pair_attempts (alexa_user_id, created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      clarity INTEGER,
      completeness INTEGER,
      usefulness INTEGER,
      preferred_use BOOLEAN,
      best_ai TEXT,
      comments TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      dismissed_until TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS alexa_code TEXT UNIQUE;
  `);

  await pool.query(`
    ALTER TABLE chats 
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'web';
  `);


  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_code_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_attempts INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE chats
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id SERIAL PRIMARY KEY,
      email TEXT,
      ip TEXT,
      type TEXT NOT NULL,
      success BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_attempts_email_type_time
    ON auth_attempts (email, type, created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    INSERT INTO system_settings (key, value)
    VALUES ('keep_alive_enabled', 'false')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log("✅ Tablas verificadas correctamente");
}

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   HELPERS
========================= */
function cleanText(text) {
  return String(text || "").trim();
}

function normalizeProvider(provider) {
  const value = String(provider || "auto").toLowerCase().trim();

  const map = {
    auto: "auto",
    chatgpt: "chatgpt",
    "chat gpt": "chatgpt",
    openai: "chatgpt",

    groq: "groq_fast",
    grok: "groq_fast",
    groq_fast: "groq_fast",
    "groq rapido": "groq_fast",
    "groq rápido": "groq_fast",
    "grok rapido": "groq_fast",
    "grok rápido": "groq_fast",

    groq_power: "groq_power",
    "groq potente": "groq_power",
    "grok potente": "groq_power",

    gemini: "gemini"
  };

  return map[value] || "auto";
}

function providerLabel(provider) {
  const labels = {
    auto: "Auto",
    chatgpt: "ChatGPT",
    groq_fast: "Groq rápido",
    groq_power: "Groq potente",
    gemini: "Gemini"
  };

  return labels[provider] || "Auto";
}

function shortForAlexa(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (clean.length <= 850) return clean;

  return clean.slice(0, 850) + "... Puedes ver la respuesta completa en la aplicación.";
}

function getSlotValue(slots, slotName) {
  return slots?.[slotName]?.value || "";
}

function getAlexaUserId(body) {
  return (
    body?.session?.user?.userId ||
    body?.context?.System?.user?.userId ||
    "unknown-user"
  );
}

function normalizePairCode(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

function normalizeSpokenIA(value) {
  return normalizeProvider(value);
}

function maskEmail(email) {
  const clean = String(email || "");

  if (!clean.includes("@")) return "registrada";

  const [name, domain] = clean.split("@");

  const safeName =
    name.length <= 2
      ? name[0] + "*"
      : name.slice(0, 2) + "***";

  return `${safeName}@${domain}`;
}

function generatePairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim().toLowerCase());
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidPassword(password) {
  return String(password || "").length >= 8;
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashCode(code) {
  return crypto
    .createHash("sha256")
    .update(String(code || ""))
    .digest("hex");
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

async function sendNexoEmail({ to, subject, text }) {
  const mode = process.env.MAIL_MODE || "console";

  if (mode === "resend" && process.env.RESEND_API_KEY) {
    const from = process.env.EMAIL_FROM || "Nexo IA <onboarding@resend.dev>";

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.log("RESEND ERROR:", data);
      throw new Error(data.message || "No se pudo enviar correo");
    }

    return { ok: true, mode: "resend" };
  }

  console.log("\n================ NEXO IA EMAIL ================");
  console.log("Para:", to);
  console.log("Asunto:", subject);
  console.log(text);
  console.log("================================================\n");

  return { ok: true, mode: "console" };
}

async function createVerificationCodeForUser(userId, email) {
  const code = generateSixDigitCode();

  await pool.query(
    `UPDATE users
     SET verification_code_hash=$1,
         verification_expires_at=CURRENT_TIMESTAMP + INTERVAL '10 minutes',
         verification_attempts=0,
         email_verified=false,
         email_verified_at=NULL
     WHERE id=$2`,
    [hashCode(code), userId]
  );

  await sendNexoEmail({
    to: email,
    subject: "Código de verificación de Nexo IA",
    text:
      `Tu código de verificación de Nexo IA es: ${code}\n\n` +
      "Este código expira en 10 minutos. Si tú no solicitaste esto, puedes ignorar este mensaje."
  });

  return code;
}

async function registerAuthAttempt({ email, ip, type, success }) {
  await pool.query(
    `INSERT INTO auth_attempts (email, ip, type, success)
     VALUES ($1, $2, $3, $4)`,
    [normalizeEmail(email), ip || "unknown", type, Boolean(success)]
  );
}

async function getFailedAuthAttempts({ email, ip, type }) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM auth_attempts
     WHERE type=$1
       AND success=false
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       AND (email=$2 OR ip=$3)`,
    [type, normalizeEmail(email), ip || "unknown"]
  );

  return result.rows[0]?.total || 0;
}

async function canAttemptAuth({ email, ip, type, max = 5 }) {
  const failed = await getFailedAuthAttempts({ email, ip, type });
  return {
    allowed: failed < max,
    failed,
    remaining: Math.max(0, max - failed)
  };
}

function adminAuth(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    return res.status(503).json({
      error: "Admin no configurado. Agrega ADMIN_SECRET en variables de entorno."
    });
  }

  const provided = req.headers["x-admin-key"];

  if (provided !== adminSecret) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  next();
}

async function getSystemSetting(key, fallback = "false") {
  const result = await pool.query(
    "SELECT value FROM system_settings WHERE key=$1",
    [key]
  );

  return result.rows[0]?.value ?? fallback;
}

async function setSystemSetting(key, value) {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key)
     DO UPDATE SET value=EXCLUDED.value, updated_at=CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
}



async function getAlexaFailedAttempts(alexaUserId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM alexa_pair_attempts
     WHERE alexa_user_id=$1
       AND success=false
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes'`,
    [alexaUserId]
  );

  return result.rows[0]?.total || 0;
}

async function canTryAlexaPairCode(alexaUserId) {
  const failedAttempts = await getAlexaFailedAttempts(alexaUserId);

  return {
    allowed: failedAttempts < 5,
    failedAttempts,
    remaining: Math.max(0, 5 - failedAttempts)
  };
}

async function registerAlexaPairAttempt({ alexaUserId, attemptedCode, success }) {
  await pool.query(
    `INSERT INTO alexa_pair_attempts (alexa_user_id, attempted_code, success)
     VALUES ($1, $2, $3)`,
    [alexaUserId, attemptedCode || "", success]
  );
}

async function clearAlexaPairAttempts(alexaUserId) {
  await pool.query(
    `DELETE FROM alexa_pair_attempts
     WHERE alexa_user_id=$1`,
    [alexaUserId]
  );
}

/* =========================
   AUTH
========================= */
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = data;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

/* =========================
   REGISTER
========================= */
app.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Correo y contraseña son obligatorios"
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: "Ingresa un correo válido"
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: "La contraseña debe tener al menos 8 caracteres"
      });
    }

    const existing = await pool.query(
      "SELECT id, email, email_verified FROM users WHERE email=$1",
      [email]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      if (!user.email_verified) {
        await createVerificationCodeForUser(user.id, user.email);

        return res.json({
          ok: true,
          needs_verification: true,
          email: user.email,
          message: "Ya existía una cuenta pendiente de verificación. Te enviamos un nuevo código."
        });
      }

      return res.status(400).json({
        error: "Ese correo ya está registrado"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const inserted = await pool.query(
      `INSERT INTO users (email, password, email_verified)
       VALUES ($1, $2, false)
       RETURNING id, email`,
      [email, hash]
    );

    const user = inserted.rows[0];
    const legacyAlexaCode = `ALEXA-${user.id}`;

    await pool.query(
      "UPDATE users SET alexa_code=$1 WHERE id=$2",
      [legacyAlexaCode, user.id]
    );

    await createVerificationCodeForUser(user.id, user.email);

    res.json({
      ok: true,
      needs_verification: true,
      email: user.email,
      message: "Usuario creado. Verifica tu correo con el código enviado."
    });
  } catch (error) {
    console.log("REGISTER ERROR:", error.message);

    res.status(500).json({
      error: "No se pudo registrar en este momento.",
      detalle: error.message
    });
  }
});

/* =========================
   LOGIN
========================= */
app.post("/login", async (req, res) => {
  const ip = getClientIp(req);

  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Correo y contraseña son obligatorios"
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: "Ingresa un correo válido"
      });
    }

    const attemptStatus = await canAttemptAuth({
      email,
      ip,
      type: "login",
      max: 5
    });

    if (!attemptStatus.allowed) {
      return res.status(429).json({
        error: "Demasiados intentos fallidos. Espera 10 minutos e intenta otra vez."
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    const genericError = "Correo o contraseña incorrectos";

    if (result.rows.length === 0) {
      await registerAuthAttempt({ email, ip, type: "login", success: false });
      return res.status(401).json({ error: genericError });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      await registerAuthAttempt({ email, ip, type: "login", success: false });
      return res.status(401).json({ error: genericError });
    }

    if (!user.email_verified) {
      await createVerificationCodeForUser(user.id, user.email);

      return res.status(403).json({
        error: "Tu correo todavía no está verificado. Te enviamos un nuevo código.",
        needs_verification: true,
        email: user.email
      });
    }

    await registerAuthAttempt({ email, ip, type: "login", success: true });

    let legacyAlexaCode = user.alexa_code;

    if (!legacyAlexaCode) {
      legacyAlexaCode = `ALEXA-${user.id}`;

      await pool.query(
        "UPDATE users SET alexa_code=$1 WHERE id=$2",
        [legacyAlexaCode, user.id]
      );
    }

    const token = jwt.sign(
      {
        user_id: user.id,
        email: user.email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({ token });
  } catch (error) {
    console.log("LOGIN ERROR:", error.message);

    res.status(500).json({
      error: "Error en login",
      detalle: error.message
    });
  }
});

/* =========================
   EMAIL VERIFICATION / PASSWORD RECOVERY
========================= */
app.post("/verify-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = normalizePairCode(req.body.code);

    if (!isValidEmail(email) || !code) {
      return res.status(400).json({
        error: "Correo y código son obligatorios"
      });
    }

    const result = await pool.query(
      "SELECT id, email, email_verified, verification_code_hash, verification_expires_at, verification_attempts FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "Código inválido o expirado"
      });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.json({
        ok: true,
        message: "Tu correo ya estaba verificado"
      });
    }

    if (!user.verification_code_hash || !user.verification_expires_at) {
      return res.status(400).json({
        error: "No hay código activo. Solicita uno nuevo."
      });
    }

    if (Number(user.verification_attempts || 0) >= 5) {
      return res.status(429).json({
        error: "Demasiados intentos. Solicita un nuevo código."
      });
    }

    if (new Date(user.verification_expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        error: "El código expiró. Solicita uno nuevo."
      });
    }

    if (hashCode(code) !== user.verification_code_hash) {
      await pool.query(
        "UPDATE users SET verification_attempts=verification_attempts+1 WHERE id=$1",
        [user.id]
      );

      return res.status(400).json({
        error: "Código incorrecto"
      });
    }

    await pool.query(
      `UPDATE users
       SET email_verified=true,
           email_verified_at=CURRENT_TIMESTAMP,
           verification_code_hash=NULL,
           verification_expires_at=NULL,
           verification_attempts=0
       WHERE id=$1`,
      [user.id]
    );

    res.json({
      ok: true,
      message: "Correo verificado correctamente"
    });
  } catch (error) {
    console.log("VERIFY EMAIL ERROR:", error.message);

    res.status(500).json({
      error: "No se pudo verificar el correo",
      detalle: error.message
    });
  }
});

app.post("/resend-verification", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: "Ingresa un correo válido"
      });
    }

    const result = await pool.query(
      "SELECT id, email, email_verified FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length > 0 && !result.rows[0].email_verified) {
      await createVerificationCodeForUser(result.rows[0].id, result.rows[0].email);
    }

    res.json({
      ok: true,
      message: "Si la cuenta existe y requiere verificación, enviaremos un código."
    });
  } catch (error) {
    console.log("RESEND VERIFICATION ERROR:", error.message);

    res.status(500).json({
      error: "No se pudo reenviar el código",
      detalle: error.message
    });
  }
});

app.post("/forgot-password", async (req, res) => {
  const ip = getClientIp(req);

  try {
    const email = normalizeEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.json({
        ok: true,
        message: "Si el correo existe, enviaremos instrucciones para recuperar la contraseña."
      });
    }

    const attemptStatus = await canAttemptAuth({
      email,
      ip,
      type: "password_reset",
      max: 5
    });

    if (!attemptStatus.allowed) {
      return res.status(429).json({
        error: "Demasiados intentos. Espera 10 minutos e intenta otra vez."
      });
    }

    const result = await pool.query(
      "SELECT id, email FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const code = generateSixDigitCode();

      await pool.query(
        `UPDATE users
         SET reset_code_hash=$1,
             reset_expires_at=CURRENT_TIMESTAMP + INTERVAL '10 minutes',
             reset_attempts=0
         WHERE id=$2`,
        [hashCode(code), user.id]
      );

      await sendNexoEmail({
        to: user.email,
        subject: "Recuperación de contraseña de Nexo IA",
        text:
          `Tu código para recuperar la contraseña de Nexo IA es: ${code}

` +
          "Este código expira en 10 minutos. Si tú no solicitaste esto, puedes ignorar este mensaje."
      });
    }

    await registerAuthAttempt({ email, ip, type: "password_reset", success: true });

    res.json({
      ok: true,
      message: "Si el correo existe, enviaremos instrucciones para recuperar la contraseña."
    });
  } catch (error) {
    console.log("FORGOT PASSWORD ERROR:", error.message);

    res.status(500).json({
      error: "No se pudo procesar la recuperación",
      detalle: error.message
    });
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = normalizePairCode(req.body.code);
    const password = String(req.body.password || "");

    if (!isValidEmail(email) || !code || !password) {
      return res.status(400).json({
        error: "Correo, código y nueva contraseña son obligatorios"
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: "La nueva contraseña debe tener al menos 8 caracteres"
      });
    }

    const result = await pool.query(
      "SELECT id, reset_code_hash, reset_expires_at, reset_attempts FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "Código inválido o expirado"
      });
    }

    const user = result.rows[0];

    if (!user.reset_code_hash || !user.reset_expires_at) {
      return res.status(400).json({
        error: "No hay recuperación activa. Solicita un nuevo código."
      });
    }

    if (Number(user.reset_attempts || 0) >= 5) {
      return res.status(429).json({
        error: "Demasiados intentos. Solicita un nuevo código."
      });
    }

    if (new Date(user.reset_expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        error: "El código expiró. Solicita uno nuevo."
      });
    }

    if (hashCode(code) !== user.reset_code_hash) {
      await pool.query(
        "UPDATE users SET reset_attempts=reset_attempts+1 WHERE id=$1",
        [user.id]
      );

      return res.status(400).json({
        error: "Código incorrecto"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE users
       SET password=$1,
           reset_code_hash=NULL,
           reset_expires_at=NULL,
           reset_attempts=0
       WHERE id=$2`,
      [hash, user.id]
    );

    res.json({
      ok: true,
      message: "Contraseña actualizada correctamente"
    });
  } catch (error) {
    console.log("RESET PASSWORD ERROR:", error.message);

    res.status(500).json({
      error: "No se pudo actualizar la contraseña",
      detalle: error.message
    });
  }
});

/* =========================
   USER INFO
========================= */
app.get("/me", auth, async (req, res) => {
  try {
    const userResult = await pool.query(
      "SELECT id, email, alexa_code, email_verified FROM users WHERE id=$1",
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const linkResult = await pool.query(
      "SELECT preferred_ia, created_at, updated_at FROM alexa_links WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
      [req.user.user_id]
    );

    res.json({
      ...userResult.rows[0],
      alexa_linked: linkResult.rows.length > 0,
      alexa_link: linkResult.rows[0] || null
    });
  } catch (error) {
    console.log("ME ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo usuario",
      detalle: error.message
    });
  }
});

/* =========================
   ALEXA PAIRING WEB ENDPOINTS
========================= */
app.post("/alexa/generate-code", auth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    await pool.query(
      `UPDATE alexa_pair_codes
       SET used=true
       WHERE user_id=$1 AND used=false`,
      [userId]
    );

    let code = "";
    let inserted = null;

    for (let i = 0; i < 5; i++) {
      code = generatePairCode();

      try {
        const result = await pool.query(
          `INSERT INTO alexa_pair_codes (user_id, code, expires_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')
           RETURNING code, expires_at`,
          [userId, code]
        );

        inserted = result.rows[0];
        break;
      } catch (err) {
        if (!String(err.message).includes("duplicate")) {
          throw err;
        }
      }
    }

    if (!inserted) {
      return res.status(500).json({
        error: "No se pudo generar código. Intenta de nuevo."
      });
    }

    res.json({
      ok: true,
      code: inserted.code,
      expires_at: inserted.expires_at,
      message: "Código generado. Dile a Alexa: mi código es " + inserted.code
    });
  } catch (error) {
    console.log("GENERATE ALEXA CODE ERROR:", error.message);

    res.status(500).json({
      error: "Error generando código Alexa",
      detalle: error.message
    });
  }
});

app.get("/alexa/status", auth, async (req, res) => {
  try {
    const linkResult = await pool.query(
      `SELECT preferred_ia, created_at, updated_at
       FROM alexa_links
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.user_id]
    );

    const activeCodeResult = await pool.query(
      `SELECT code, expires_at
       FROM alexa_pair_codes
       WHERE user_id=$1
         AND used=false
         AND expires_at > CURRENT_TIMESTAMP
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.user_id]
    );

    res.json({
      linked: linkResult.rows.length > 0,
      link: linkResult.rows[0] || null,
      active_pair_code: activeCodeResult.rows[0] || null
    });
  } catch (error) {
    console.log("ALEXA STATUS ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo estado de Alexa",
      detalle: error.message
    });
  }
});

app.delete("/alexa/unlink", auth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM alexa_links WHERE user_id=$1",
      [req.user.user_id]
    );

    await pool.query(
      "UPDATE alexa_pair_codes SET used=true WHERE user_id=$1 AND used=false",
      [req.user.user_id]
    );

    res.json({
      ok: true,
      message: "Alexa desvinculada correctamente"
    });
  } catch (error) {
    console.log("ALEXA UNLINK ERROR:", error.message);

    res.status(500).json({
      error: "Error desvinculando Alexa",
      detalle: error.message
    });
  }
});

/* =========================
   SURVEY ENDPOINTS
========================= */
app.get("/survey/status", auth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const feedback = await pool.query(
      "SELECT id FROM survey_feedback WHERE user_id=$1 LIMIT 1",
      [userId]
    );

    if (feedback.rows.length > 0) {
      return res.json({
        should_show: false,
        reason: "already_answered"
      });
    }

    const dismissed = await pool.query(
      `SELECT dismissed_until 
       FROM survey_state 
       WHERE user_id=$1 
         AND dismissed_until > CURRENT_TIMESTAMP`,
      [userId]
    );

    if (dismissed.rows.length > 0) {
      return res.json({
        should_show: false,
        reason: "dismissed",
        dismissed_until: dismissed.rows[0].dismissed_until
      });
    }

    const stats = await pool.query(
      `SELECT 
         COUNT(*)::int AS alexa_questions,
         MIN(created_at) AS first_alexa_use
       FROM chats
       WHERE user_id=$1
         AND source='alexa'
         AND role='user'`,
      [userId]
    );

    const row = stats.rows[0];
    const alexaQuestions = row.alexa_questions || 0;
    const firstAlexaUse = row.first_alexa_use;

    let passedThreeDays = false;

    if (firstAlexaUse) {
      const firstDate = new Date(firstAlexaUse).getTime();
      const now = Date.now();
      passedThreeDays = now - firstDate >= 3 * 24 * 60 * 60 * 1000;
    }

    const shouldShow = alexaQuestions >= 8 || passedThreeDays;

    res.json({
      should_show: shouldShow,
      reason: shouldShow ? "eligible" : "not_enough_usage",
      alexa_questions: alexaQuestions,
      first_alexa_use: firstAlexaUse,
      rules: {
        minimum_questions: 8,
        minimum_days: 3
      }
    });
  } catch (error) {
    console.log("SURVEY STATUS ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo estado de encuesta",
      detalle: error.message
    });
  }
});

app.post("/survey/dismiss", auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO survey_state (user_id, dismissed_until, updated_at)
       VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET 
         dismissed_until = EXCLUDED.dismissed_until,
         updated_at = CURRENT_TIMESTAMP`,
      [req.user.user_id]
    );

    res.json({
      ok: true,
      message: "Encuesta pospuesta por 7 días"
    });
  } catch (error) {
    console.log("SURVEY DISMISS ERROR:", error.message);

    res.status(500).json({
      error: "Error posponiendo encuesta",
      detalle: error.message
    });
  }
});

app.post("/survey/submit", auth, async (req, res) => {
  try {
    const clarity = Number(req.body.clarity || 0);
    const completeness = Number(req.body.completeness || 0);
    const usefulness = Number(req.body.usefulness || 0);
    const preferredUse = Boolean(req.body.preferred_use);
    const bestAi = cleanText(req.body.best_ai);
    const comments = cleanText(req.body.comments);

    await pool.query(
      `INSERT INTO survey_feedback
       (user_id, clarity, completeness, usefulness, preferred_use, best_ai, comments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.user_id,
        clarity,
        completeness,
        usefulness,
        preferredUse,
        bestAi,
        comments
      ]
    );

    res.json({
      ok: true,
      message: "Gracias por responder la encuesta"
    });
  } catch (error) {
    console.log("SURVEY SUBMIT ERROR:", error.message);

    res.status(500).json({
      error: "Error guardando encuesta",
      detalle: error.message
    });
  }
});

/* =========================
   IA FUNCTIONS
========================= */
async function askChatGPT(messages) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });

  const text = response.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("ChatGPT no devolvió respuesta");
  }

  return text;
}

async function askGroq(messages, mode = "fast") {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Falta GROQ_API_KEY");
  }

  const model =
    mode === "power"
      ? "llama-3.3-70b-versatile"
      : "llama-3.1-8b-instant";

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7
    })
  });

  const data = await response.json();

  if (!response.ok || !data.choices?.[0]?.message?.content) {
    console.log("GROQ ERROR RESPONSE:", data);
    throw new Error(data.error?.message || "Groq no devolvió respuesta");
  }

  return data.choices[0].message.content;
}

async function askGemini(mensaje) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Falta GEMINI_API_KEY");
  }

  const model = "gemini-2.5-flash-lite";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: mensaje
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.candidates?.[0]?.content?.parts?.[0]?.text) {
    console.log("GEMINI ERROR RESPONSE:", data);
    throw new Error(data.error?.message || "Gemini no devolvió respuesta");
  }

  return data.candidates[0].content.parts[0].text;
}

async function askAI(provider, messages, rawMessage) {
  const selected = normalizeProvider(provider);

  if (selected === "chatgpt") {
    return {
      respuesta: await askChatGPT(messages),
      iaUsada: "chatgpt"
    };
  }

  if (selected === "groq_fast") {
    return {
      respuesta: await askGroq(messages, "fast"),
      iaUsada: "groq_fast"
    };
  }

  if (selected === "groq_power") {
    return {
      respuesta: await askGroq(messages, "power"),
      iaUsada: "groq_power"
    };
  }

  if (selected === "gemini") {
    try {
      return {
        respuesta: await askGemini(rawMessage),
        iaUsada: "gemini"
      };
    } catch (geminiError) {
      console.log("Gemini falló, usando Groq rápido:", geminiError.message);

      const fallback = await askGroq(messages, "fast");

      return {
        respuesta:
          "Gemini no respondió correctamente. Respondí usando Groq rápido como respaldo.\n\n" +
          fallback,
        iaUsada: "groq_fast"
      };
    }
  }

  try {
    return {
      respuesta: await askGroq(messages, "fast"),
      iaUsada: "groq_fast"
    };
  } catch (groqError) {
    console.log("AUTO: Groq falló, usando ChatGPT:", groqError.message);

    return {
      respuesta: await askChatGPT(messages),
      iaUsada: "chatgpt"
    };
  }
}

/* =========================
   SHARED CHAT HANDLER
========================= */
async function processQuestion({
  user_id,
  mensaje,
  provider,
  conversation_id,
  source,
  alexaMode = false
}) {
  const convId = conversation_id || `${source}-${Date.now()}`;

  const contexto = await pool.query(
    `SELECT role, mensaje 
     FROM (
       SELECT id, role, mensaje
       FROM chats
       WHERE user_id=$1 
         AND conversation_id=$2
         AND deleted_at IS NULL
         AND role IN ('user', 'ai')
       ORDER BY id DESC
       LIMIT 20
     ) AS ultimos
     ORDER BY id ASC`,
    [user_id, convId]
  );

  const systemPrompt = alexaMode
    ? "Responde en español de forma clara, útil y breve. La respuesta será leída por Alexa, así que evita listas largas y sé directo."
    : "Responde en español de forma clara, útil y directa.";

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...contexto.rows.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.mensaje
    })),
    {
      role: "user",
      content: mensaje
    }
  ];

  let respuesta = "";
  let iaUsada = normalizeProvider(provider);

  try {
    const aiResult = await askAI(provider, messages, mensaje);
    respuesta = aiResult.respuesta;
    iaUsada = aiResult.iaUsada;
  } catch (aiError) {
    console.log("IA ERROR:", aiError.message);

    respuesta = `No pude responder con ${providerLabel(provider)}. Error: ${aiError.message}`;
    iaUsada = normalizeProvider(provider);
  }

  await pool.query(
    `INSERT INTO chats (user_id, conversation_id, role, mensaje, ia, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user_id, convId, "user", mensaje, iaUsada, source]
  );

  await pool.query(
    `INSERT INTO chats (user_id, conversation_id, role, mensaje, ia, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user_id, convId, "ai", respuesta, iaUsada, source]
  );

  return {
    respuesta,
    respuesta_alexa: shortForAlexa(respuesta),
    conversation_id: convId,
    ia: iaUsada,
    ia_nombre: providerLabel(iaUsada),
    source
  };
}

/* =========================
   WEB CHAT
========================= */
app.post("/preguntar", auth, async (req, res) => {
  try {
    const mensaje = cleanText(req.body.mensaje);
    const provider = normalizeProvider(req.body.ia);
    const conversation_id = req.body.conversation_id || null;

    if (!mensaje) {
      return res.status(400).json({
        error: "El mensaje está vacío"
      });
    }

    const result = await processQuestion({
      user_id: req.user.user_id,
      mensaje,
      provider,
      conversation_id,
      source: req.body.source === "mobile" ? "mobile" : "web",
      alexaMode: false
    });

    res.json(result);
  } catch (error) {
    console.log("CHAT ERROR:", error);

    res.status(500).json({
      error: "Error servidor",
      detalle: error.message
    });
  }
});

/* =========================
   ALEXA SIMPLE TEST
========================= */
app.post("/alexa/preguntar", async (req, res) => {
  try {
    const mensaje = cleanText(req.body.mensaje);
    const provider = normalizeProvider(req.body.ia || "auto");
    const conversation_id = req.body.conversation_id || null;
    const pairCode = normalizePairCode(req.body.code || req.body.alexa_code);

    if (!mensaje) {
      return res.status(400).json({
        error: "Falta mensaje"
      });
    }

    if (!pairCode) {
      return res.status(400).json({
        error: "Falta code"
      });
    }

    const codeResult = await pool.query(
      `SELECT pc.id AS code_id, pc.user_id, u.email
       FROM alexa_pair_codes pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.code=$1
         AND pc.used=false
         AND pc.expires_at > CURRENT_TIMESTAMP
       ORDER BY pc.id DESC
       LIMIT 1`,
      [pairCode]
    );

    if (codeResult.rows.length === 0) {
      return res.status(404).json({
        error: "Código temporal no encontrado o expirado"
      });
    }

    const user = codeResult.rows[0];

    const result = await processQuestion({
      user_id: user.user_id,
      mensaje,
      provider,
      conversation_id,
      source: "alexa",
      alexaMode: true
    });

    res.json({
      respuesta: result.respuesta_alexa,
      respuesta_completa: result.respuesta,
      conversation_id: result.conversation_id,
      ia: result.ia,
      ia_nombre: result.ia_nombre,
      source: "alexa"
    });
  } catch (error) {
    console.log("ALEXA SIMPLE ERROR:", error);

    res.status(500).json({
      error: "Error servidor Alexa",
      detalle: error.message
    });
  }
});

/* =========================
   CONVERSACIONES
========================= */
app.get("/conversaciones", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT conversation_id, titulo, source, last_id
      FROM (
        SELECT DISTINCT ON (conversation_id)
          conversation_id,
          LEFT(mensaje, 55) AS titulo,
          source,
          (
            SELECT MAX(id)
            FROM chats c2
            WHERE c2.conversation_id = c1.conversation_id
              AND c2.user_id = c1.user_id
              AND c2.deleted_at IS NULL
          ) AS last_id
        FROM chats c1
        WHERE user_id=$1
          AND deleted_at IS NULL
          AND role='user'
        ORDER BY conversation_id, id ASC
      ) AS conversaciones
      ORDER BY last_id DESC
    `, [req.user.user_id]);

    res.json(result.rows);
  } catch (error) {
    console.log("CONVERSACIONES ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo conversaciones",
      detalle: error.message
    });
  }
});

/* =========================
   HISTORIAL
========================= */
app.get("/historial/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT role, mensaje, ia, source, created_at
       FROM chats
       WHERE user_id=$1 
         AND conversation_id=$2
         AND deleted_at IS NULL
         AND role IN ('user', 'ai')
       ORDER BY id ASC`,
      [req.user.user_id, req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.log("HISTORIAL ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo historial",
      detalle: error.message
    });
  }
});


app.delete("/conversaciones/:id", auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE chats
       SET deleted_at=CURRENT_TIMESTAMP
       WHERE user_id=$1
         AND conversation_id=$2
         AND deleted_at IS NULL`,
      [req.user.user_id, req.params.id]
    );

    res.json({
      ok: true,
      message: "Chat eliminado correctamente"
    });
  } catch (error) {
    console.log("DELETE CHAT ERROR:", error.message);

    res.status(500).json({
      error: "Error eliminando chat",
      detalle: error.message
    });
  }
});

app.delete("/conversaciones", auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE chats
       SET deleted_at=CURRENT_TIMESTAMP
       WHERE user_id=$1
         AND deleted_at IS NULL`,
      [req.user.user_id]
    );

    res.json({
      ok: true,
      message: "Historial eliminado correctamente"
    });
  } catch (error) {
    console.log("DELETE ALL CHATS ERROR:", error.message);

    res.status(500).json({
      error: "Error eliminando historial",
      detalle: error.message
    });
  }
});

/* =========================
   PROVIDERS
========================= */
app.get("/providers", auth, (req, res) => {
  res.json([
    {
      id: "auto",
      name: "Auto",
      description: "Usa Groq rápido y si falla usa ChatGPT"
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      description: "OpenAI gpt-4o-mini"
    },
    {
      id: "groq_fast",
      name: "Groq rápido",
      description: "llama-3.1-8b-instant"
    },
    {
      id: "groq_power",
      name: "Groq potente",
      description: "llama-3.3-70b-versatile"
    },
    {
      id: "gemini",
      name: "Gemini",
      description: "gemini-2.5-flash-lite con respaldo de Groq"
    }
  ]);
});

/* =========================
   ALEXA SKILL FORMAT
========================= */
function alexaResponse(text, shouldEndSession = false, sessionAttributes = {}) {
  return {
    version: "1.0",
    sessionAttributes,
    response: {
      outputSpeech: {
        type: "PlainText",
        text: String(text || "No tengo respuesta.")
      },
      shouldEndSession
    }
  };
}

async function getAlexaLink(alexaUserId) {
  const result = await pool.query(
    `SELECT al.user_id, al.preferred_ia, u.email, u.alexa_code
     FROM alexa_links al
     JOIN users u ON u.id = al.user_id
     WHERE al.alexa_user_id=$1`,
    [alexaUserId]
  );

  return result.rows[0] || null;
}

async function findValidPairCode(code) {
  const result = await pool.query(
    `SELECT 
       pc.id AS code_id,
       pc.code,
       pc.user_id,
       pc.expires_at,
       u.email
     FROM alexa_pair_codes pc
     JOIN users u ON u.id = pc.user_id
     WHERE pc.code=$1
       AND pc.used=false
       AND pc.expires_at > CURRENT_TIMESTAMP
     ORDER BY pc.id DESC
     LIMIT 1`,
    [code]
  );

  return result.rows[0] || null;
}

async function completeAlexaPairing({ alexaUserId, code }) {
  const pair = await findValidPairCode(code);

  if (!pair) {
    return {
      ok: false,
      message: "Ese código ya expiró o no existe. Genera uno nuevo desde la página web o la aplicación."
    };
  }

  await pool.query(
    `INSERT INTO alexa_links (alexa_user_id, user_id, preferred_ia, updated_at)
     VALUES ($1, $2, 'auto', CURRENT_TIMESTAMP)
     ON CONFLICT (alexa_user_id)
     DO UPDATE SET 
       user_id = EXCLUDED.user_id,
       updated_at = CURRENT_TIMESTAMP`,
    [alexaUserId, pair.user_id]
  );

  await pool.query(
    `UPDATE alexa_pair_codes
     SET used=true
     WHERE id=$1`,
    [pair.code_id]
  );

  await registerAlexaPairAttempt({
    alexaUserId,
    attemptedCode: code,
    success: true
  });

  await clearAlexaPairAttempts(alexaUserId);

  return {
    ok: true,
    email: pair.email,
    message: `Listo. Tu Alexa quedó vinculada con la cuenta ${maskEmail(pair.email)}. Ahora puedes decir: pregunta qué es una API.`
  };
}

app.post("/alexa/skill", async (req, res) => {
  try {
    console.log("ALEXA BODY TYPE:", req.body?.request?.type);
    console.log("ALEXA INTENT:", req.body?.request?.intent?.name || "NO_INTENT");

    const requestType = req.body?.request?.type;
    const alexaUserId = getAlexaUserId(req.body);
    const sessionAttributes = req.body?.session?.attributes || {};

    if (requestType === "LaunchRequest") {
      const link = await getAlexaLink(alexaUserId);

      if (link) {
        return res.json(
          alexaResponse(
            "Bienvenido de nuevo a Nexo IA. Tu Alexa ya está vinculada. Puedes decir: pregunta qué es una API, o usa groq rápido.",
            false
          )
        );
      }

      return res.json(
        alexaResponse(
          "Bienvenido a Nexo IA. Para vincular tu cuenta, abre la página web o la aplicación, genera un código de Alexa, y después dime: mi código es, seguido de los seis números.",
          false
        )
      );
    }

    if (requestType === "IntentRequest") {
      const intentName = req.body?.request?.intent?.name;
      const slots = req.body?.request?.intent?.slots || {};

      if (intentName === "VincularIntent") {
        const rawCode = getSlotValue(slots, "codigo");
        const pairCode = normalizePairCode(rawCode);

        const attemptStatus = await canTryAlexaPairCode(alexaUserId);

        if (!attemptStatus.allowed) {
          return res.json(
            alexaResponse(
              "Detecté demasiados intentos incorrectos. Por seguridad, espera diez minutos antes de intentar vincular otra vez.",
              true
            )
          );
        }

        if (!pairCode || pairCode.length < 4) {
          return res.json(
            alexaResponse(
              "No entendí tu código. Genera un código desde la página web o la aplicación y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const pair = await findValidPairCode(pairCode);

        if (!pair) {
          await registerAlexaPairAttempt({
            alexaUserId,
            attemptedCode: pairCode,
            success: false
          });

          const updatedStatus = await canTryAlexaPairCode(alexaUserId);

          if (!updatedStatus.allowed) {
            return res.json(
              alexaResponse(
                "Ese código no existe o ya expiró. Además, llegaste al límite de intentos. Espera diez minutos antes de intentar otra vez.",
                true
              )
            );
          }

          return res.json(
            alexaResponse(
              `Ese código no existe o ya expiró. Te quedan ${updatedStatus.remaining} intentos antes del bloqueo temporal.`,
              false
            )
          );
        }

        return res.json(
          alexaResponse(
            `Encontré la cuenta ${maskEmail(pair.email)}. Di sí para vincular esta Alexa, o di no para cancelar.`,
            false,
            {
              pending_pair_code: pairCode
            }
          )
        );
      }

      if (intentName === "AMAZON.YesIntent") {
        const pendingCode = normalizePairCode(sessionAttributes.pending_pair_code);

        if (!pendingCode) {
          return res.json(
            alexaResponse(
              "No tengo una vinculación pendiente. Primero di: mi código es, y los seis números generados en la página web.",
              false
            )
          );
        }

        const result = await completeAlexaPairing({
          alexaUserId,
          code: pendingCode
        });

        return res.json(
          alexaResponse(
            result.message,
            false,
            {}
          )
        );
      }

      if (intentName === "AMAZON.NoIntent") {
        return res.json(
          alexaResponse(
            "Vinculación cancelada. Puedes generar otro código cuando quieras.",
            true,
            {}
          )
        );
      }

      if (intentName === "CambiarIAIntent") {
        const link = await getAlexaLink(alexaUserId);

        if (!link) {
          return res.json(
            alexaResponse(
              "Primero vincula tu cuenta. Genera un código desde la web y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const iaValue = getSlotValue(slots, "ia");
        const provider = normalizeSpokenIA(iaValue);

        await pool.query(
          `UPDATE alexa_links
           SET preferred_ia=$1, updated_at=CURRENT_TIMESTAMP
           WHERE alexa_user_id=$2`,
          [provider, alexaUserId]
        );

        return res.json(
          alexaResponse(
            `Listo. Ahora responderé usando ${providerLabel(provider)}.`,
            false
          )
        );
      }

      if (intentName === "PreguntaIntent") {
        const link = await getAlexaLink(alexaUserId);

        if (!link) {
          return res.json(
            alexaResponse(
              "Primero vincula tu cuenta. Genera un código desde la web y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const mensaje = cleanText(getSlotValue(slots, "pregunta"));

        if (!mensaje) {
          return res.json(
            alexaResponse(
              "No entendí la pregunta. Intenta decir: pregunta qué es una API.",
              false
            )
          );
        }

        const result = await processQuestion({
          user_id: link.user_id,
          mensaje,
          provider: link.preferred_ia || "auto",
          conversation_id: null,
          source: "alexa",
          alexaMode: true
        });

        return res.json(
          alexaResponse(result.respuesta_alexa, true)
        );
      }

      if (intentName === "AMAZON.HelpIntent") {
        return res.json(
          alexaResponse(
            "Para empezar, abre la página web o la aplicación, genera un código de Alexa y dime: mi código es, seguido de los seis números. Después podrás decir: pregunta qué es una API.",
            false
          )
        );
      }

      if (
        intentName === "AMAZON.CancelIntent" ||
        intentName === "AMAZON.StopIntent"
      ) {
        return res.json(
          alexaResponse("Hasta luego.", true)
        );
      }

      return res.json(
        alexaResponse(
          "No entendí esa instrucción. Intenta decir: pregunta qué es una API.",
          false
        )
      );
    }

    if (requestType === "SessionEndedRequest") {
      return res.json({});
    }

    return res.json(
      alexaResponse("No pude procesar esa solicitud.", true)
    );
  } catch (error) {
    console.log("ALEXA SKILL ERROR:", error);

    return res.json(
      alexaResponse(
        "Hubo un error procesando tu solicitud. Intenta de nuevo más tarde.",
        true
      )
    );
  }
});

/* =========================
   DEBUG OPCIONAL
========================= */
app.get("/debug/alexa-links", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT al.id, al.alexa_user_id, al.user_id, u.email, u.alexa_code, al.preferred_ia, al.created_at, al.updated_at
      FROM alexa_links al
      JOIN users u ON u.id = al.user_id
      ORDER BY al.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error debug alexa links",
      detalle: error.message
    });
  }
});

app.get("/debug/pair-codes", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.id, pc.user_id, u.email, pc.code, pc.used, pc.expires_at, pc.created_at
      FROM alexa_pair_codes pc
      JOIN users u ON u.id = pc.user_id
      ORDER BY pc.id DESC
      LIMIT 30
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error debug pair codes",
      detalle: error.message
    });
  }
});


/* =========================
   ADMIN PRIVADO
========================= */
app.get("/admin/status", adminAuth, async (req, res) => {
  try {
    const keepAlive = await getSystemSetting("keep_alive_enabled", "false");

    res.json({
      ok: true,
      app: "Nexo IA",
      keep_alive_enabled: keepAlive === "true",
      public_url: process.env.PUBLIC_URL || null,
      mail_mode: process.env.MAIL_MODE || "console",
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: "Error obteniendo estado admin",
      detalle: error.message
    });
  }
});

app.post("/admin/keep-alive/on", adminAuth, async (req, res) => {
  await setSystemSetting("keep_alive_enabled", "true");

  res.json({
    ok: true,
    message: "Keep-alive activado. Modo integradora encendido."
  });
});

app.post("/admin/keep-alive/off", adminAuth, async (req, res) => {
  await setSystemSetting("keep_alive_enabled", "false");

  res.json({
    ok: true,
    message: "Keep-alive desactivado. Render podrá dormir en modo ahorro."
  });
});

app.get("/admin/metrics", adminAuth, async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT 
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE email_verified=true)::int AS verified_users
      FROM users
    `);

    const chats = await pool.query(`
      SELECT 
        COUNT(*)::int AS total_messages,
        COUNT(*) FILTER (WHERE role='user')::int AS total_questions,
        COUNT(*) FILTER (WHERE role='user' AND source='web')::int AS web_questions,
        COUNT(*) FILTER (WHERE role='user' AND source='alexa')::int AS alexa_questions,
        COUNT(*) FILTER (WHERE role='user' AND source='mobile')::int AS mobile_questions
      FROM chats
      WHERE deleted_at IS NULL
    `);

    const ia = await pool.query(`
      SELECT ia, COUNT(*)::int AS total
      FROM chats
      WHERE role='ai'
        AND deleted_at IS NULL
      GROUP BY ia
      ORDER BY total DESC
      LIMIT 10
    `);

    const survey = await pool.query(`
      SELECT
        COUNT(*)::int AS total_surveys,
        ROUND(AVG(clarity)::numeric, 2) AS avg_clarity,
        ROUND(AVG(completeness)::numeric, 2) AS avg_completeness,
        ROUND(AVG(usefulness)::numeric, 2) AS avg_usefulness,
        ROUND((COUNT(*) FILTER (WHERE preferred_use=true)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) AS preferred_percent
      FROM survey_feedback
    `);

    res.json({
      ok: true,
      users: users.rows[0],
      chats: chats.rows[0],
      ia_usage: ia.rows,
      survey: survey.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error obteniendo métricas",
      detalle: error.message
    });
  }
});

/* =========================
   START SERVER
========================= */
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`🚀 Nexo IA listo en puerto ${PORT}`);
      startKeepAlive();
    });
  } catch (error) {
    console.error("❌ ERROR INICIANDO SERVIDOR:", error);
    process.exit(1);
  }
}
app.get("/debug/pair-attempts", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, alexa_user_id, attempted_code, success, created_at
      FROM alexa_pair_attempts
      ORDER BY id DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error debug pair attempts",
      detalle: error.message
    });
  }
});

/* =========================
   KEEP ALIVE OPCIONAL
   Actívalo en Render con:
   ENABLE_SELF_PING=true
   PUBLIC_URL=https://multi-ia-alexa-backend.onrender.com
========================= */
function startKeepAlive() {
  const publicUrl = process.env.PUBLIC_URL;

  if (!publicUrl) {
    console.log("ℹ️ Keep alive sin PUBLIC_URL. Modo ahorro.");
    return;
  }

  const intervalMinutes = Number(process.env.SELF_PING_MINUTES || 10);
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`ℹ️ Keep alive preparado cada ${intervalMinutes} minutos. Se activa solo con /admin/keep-alive/on`);

  setInterval(async () => {
    try {
      const enabled = await getSystemSetting("keep_alive_enabled", "false");

      if (enabled !== "true") {
        return;
      }

      const response = await fetch(`${publicUrl}/keep-alive`);
      console.log(`[KEEP-ALIVE] ${response.status} ${new Date().toISOString()}`);
    } catch (error) {
      console.log("[KEEP-ALIVE ERROR]", error.message);
    }
  }, intervalMs);
}

startServer();