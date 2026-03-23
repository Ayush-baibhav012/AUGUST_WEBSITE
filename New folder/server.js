const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const http = require("http");
const fs = require("fs/promises");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const MONGODB_URI = process.env.MONGODB_URI || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

let isMongoConnected = false;

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  isRead: { type: Boolean, default: false },
}, { timestamps: true });

const Contact = mongoose.model("Contact", contactSchema);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

function clean(value) {
  return String(value || "").trim();
}

function getAdminTokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return req.headers["x-admin-token"] || "";
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_TOKEN is not configured on server.",
    });
  }

  const token = getAdminTokenFromRequest(req);
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  return next();
}

async function ensureJsonStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(CONTACTS_FILE);
  } catch {
    await fs.writeFile(CONTACTS_FILE, "[]", "utf8");
  }
}

async function readContactsJson() {
  const raw = await fs.readFile(CONTACTS_FILE, "utf8");
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (parseError) {
    console.error("contacts.json was invalid JSON — resetting backup:", parseError.message);
    try {
      await fs.copyFile(CONTACTS_FILE, `${CONTACTS_FILE}.corrupt.bak`);
    } catch {
      // ignore backup failure
    }
    await fs.writeFile(CONTACTS_FILE, "[]", "utf8");
    return [];
  }
}

/** Safer for OneDrive / Windows: temp file + rename + retries */
async function writeContactsJson(list) {
  const text = JSON.stringify(list, null, 2);
  const tmp = `${CONTACTS_FILE}.tmp`;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, CONTACTS_FILE);
      return;
    } catch (err) {
      lastErr = err;
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function connectMongo() {
  if (!MONGODB_URI) {
    console.log("MONGODB_URI not set. Using JSON storage.");
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    isMongoConnected = true;
    console.log("MongoDB connected.");
  } catch (error) {
    isMongoConnected = false;
    console.error("MongoDB connection failed. Falling back to JSON storage.", error.message);
  }
}

async function saveContact(contact) {
  if (isMongoConnected) {
    try {
      const doc = await Contact.create(contact);
      return normalizeMongo(doc);
    } catch (mongoErr) {
      console.error("MongoDB save failed, using JSON file instead:", mongoErr.message);
    }
  }

  const list = await readContactsJson();
  const payload = {
    ...contact,
    id: Date.now().toString(),
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  list.push(payload);
  await writeContactsJson(list);
  return { ...payload, source: "json" };
}

function normalizeMongo(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    subject: doc.subject,
    message: doc.message,
    isRead: Boolean(doc.isRead),
    createdAt: doc.createdAt,
    source: "mongodb",
  };
}

async function listContacts() {
  if (isMongoConnected) {
    const docs = await Contact.find().sort({ createdAt: -1 }).lean();
    return docs.map((doc) => normalizeMongo(doc));
  }

  const list = await readContactsJson();
  return list.map((item) => ({ ...item, isRead: Boolean(item.isRead), source: "json" }));
}

async function updateContactReadStatus(id, isRead) {
  if (isMongoConnected) {
    const doc = await Contact.findByIdAndUpdate(
      id,
      { isRead: Boolean(isRead) },
      { new: true }
    ).lean();
    if (!doc) {
      return null;
    }
    return normalizeMongo(doc);
  }

  const list = await readContactsJson();
  const idx = list.findIndex((item) => String(item.id) === String(id));
  if (idx === -1) {
    return null;
  }
  list[idx].isRead = Boolean(isRead);
  await writeContactsJson(list);
  return { ...list[idx], source: "json" };
}

async function deleteContactById(id) {
  if (isMongoConnected) {
    const doc = await Contact.findByIdAndDelete(id).lean();
    if (!doc) {
      return false;
    }
    return true;
  }

  const list = await readContactsJson();
  const nextList = list.filter((item) => String(item.id) !== String(id));
  if (nextList.length === list.length) {
    return false;
  }
  await writeContactsJson(nextList);
  return true;
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = String(process.env.SMTP_PASS || "").replace(/\s+/g, "");

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendContactNotification(contact) {
  const transport = createTransport();
  const to = process.env.NOTIFY_TO_EMAIL;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transport || !to || !from) {
    return;
  }

  await transport.sendMail({
    from,
    to,
    replyTo: contact.email,
    subject: `New Website Contact: ${contact.subject}`,
    text: [
      `Name: ${contact.name}`,
      `Email: ${contact.email}`,
      `Subject: ${contact.subject}`,
      "",
      "Message:",
      contact.message,
    ].join("\n"),
  });
}

app.post("/api/contact", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = clean(body.name);
    const email = clean(body.email);
    const subject = clean(body.subject);
    const message = clean(body.message);

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ ok: false, error: "All fields are required." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, error: "Please enter a valid email address." });
    }

    const saved = await saveContact({ name, email, subject, message });

    // Email notification should not block saving enquiry messages.
    try {
      await sendContactNotification(saved);
    } catch (mailError) {
      console.error("Contact mail notification failed:", mailError.message);
    }

    return res.json({ ok: true, message: "Message received. I will get back to you soon." });
  } catch (error) {
    console.error("Contact submit error:", error);
    const show = process.env.SHOW_SERVER_ERRORS === "true";
    return res.status(500).json({
      ok: false,
      error: show ? error.message : "Server error. Please try again later.",
    });
  }
});

app.get("/api/contact", requireAdmin, async (_req, res) => {
  try {
    const contacts = await listContacts();
    return res.json({ ok: true, count: contacts.length, contacts });
  } catch (error) {
    console.error("Read contacts error:", error);
    return res.status(500).json({ ok: false, error: "Could not read messages." });
  }
});

app.patch("/api/contact/:id/read", requireAdmin, async (req, res) => {
  try {
    const id = clean(req.params.id);
    const patchBody = req.body && typeof req.body === "object" ? req.body : {};
    const isRead = Boolean(patchBody.isRead);
    if (!id) {
      return res.status(400).json({ ok: false, error: "Contact id is required." });
    }
    const updated = await updateContactReadStatus(id, isRead);
    if (!updated) {
      return res.status(404).json({ ok: false, error: "Contact not found." });
    }
    return res.json({ ok: true, contact: updated });
  } catch (error) {
    console.error("Update contact error:", error);
    return res.status(500).json({ ok: false, error: "Could not update contact." });
  }
});

app.delete("/api/contact/:id", requireAdmin, async (req, res) => {
  try {
    const id = clean(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "Contact id is required." });
    }
    const deleted = await deleteContactById(id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "Contact not found." });
    }
    return res.json({ ok: true, message: "Contact deleted." });
  } catch (error) {
    console.error("Delete contact error:", error);
    return res.status(500).json({ ok: false, error: "Could not delete contact." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    storage: isMongoConnected ? "mongodb" : "json",
    uptimeSec: Math.round(process.uptime()),
  });
});

// Static files AFTER API routes. index:false so GET / is handled below (not auto index.html).
app.use(express.static(__dirname, { index: false }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

/** One HTTP server only — if PORT is busy, try the next port (avoids EADDRINUSE crash). */
function listenWithFallback(preferredPort, maxTries = 25) {
  const start = Number(preferredPort) || 3000;
  const server = http.createServer(app);
  let tries = 0;

  const tryListen = (port) => {
    server.removeAllListeners("error");
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" && tries < maxTries) {
        tries += 1;
        console.warn(`Port ${port} is busy — trying ${port + 1}...`);
        tryListen(port + 1);
        return;
      }
      if (err.code === "EADDRINUSE") {
        console.error(
          `\nNo free port found after ${maxTries} tries (from ${start}).\n` +
            `Stop old Node: Task Manager → end "Node.js"\n` +
            `Or: netstat -ano | findstr :${start}\n` +
            `    taskkill /PID <number> /F\n`
        );
      } else {
        console.error(err);
      }
      process.exit(1);
    });

    server.listen(port, () => {
      server.removeAllListeners("error");
      server.on("error", (err) => console.error("Server error:", err));
      const url = `http://localhost:${port}`;
      console.log(`Backend running at ${url}`);
      console.log(`Website: ${url}`);
      console.log(`Admin Panel: ${url}/admin`);
      if (port !== start) {
        console.log(`(Using ${port} because ${start} was in use — open the URL above in your browser.)`);
      }
    });
  };

  tryListen(start);
}

Promise.all([ensureJsonStorage(), connectMongo()])
  .then(() => {
    listenWithFallback(PORT);
  })
  .catch((error) => {
    console.error("Failed to initialize backend:", error);
    process.exit(1);
  });
