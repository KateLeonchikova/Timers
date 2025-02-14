require("dotenv").config();
const express = require("express");
const nunjucks = require("nunjucks");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { nanoid } = require("nanoid");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const WebSocket = require("ws");
const http = require("http");

const clientPromise = MongoClient.connect(process.env.DB_URI, {
  maxPoolSize: 10,
  tls: true,
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");

app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }));

let clients = new Map();

wss.on("connection", async (ws) => {
  console.log("🟢 New WebSocket connection");

  ws.on("message", async (message) => {
    try {
      const parsedMessage = JSON.parse(message);

      if (parsedMessage.type === "authenticate") {
        const user = await verifyToken(parsedMessage.token);
        if (user) {
          console.log("✅ User authenticated:", user.username);
          ws.user = user;
          clients.set(user._id.toString(), ws);
          ws.send(
            JSON.stringify({
              type: "all_timers",
              data: await getTimers(user._id),
            })
          );
        } else {
          console.log("❌ Authentication error");
          ws.close(1008, "Authentication failed");
        }
      }

      if (parsedMessage.type === "create_timer" && ws.user) {
        await createTimer(ws.user._id, parsedMessage.description);
        await sendAllTimers(ws.user._id);
      }

      if (parsedMessage.type === "stop_timer" && ws.user) {
        await stopTimer(ws.user._id, parsedMessage.timerId);
        await sendAllTimers(ws.user._id);
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    if (ws.user) {
      clients.delete(ws.user._id.toString());
      console.log(`User ${ws.user._id} disconnected`);
    }
  });
});

async function sendAllTimers(userId) {
  const ws = clients.get(userId.toString());
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "all_timers",
        data: await getTimers(userId),
      })
    );
  }
}

setInterval(async () => {
  for (const [userId, ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      const activeTimers = await getActiveTimers(userId);
      const updatedTimers = activeTimers.map((timer) => {
        const duration = Date.now() - timer.start;
        return { ...timer, duration };
      });
      if (updatedTimers.length > 0) {
        ws.send(
          JSON.stringify({
            type: "active_timers",
            data: updatedTimers,
          })
        );
      }
    }
  }
}, 1000);

async function verifyToken(token) {
  const client = await clientPromise;
  const db = client.db("users");

  try {
    const session = await db.collection("sessions").findOne({ token });
    if (!session) {
      console.log("❌ Token not found in the database.");
      return null;
    }

    const user = await db.collection("users").findOne({ _id: new ObjectId(session.userId) });
    if (!user) {
      console.log("❌ User with this userId was not found.");
      return null;
    }
    return user;
  } catch (error) {
    console.error("Error during token verification:", error);
    return null;
  }
}

async function getTimers(userId) {
  const client = await clientPromise;
  const db = client.db("users");
  return db.collection("timers").find({ userId }).toArray();
}

async function getActiveTimers(userId) {
  const client = await clientPromise;
  const db = client.db("users");
  return db
    .collection("timers")
    .find({ userId: new ObjectId(userId), isActive: true })
    .toArray();
}

async function createTimer(userId, description) {
  const client = await clientPromise;
  const db = client.db("users");
  const newTimer = {
    userId,
    timerId: nanoid(),
    start: Date.now(),
    description,
    isActive: true,
  };
  await db.collection("timers").insertOne(newTimer);
}

async function stopTimer(userId, timerId) {
  const client = await clientPromise;
  const db = client.db("users");

  const timer = await db.collection("timers").findOne({ userId, timerId, isActive: true });
  if (!timer) return;

  await db
    .collection("timers")
    .updateOne({ timerId }, { $set: { isActive: false, end: Date.now(), duration: Date.now() - timer.start } });
}

const auth = () => async (req, res, next) => {
  try {
    if (!req.cookies["sessionId"]) {
      return next();
    }
    const user = await findUserBySessionId(req.db, req.cookies["sessionId"]);
    req.user = user;
    req.sessionId = req.cookies["sessionId"];
    next();
  } catch (error) {
    console.error("Error in auth middleware:", error);
    res.status(500).json({ error: "Authentication error" });
  }
};

const hash = (password) => {
  return crypto.createHash("sha256").update(password).digest("hex");
};

const findUserByUserName = async (db, username) => {
  try {
    return await db.collection("users").findOne({ username });
  } catch (error) {
    console.error("Error finding user by username:", error);
    return null;
  }
};

const findUserBySessionId = async (db, sessionId) => {
  try {
    const session = await db.collection("sessions").findOne(
      { sessionId },
      {
        projection: { userId: 1 },
      }
    );

    if (!session || !ObjectId.isValid(session.userId)) {
      return;
    }

    return db.collection("users").findOne({ _id: new ObjectId(session.userId) });
  } catch (error) {
    console.error("Error finding user by session ID:", error);
    return null;
  }
};

const createSession = async (db, userId) => {
  const sessionId = nanoid();
  const token = nanoid();
  try {
    await db.collection("sessions").insertOne({ userId, sessionId, token });
  } catch (error) {
    console.error("Error creating session:", error);
    throw new Error("Failed to create session");
  }
  return { sessionId, token };
};

const deleteSession = async (db, sessionId) => {
  try {
    const result = await db.collection("sessions").deleteOne({ sessionId });

    if (result.deletedCount === 0) {
      console.warn(`Warning: Session with ID ${sessionId} not found.`);
    } else {
      console.log(`Session ${sessionId} deleted successfully.`);
    }
  } catch (error) {
    console.error("Error deleting session:", error);
  }
};

app.use(async (req, res, next) => {
  try {
    const client = await clientPromise;
    req.db = client.db("users");
    next();
  } catch (err) {
    console.error("Database connection error:", err);
    next(err);
  }
});

app.get("/", auth(), async (req, res) => {
  const session = await req.db.collection("sessions").findOne({ token: req.cookies.sessionToken });
  res.render("index", {
    user: req.user,
    userToken: session ? session.token : null,
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

app.post("/login", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await findUserByUserName(req.db, username);
    if (!user || user.password !== hash(password)) {
      return res.redirect("/?authError=true");
    }
    const session = await createSession(req.db, user._id);
    res.cookie("sessionToken", session.token, { httpOnly: true });
    res.cookie("sessionId", session.sessionId, { httpOnly: true }).redirect("/");
  } catch (error) {
    console.error("Login error:", error);
    res.redirect("/?authError=Server error");
  }
});

app.post("/signup", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.redirect("/?authError=Please enter both username and password");
    }
    const existingUser = await findUserByUserName(req.db, username);
    if (existingUser) {
      return res.redirect("/?authError=User already exists");
    }
    const newUser = {
      _id: new ObjectId(),
      username,
      password: hash(password),
    };

    await req.db.collection("users").insertOne(newUser);
    const session = await createSession(req.db, newUser._id);
    res.cookie("sessionToken", session.token, { httpOnly: true });
    res.cookie("sessionId", session.sessionId, { httpOnly: true }).redirect("/");
  } catch (error) {
    console.error("Signup error:", error);
    res.redirect("/?authError=Server error");
  }
});

app.get("/logout", auth(), async (req, res) => {
  try {
    if (!req.user) {
      return res.redirect("/");
    }
    await deleteSession(req.db, req.sessionId);
    res.clearCookie("sessionId").redirect("/");
  } catch (error) {
    console.error("Logout error:", error);
    res.redirect("/?authError=Logout failed");
  }
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`  Listening on http://localhost:${port}`);
});
